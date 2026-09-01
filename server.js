const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Persistence (SQLite). Survives server restarts/redeploys, unlike the old
// in-memory-only Maps. DB_PATH can point at a Render persistent disk mount
// (e.g. /data/syncme.db) via env var; defaults to a local file otherwise.
// ---------------------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'syncme.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    deviceId       TEXT PRIMARY KEY,
    installationId TEXT UNIQUE,
    deviceName     TEXT,
    platform       TEXT,
    role           TEXT NOT NULL,
    ownerId        TEXT,
    status         TEXT,
    lastSeen       INTEGER
  );
  CREATE TABLE IF NOT EXISTS pairing_codes (
    code      TEXT PRIMARY KEY,
    deviceId  TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
`);

const stmts = {
  upsertDevice: db.prepare(`
    INSERT INTO devices (deviceId, installationId, deviceName, platform, role, ownerId, status, lastSeen)
    VALUES (@deviceId, @installationId, @deviceName, @platform, @role, @ownerId, @status, @lastSeen)
    ON CONFLICT(deviceId) DO UPDATE SET
      installationId = excluded.installationId,
      deviceName = excluded.deviceName,
      platform = excluded.platform,
      role = excluded.role,
      ownerId = excluded.ownerId,
      status = excluded.status,
      lastSeen = excluded.lastSeen
  `),
  deleteDevice: db.prepare(`DELETE FROM devices WHERE deviceId = ?`),
  getDeviceByInstallationId: db.prepare(`SELECT * FROM devices WHERE installationId = ?`),
  getDevicesByOwner: db.prepare(`SELECT * FROM devices WHERE ownerId = ?`),
  insertCode: db.prepare(`INSERT INTO pairing_codes (code, deviceId, expiresAt) VALUES (?, ?, ?)`),
  getCode: db.prepare(`SELECT * FROM pairing_codes WHERE code = ?`),
  deleteCode: db.prepare(`DELETE FROM pairing_codes WHERE code = ?`),
  purgeExpiredCodes: db.prepare(`DELETE FROM pairing_codes WHERE expiresAt < ?`),
};

// Periodically clean up expired pairing codes so the table doesn't grow forever.
setInterval(() => stmts.purgeExpiredCodes.run(Date.now()), 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Runtime state: live WebSocket connections, keyed by deviceId. This part
// genuinely can't be persisted across a restart (a socket dies with the
// process) -- but everything needed to RECREATE the right device/ownerId
// state on reconnect now lives in SQLite instead of memory.
// ---------------------------------------------------------------------------
const liveSockets = new Map(); // deviceId -> ws

function generatePairingCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function broadcastToOwner(ownerId, message, excludeDeviceId = null) {
  const owned = stmts.getDevicesByOwner.all(ownerId);
  for (const dev of owned) {
    if (dev.deviceId === excludeDeviceId) continue;
    const ws = liveSockets.get(dev.deviceId);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }
}

function deviceListForOwner(ownerId) {
  return stmts.getDevicesByOwner.all(ownerId).map((dev) => ({
    deviceId: dev.deviceId,
    deviceName: dev.deviceName,
    platform: dev.platform,
    role: dev.role,
    // A device row can outlive its socket (process restarted, hasn't
    // reconnected yet) -- report it as offline unless a live socket exists.
    status: liveSockets.has(dev.deviceId) ? dev.status : 'offline',
    lastSeen: dev.lastSeen,
  }));
}

wss.on('connection', (ws) => {
  let currentDeviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return ws.send(JSON.stringify({ type: 'error', message: 'invalid_json' }));
    }

    switch (msg.type) {
      // ---- Registration ----
      // Agent registers itself, gets a pairing code to show the user
      case 'register_agent': {
        const installationId = msg.installationId || null;
        const existing = installationId ? stmts.getDeviceByInstallationId.get(installationId) : null;

        if (existing) {
          // Same physical device reconnecting (row survived in SQLite even
          // if the process restarted): reuse its deviceId and restore
          // whatever ownerId it already had.
          currentDeviceId = existing.deviceId;
          liveSockets.set(existing.deviceId, ws);

          const status = existing.ownerId ? 'online' : 'unpaired';
          stmts.upsertDevice.run({
            deviceId: existing.deviceId,
            installationId,
            deviceName: msg.deviceName || existing.deviceName,
            platform: msg.platform || existing.platform,
            role: 'agent',
            ownerId: existing.ownerId,
            status,
            lastSeen: Date.now(),
          });

          if (existing.ownerId) {
            ws.send(JSON.stringify({ type: 'registered', deviceId: existing.deviceId, ownerId: existing.ownerId }));
            ws.send(JSON.stringify({ type: 'paired', ownerId: existing.ownerId }));
            broadcastToOwner(existing.ownerId, {
              type: 'device_list', devices: deviceListForOwner(existing.ownerId),
            }, existing.deviceId);
          } else {
            const code = generatePairingCode();
            stmts.insertCode.run(code, existing.deviceId, Date.now() + 5 * 60 * 1000);
            ws.send(JSON.stringify({ type: 'registered', deviceId: existing.deviceId, pairingCode: code }));
          }
          break;
        }

        // New device (or a fresh installationId we've truly never seen).
        const deviceId = crypto.randomUUID();
        currentDeviceId = deviceId;
        liveSockets.set(deviceId, ws);

        // If the agent remembers it was previously paired (saved locally via
        // DeviceIdentity.saveOwnerId) -- e.g. its installationId row got
        // lost some other way -- restore that pairing immediately instead
        // of forcing a re-pair.
        const restoredOwnerId = msg.previousOwnerId || null;

        stmts.upsertDevice.run({
          deviceId,
          installationId,
          deviceName: msg.deviceName || 'Unknown Device',
          platform: msg.platform || 'android',
          role: 'agent',
          ownerId: restoredOwnerId,
          status: restoredOwnerId ? 'online' : 'unpaired',
          lastSeen: Date.now(),
        });

        if (restoredOwnerId) {
          ws.send(JSON.stringify({ type: 'registered', deviceId, ownerId: restoredOwnerId }));
          ws.send(JSON.stringify({ type: 'paired', ownerId: restoredOwnerId }));
          broadcastToOwner(restoredOwnerId, {
            type: 'device_list', devices: deviceListForOwner(restoredOwnerId),
          }, deviceId);
        } else {
          const code = generatePairingCode();
          stmts.insertCode.run(code, deviceId, Date.now() + 5 * 60 * 1000);
          ws.send(JSON.stringify({ type: 'registered', deviceId, pairingCode: code }));
        }
        break;
      }

      // Controller registers with an ownerId (account/user id) directly
      case 'register_controller': {
        const deviceId = crypto.randomUUID();
        currentDeviceId = deviceId;
        liveSockets.set(deviceId, ws);

        stmts.upsertDevice.run({
          deviceId,
          installationId: null,
          deviceName: msg.deviceName || 'Controller',
          platform: msg.platform || 'flutter',
          role: 'controller',
          ownerId: msg.ownerId,
          status: 'online',
          lastSeen: Date.now(),
        });

        ws.send(JSON.stringify({
          type: 'registered',
          deviceId,
          devices: deviceListForOwner(msg.ownerId),
        }));
        break;
      }

      // Controller submits a pairing code to claim an agent device
      case 'pair_with_code': {
        const entry = stmts.getCode.get(msg.pairingCode);
        if (!entry || entry.expiresAt < Date.now()) {
          ws.send(JSON.stringify({ type: 'pair_failed', reason: 'invalid_or_expired_code' }));
          break;
        }
        const agentDevice = stmts.getDeviceByInstallationId.get; // (unused placeholder removed below)
        const agentRow = db.prepare('SELECT * FROM devices WHERE deviceId = ?').get(entry.deviceId);
        if (!agentRow) {
          ws.send(JSON.stringify({ type: 'pair_failed', reason: 'agent_not_found' }));
          break;
        }
        const controllerRow = db.prepare('SELECT * FROM devices WHERE deviceId = ?').get(currentDeviceId);

        stmts.upsertDevice.run({
          ...agentRow,
          ownerId: controllerRow.ownerId,
          status: 'online',
          lastSeen: Date.now(),
        });
        stmts.deleteCode.run(msg.pairingCode);

        const agentWs = liveSockets.get(entry.deviceId);
        if (agentWs && agentWs.readyState === 1) {
          agentWs.send(JSON.stringify({ type: 'paired', ownerId: controllerRow.ownerId }));
        }
        ws.send(JSON.stringify({
          type: 'pair_success',
          deviceId: entry.deviceId,
          devices: deviceListForOwner(controllerRow.ownerId),
        }));
        break;
      }

      // ---- Presence ----
      case 'heartbeat': {
        const dev = db.prepare('SELECT * FROM devices WHERE deviceId = ?').get(currentDeviceId);
        if (dev) {
          const newStatus = msg.status || dev.status;
          stmts.upsertDevice.run({ ...dev, status: newStatus, lastSeen: Date.now() });
          if (dev.ownerId) {
            broadcastToOwner(dev.ownerId, {
              type: 'device_status',
              deviceId: currentDeviceId,
              status: newStatus,
            }, currentDeviceId);
          }
        }
        break;
      }

      case 'list_devices': {
        const dev = db.prepare('SELECT * FROM devices WHERE deviceId = ?').get(currentDeviceId);
        if (dev && dev.ownerId) {
          ws.send(JSON.stringify({ type: 'device_list', devices: deviceListForOwner(dev.ownerId) }));
        }
        break;
      }

      // ---- WebRTC signaling relay (offer/answer/ice) ----
      // targetDeviceId + payload gets relayed verbatim to the target device
      case 'webrtc_offer':
      case 'webrtc_answer':
      case 'webrtc_ice_candidate':
      case 'remote_input':      // mouse/keyboard/touch events, relayed over signaling as fallback
      case 'file_sync_chunk':   // fallback path if not using WebRTC data channel
      case 'file_sync_meta': {
        const targetWs = liveSockets.get(msg.targetDeviceId);
        if (targetWs && targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({ ...msg, fromDeviceId: currentDeviceId }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'target_offline', targetDeviceId: msg.targetDeviceId }));
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: 'unknown_type' }));
    }
  });

  ws.on('close', () => {
    if (!currentDeviceId) return;
    liveSockets.delete(currentDeviceId);

    const dev = db.prepare('SELECT * FROM devices WHERE deviceId = ?').get(currentDeviceId);
    if (dev) {
      if (dev.role === 'controller') {
        // Controllers are ephemeral: drop the row entirely.
        stmts.deleteDevice.run(currentDeviceId);
      } else {
        // Keep agent rows around (so they show as "offline" in device list,
        // and so pairing survives) but mark them offline.
        stmts.upsertDevice.run({ ...dev, status: 'offline', lastSeen: Date.now() });
      }
      if (dev.ownerId) {
        broadcastToOwner(dev.ownerId, {
          type: 'device_status',
          deviceId: currentDeviceId,
          status: 'offline',
        }, currentDeviceId);
      }
    }
  });
});

// Simple REST health check + device count (useful for debugging on Render)
app.get('/health', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  res.json({ ok: true, devices: count, liveSockets: liveSockets.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT} (db: ${DB_PATH})`));
