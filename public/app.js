// ── State ──────────────────────────────────────────────────────────────────
let ws = null, ownerId = null, myDeviceId = null;
let devices = [], activeDeviceId = null;
let pc = null, dataChannel = null, reconnectAttempt = 0;
let startTime = Date.now();

// ── Gate ───────────────────────────────────────────────────────────────────
const savedOwner = localStorage.getItem('syncme_owner');
if (savedOwner) document.getElementById('ownerInput').value = savedOwner;

document.getElementById('gateEnter').addEventListener('click', enterConsole);
document.getElementById('ownerInput').addEventListener('keydown', e => { if (e.key === 'Enter') enterConsole(); });

function enterConsole() {
  const val = document.getElementById('ownerInput').value.trim();
  if (!val) return;
  ownerId = val;
  localStorage.setItem('syncme_owner', val);
  document.getElementById('gate').style.display = 'none';
  runLoader(() => {
    document.getElementById('console').style.display = 'block';
    document.getElementById('ownerTag').textContent = ownerId;
    connect();
    startUptimeTick();
  });
}

// ── Loader ─────────────────────────────────────────────────────────────────
function runLoader(cb) {
  const lw = document.getElementById('loader-wrapper');
  const pct = document.getElementById('loader-percent');
  const bar = document.getElementById('loader-bar');
  const con = document.getElementById('loader-console');
  lw.style.display = 'flex';
  const msgs = ['INITIALIZING KERNEL...','LOADING DRIVERS...','MOUNTING VIRTUAL FS...','STARTING SYNCME CORE...','ACCESS GRANTED.'];
  let w = 0;
  const t = setInterval(() => {
    w += Math.floor(Math.random() * 18) + 6;
    if (w > 100) w = 100;
    pct.textContent = w + '%';
    bar.style.width = w + '%';
    const step = Math.min(Math.floor((w / 100) * msgs.length), msgs.length - 1);
    con.innerHTML = '<div>> ' + msgs[step] + '</div>' + con.innerHTML;
    if (w >= 100) {
      clearInterval(t);
      setTimeout(() => { lw.classList.add('fade-out'); setTimeout(cb, 500); }, 300);
    }
  }, 110);
}

// ── Navigation ─────────────────────────────────────────────────────────────
document.querySelectorAll('.menu-item[data-page]').forEach(n => {
  n.addEventListener('click', () => {
    goto(n.dataset.page);
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-backdrop').classList.remove('show');
    }
  });
});

const hamburger = document.getElementById('hamburger');
const sidebar   = document.getElementById('sidebar');
const backdrop  = document.getElementById('sidebar-backdrop');
hamburger.addEventListener('click', () => { sidebar.classList.toggle('open'); backdrop.classList.toggle('show'); });
backdrop.addEventListener('click',  () => { sidebar.classList.remove('open'); backdrop.classList.remove('show'); });

function goto(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
  const pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  document.querySelectorAll(`.menu-item[data-page="${page}"]`).forEach(m => m.classList.add('active'));
  if (page === 'stream' || page === 'remotecontrol') populateDevSel(['stream-dev-sel','rc-dev-sel']);
  if (page === 'control') populateDevSel(['ctrl-dev-sel']);
}

// ── WebSocket ──────────────────────────────────────────────────────────────
function connect() {
  setConn(false);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    send({ type: 'register_controller', ownerId, deviceName: 'Control Panel (Web)', platform: 'web' });
  });
  ws.addEventListener('message', e => handleMsg(JSON.parse(e.data)));
  ws.addEventListener('close', () => { setConn(false); scheduleReconnect(); });
  ws.addEventListener('error', () => setConn(false));
}

function scheduleReconnect() {
  reconnectAttempt++;
  setTimeout(connect, Math.min(2 * reconnectAttempt, 30) * 1000);
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function setConn(ok) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-lbl');
  dot.classList.toggle('on', ok);
  lbl.textContent = ok ? 'Connected' : 'Disconnected';
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'registered':
      myDeviceId = msg.deviceId;
      setConn(true);
      devices = msg.devices || [];
      renderAll();
      break;
    case 'pair_success':
      devices = msg.devices || devices;
      renderAll();
      closePairModal();
      showPairSuccess('ডিভাইস সফলভাবে পেয়ার হয়েছে ✓');
      toast('✓ Device paired!');
      break;
    case 'pair_failed':
      showPairError(msg.reason === 'invalid_or_expired_code' ? 'কোড সঠিক নয় বা মেয়াদ শেষ।' : 'পেয়ারিং ব্যর্থ।');
      break;
    case 'device_list':
      devices = msg.devices || [];
      renderAll();
      break;
    case 'device_status':
      updateDevStatus(msg.deviceId, msg.status);
      break;
    case 'webrtc_answer':
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;
    case 'webrtc_ice_candidate':
      if (pc) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      break;
  }
}

// ── Device helpers ─────────────────────────────────────────────────────────
function agents() { return devices.filter(d => d.role === 'agent'); }

function renderAll() {
  renderDevices();
  renderStats();
  populateDevSel(['stream-dev-sel','rc-dev-sel','ctrl-dev-sel','shell-target']);
}

function renderStats() {
  const all = devices.filter(d => d.role === 'agent');
  const online  = all.filter(d => d.status === 'online').length;
  const paired  = all.filter(d => d.status !== 'unpaired').length;
  const offline = all.filter(d => d.status === 'offline').length;
  document.getElementById('sv-devices').textContent = all.length;
  document.getElementById('sv-online').textContent  = online;
  document.getElementById('sv-paired').textContent  = paired;
  document.getElementById('sv-offline').textContent = offline;
  document.getElementById('b-devices').textContent  = all.length;
}

function renderDevices() {
  const list = agents();
  const html = list.length
    ? list.map(devCard).join('')
    : '<div class="empty-msg">No devices yet. Pair a device first.</div>';
  document.getElementById('ov-devices').innerHTML  = html;
  document.getElementById('all-devices').innerHTML = html;

  // paired list on pair page
  const paired = list.filter(d => d.ownerId);
  document.getElementById('paired-list').innerHTML = paired.length
    ? paired.map(d => `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">
        <span class="pill ${d.status}">${d.status}</span>
        <span style="font-size:12px">${esc(d.deviceName)}</span>
        <span style="font-size:10px;color:var(--text2);margin-left:auto">${d.deviceId.slice(0,8)}…</span>
      </div>`).join('')
    : '<div class="empty-msg" style="padding:12px">No paired devices.</div>';
}

function devCard(d) {
  return `<div class="dev-card" data-id="${d.deviceId}" onclick="selectDevice('${d.deviceId}')">
    <div class="dev-icon">📱</div>
    <div class="dev-name">${esc(d.deviceName || 'Unknown')}</div>
    <div class="dev-sub">${esc(d.platform || 'android')}</div>
    <div class="dev-meta">
      <span style="font-size:9px;color:var(--text2)">${d.deviceId.slice(0,8)}…</span>
      <span class="pill ${d.status}">${d.status}</span>
    </div>
  </div>`;
}

function selectDevice(id) {
  document.querySelectorAll('.dev-card').forEach(c => c.classList.remove('sel'));
  document.querySelector(`.dev-card[data-id="${id}"]`)?.classList.add('sel');
}

function updateDevStatus(deviceId, status) {
  const dev = devices.find(d => d.deviceId === deviceId);
  if (dev) dev.status = status;
  renderAll();
  if (deviceId === activeDeviceId) {
    document.getElementById('st-status').textContent = status;
    document.getElementById('st-status').style.color = status === 'online' ? 'var(--green)' : 'var(--red)';
  }
}

function refreshDevices() { send({ type: 'list_devices' }); }

function populateDevSel(ids) {
  const list = agents();
  const opts = '<option value="">— Select Device —</option>' +
    list.map(d => `<option value="${d.deviceId}">${esc(d.deviceName)} (${d.status})</option>`).join('');
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = opts;
    if (cur) el.value = cur;
  });
}

// ── Pairing ────────────────────────────────────────────────────────────────
function submitPairCode() {
  const code = document.getElementById('pair-code-input').value.trim();
  document.getElementById('pair-error').style.display   = 'none';
  document.getElementById('pair-success').style.display = 'none';
  if (code.length !== 6) { showPairError('৬-ডিজিটের কোড দাও।'); return; }
  send({ type: 'pair_with_code', pairingCode: code });
}
function closePairModal() { document.getElementById('pair-code-input').value = ''; }
function showPairError(txt) {
  const el = document.getElementById('pair-error');
  el.textContent = txt; el.style.display = 'block';
}
function showPairSuccess(txt) {
  const el = document.getElementById('pair-success');
  el.textContent = txt; el.style.display = 'block';
}
document.getElementById('pair-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitPairCode(); });

// ── WebRTC Screen View ─────────────────────────────────────────────────────
function streamStart() {
  const sel = document.getElementById('stream-dev-sel');
  const targetId = sel.value;
  if (!targetId) { toast('⚠ Select a device first'); return; }
  teardownPC();
  activeDeviceId = targetId;

  const dev = devices.find(d => d.deviceId === targetId);
  document.getElementById('st-dev').textContent = dev?.deviceName || targetId;
  document.getElementById('st-status').textContent = 'Connecting…';
  document.getElementById('st-status').style.color = 'var(--yellow)';

  const vp = document.getElementById('stream-vp');
  vp.innerHTML = `<video id="remote-video" autoplay playsinline style="width:100%;height:100%;object-fit:contain;cursor:crosshair"></video>`;
  document.getElementById('remote-video').addEventListener('click', onVideoClick);

  document.getElementById('stream-start-btn').style.display = 'none';
  document.getElementById('stream-stop-btn').style.display  = '';
  document.getElementById('b-stream').style.display = '';

  startWebRTC(targetId);
  toast('▶ Connecting to ' + (dev?.deviceName || targetId));
}

async function startWebRTC(targetDeviceId) {
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  pc.onicecandidate = e => {
    if (e.candidate) send({
      type: 'webrtc_ice_candidate', targetDeviceId,
      candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }
    });
  };

  pc.ontrack = e => {
    const vid = document.getElementById('remote-video');
    if (vid) { vid.srcObject = e.streams[0]; }
    document.getElementById('st-status').textContent = 'Live';
    document.getElementById('st-status').style.color = 'var(--green)';
  };

  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
      document.getElementById('st-status').textContent = 'Disconnected';
      document.getElementById('st-status').style.color = 'var(--red)';
    }
  };

  dataChannel = pc.createDataChannel('remote_input');
  dataChannel.onopen = () => { appendRcLog('✓ Data channel open'); };

  const offer = await pc.createOffer({ offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  send({ type: 'webrtc_offer', targetDeviceId, sdp: { sdp: offer.sdp, type: offer.type } });
}

function streamStop() {
  teardownPC();
  activeDeviceId = null;
  document.getElementById('stream-vp').innerHTML = '<div style="text-align:center;color:var(--text2)"><div style="font-size:32px;margin-bottom:8px">📹</div><div style="font-size:12px;text-transform:uppercase;letter-spacing:1px">Stream stopped</div></div>';
  document.getElementById('stream-start-btn').style.display = '';
  document.getElementById('stream-stop-btn').style.display  = 'none';
  document.getElementById('b-stream').style.display = 'none';
  document.getElementById('st-status').textContent = 'Idle';
  document.getElementById('st-status').style.color = 'var(--text2)';
  toast('■ Disconnected');
}

function teardownPC() {
  dataChannel?.close(); dataChannel = null;
  pc?.close(); pc = null;
}

// ── Remote control via video click ────────────────────────────────────────
function onVideoClick(e) {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  const rect = e.target.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  dataChannel.send(JSON.stringify({ kind: 'tap', x, y }));

  const vp = document.getElementById('stream-vp');
  const vpRect = vp.getBoundingClientRect();
  const ripple = document.createElement('div');
  ripple.className = 'tap-ripple';
  ripple.style.left = (e.clientX - vpRect.left) + 'px';
  ripple.style.top  = (e.clientY - vpRect.top) + 'px';
  vp.appendChild(ripple);
  setTimeout(() => ripple.remove(), 500);

  appendRcLog(`👆 Tap (${x.toFixed(2)}, ${y.toFixed(2)})`);
}

// ── Remote control (dedicated page) ───────────────────────────────────────
function sendInput(kind, params) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    toast('⚠ No active screen session. Open Live Screen first.'); return;
  }
  const event = { kind, ...params };
  dataChannel.send(JSON.stringify(event));
  appendRcLog(`▸ ${kind}: ${JSON.stringify(params)}`);
}

function appendRcLog(msg) {
  const el = document.getElementById('rc-log');
  if (!el) return;
  el.innerHTML = `<div style="color:var(--a2);">> ${esc(msg)}</div>` + el.innerHTML.replace('<span style="color:var(--text2)">No events sent yet.</span>', '');
}

// ── Control panel relay ────────────────────────────────────────────────────
function relayCtrl(command, params = {}) {
  const did = document.getElementById('ctrl-dev-sel').value;
  if (!did) { toast('⚠ Select a device'); return; }
  send({ type: 'remote_input', targetDeviceId: did, event: { kind: command, ...params } });
  appendCtrlLog(`▸ ${command} → ${did.slice(0, 8)}…`);
}
function ctrlURL() { const u = prompt('URL to open on device:'); if (u) relayCtrl('open_url', { url: u }); }
function appendCtrlLog(msg) {
  const el = document.getElementById('ctrl-log');
  if (!el) return;
  el.innerHTML = `<div style="color:var(--a2);margin-bottom:2px">> ${esc(msg)}</div>` + el.innerHTML.replace('<span style="color:var(--text2)">No commands yet.</span>', '');
}

// ── Shell (relay) ──────────────────────────────────────────────────────────
function sendShell() {
  const did = document.getElementById('shell-target').value;
  const cmd = document.getElementById('cmd-inp').value.trim();
  if (!did) { toast('⚠ Select target'); return; }
  if (!cmd) return;
  send({ type: 'remote_input', targetDeviceId: did, event: { kind: 'shell', command: cmd } });
  const term = document.getElementById('terminal');
  term.innerHTML += `<div style="color:var(--a2);margin-bottom:4px">> [${devices.find(d=>d.deviceId===did)?.deviceName||did.slice(0,8)}] ${esc(cmd)}</div>`;
  term.scrollTop = term.scrollHeight;
  document.getElementById('cmd-inp').value = '';
}

// ── Clipboard ──────────────────────────────────────────────────────────────
function pushClip() {
  const content = document.getElementById('clip-content').value;
  devices.filter(d => d.status === 'online').forEach(d => {
    send({ type: 'remote_input', targetDeviceId: d.deviceId, event: { kind: 'clipboard', content } });
  });
  toast('⬆ Pushed to all online devices');
}
function copyClip() {
  navigator.clipboard?.writeText(document.getElementById('clip-content').value).then(() => toast('⊕ Copied'));
}

// ── Notifications ──────────────────────────────────────────────────────────
function clearNotifs() { document.getElementById('notif-list').innerHTML = '<div class="empty-msg" style="padding:22px">Cleared.</div>'; }

// ── Screenshots ────────────────────────────────────────────────────────────
function triggerSS() {
  const did = document.getElementById('ss-dev-sel').value;
  if (!did) { toast('⚠ Select device'); return; }
  send({ type: 'remote_input', targetDeviceId: did, event: { kind: 'screenshot' } });
  toast('📸 Screenshot requested…');
}

// ── SMS tab ────────────────────────────────────────────────────────────────
function smsTab(t) {
  document.getElementById('tab-inbox').classList.toggle('active', t === 'inbox');
  document.getElementById('tab-send').classList.toggle('active',  t === 'send');
  document.getElementById('sms-inbox-panel').style.display = t === 'inbox' ? '' : 'none';
  document.getElementById('sms-send-panel').style.display  = t === 'send'  ? '' : 'none';
}

// ── Uptime ticker ──────────────────────────────────────────────────────────
function startUptimeTick() {
  setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(s / 60), sec = s % 60;
    const h = Math.floor(m / 60), min = m % 60;
    const el = document.getElementById('srv-uptime');
    if (el) el.textContent = h ? `${h}h ${min}m` : `${min}m ${sec}s`;
  }, 1000);
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast-el');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Util ───────────────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML;
}
