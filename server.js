const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- In-memory device registry ----
// deviceId -> { ws, deviceName, platform, role: 'agent'|'controller', ownerId, status, lastSeen, installationId }
const devices = new Map();

// installationId -> deviceId, so a reconnecting agent reuses its existing
// deviceId (and therefore its pairing/ownerId) instead of registering as a
// brand-new device every time the app restarts.
const installationToDeviceId = new Map();

// pairingCode -> { deviceId, expiresAt }
const pairingCodes = new Map();

function generatePairingCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function broadcastToOwner(ownerId, message, excludeDeviceId = null) {
  for (const [deviceId, dev] of devices.entries()) {
    if (dev.ownerId === ownerId && deviceId !== excludeDeviceId && dev.ws.readyState === 1) {
      dev.ws.send(JSON.stringify(message));
    }
  }
}

function deviceListForOwner(ownerId) {
  const list = [];
  for (const [deviceId, dev] of devices.entries()) {
    if (dev.ownerId === ownerId) {
      list.push({
        deviceId,
        deviceName: dev.deviceName,
        platform: dev.platform,
        role: dev.role,
        status: dev.status,
        lastSeen: dev.lastSeen,
      });
    }
  }
  return list;
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
        let deviceId = installationId ? installationToDeviceId.get(installationId) : null;
        const existing = deviceId ? devices.get(deviceId) : null;

        if (existing) {
          // Same physical device reconnecting: reuse its deviceId and ws,
          // and keep its ownerId if it was already paired. This is the fix
          // for the duplicate-agent problem.
          existing.ws = ws;
          existing.deviceName = msg.deviceName || existing.deviceName;
          existing.platform = msg.platform || existing.platform;
          existing.status = existing.ownerId ? 'online' : 'unpaired';
          existing.lastSeen = Date.now();
          currentDeviceId = deviceId;

          if (existing.ownerId) {
            ws.send(JSON.stringify({ type: 'registered', deviceId, ownerId: existing.ownerId }));
            ws.send(JSON.stringify({ type: 'paired', ownerId: existing.ownerId }));
            broadcastToOwner(existing.ownerId, {
              type: 'device_status', deviceId, status: 'online',
            }, deviceId);
          } else {
            const code = generatePairingCode();
            pairingCodes.set(code, { deviceId, expiresAt: Date.now() + 5 * 60 * 1000 });
            ws.send(JSON.stringify({ type: 'registered', deviceId, pairingCode: code }));
          }
          break;
        }

        // New device we haven't seen before.
        deviceId = crypto.randomUUID();
        currentDeviceId = deviceId;
        if (installationId) installationToDeviceId.set(installationId, deviceId);

        devices.set(deviceId, {
          ws,
          deviceName: msg.deviceName || 'Unknown Device',
          platform: msg.platform || 'android',
          role: 'agent',
          ownerId: null, // set once paired
          status: 'unpaired',
          lastSeen: Date.now(),
          installationId,
        });
        const code = generatePairingCode();
        pairingCodes.set(code, { deviceId, expiresAt: Date.now() + 5 * 60 * 1000 });
        ws.send(JSON.stringify({ type: 'registered', deviceId, pairingCode: code }));
        break;
      }

      // Controller registers with an ownerId (account/user id) directly
      case 'register_controller': {
        const deviceId = crypto.randomUUID();
        currentDeviceId = deviceId;
        devices.set(deviceId, {
          ws,
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
        const entry = pairingCodes.get(msg.pairingCode);
        if (!entry || entry.expiresAt < Date.now()) {
          ws.send(JSON.stringify({ type: 'pair_failed', reason: 'invalid_or_expired_code' }));
          break;
        }
        const agentDevice = devices.get(entry.deviceId);
        if (!agentDevice) {
          ws.send(JSON.stringify({ type: 'pair_failed', reason: 'agent_not_found' }));
          break;
        }
        const controllerDevice = devices.get(currentDeviceId);
        agentDevice.ownerId = controllerDevice.ownerId;
        agentDevice.status = 'online';
        pairingCodes.delete(msg.pairingCode);

        agentDevice.ws.send(JSON.stringify({ type: 'paired', ownerId: controllerDevice.ownerId }));
        ws.send(JSON.stringify({
          type: 'pair_success',
          deviceId: entry.deviceId,
          devices: deviceListForOwner(controllerDevice.ownerId),
        }));
        break;
      }

      // ---- Presence ----
      case 'heartbeat': {
        const dev = devices.get(currentDeviceId);
        if (dev) {
          dev.lastSeen = Date.now();
          dev.status = msg.status || dev.status;
          if (dev.ownerId) {
            broadcastToOwner(dev.ownerId, {
              type: 'device_status',
              deviceId: currentDeviceId,
              status: dev.status,
            }, currentDeviceId);
          }
        }
        break;
      }

      case 'list_devices': {
        const dev = devices.get(currentDeviceId);
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
        const target = devices.get(msg.targetDeviceId);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ ...msg, fromDeviceId: currentDeviceId }));
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
    const dev = devices.get(currentDeviceId);
    if (dev) {
      dev.status = 'offline';
      dev.lastSeen = Date.now();
      if (dev.ownerId) {
        broadcastToOwner(dev.ownerId, {
          type: 'device_status',
          deviceId: currentDeviceId,
          status: 'offline',
        }, currentDeviceId);
      }
      // Keep agent entries around (so they show as "offline" in device list),
      // but drop controller connections entirely.
      if (dev.role === 'controller') {
        devices.delete(currentDeviceId);
      }
    }
  });
});

// Simple REST health check + device list (useful for debugging on Render)
app.get('/health', (req, res) => res.json({ ok: true, devices: devices.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
