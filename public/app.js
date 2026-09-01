// ---------- State ----------
let ws = null;
let ownerId = null;
let myDeviceId = null;
let devices = [];
let activeDeviceId = null;
let pc = null;          // RTCPeerConnection to the currently viewed agent
let dataChannel = null;
let reconnectAttempt = 0;

const els = {
  gate: document.getElementById('gate'),
  ownerInput: document.getElementById('ownerInput'),
  gateEnter: document.getElementById('gateEnter'),
  console: document.getElementById('console'),
  ownerBadge: document.getElementById('ownerBadge'),
  connState: document.getElementById('connState'),
  deviceList: document.getElementById('deviceList'),
  pairBtn: document.getElementById('pairBtn'),
  pairModal: document.getElementById('pairModal'),
  pairCodeInput: document.getElementById('pairCodeInput'),
  pairError: document.getElementById('pairError'),
  pairSubmit: document.getElementById('pairSubmit'),
  pairCancel: document.getElementById('pairCancel'),
  viewerEmpty: document.getElementById('viewerEmpty'),
  viewerActive: document.getElementById('viewerActive'),
  viewerDeviceName: document.getElementById('viewerDeviceName'),
  viewerStatus: document.getElementById('viewerStatus'),
  remoteVideo: document.getElementById('remoteVideo'),
  videoOverlay: document.getElementById('videoOverlay'),
  disconnectBtn: document.getElementById('disconnectBtn'),
};

// ---------- Owner gate ----------
const savedOwner = localStorage.getItem('syncme_owner_id');
if (savedOwner) {
  els.ownerInput.value = savedOwner;
  // ✅ FIX: Auto-connect if owner was already saved — previously the page would
  // show the gate every time and the device list would never load until the
  // user manually clicked "প্যানেলে যাও" again.
  enterConsole();
}

els.gateEnter.addEventListener('click', enterConsole);
els.ownerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enterConsole(); });

function enterConsole() {
  const val = els.ownerInput.value.trim();
  if (!val) return;
  ownerId = val;
  localStorage.setItem('syncme_owner_id', val);
  els.gate.classList.add('hidden');
  els.console.classList.remove('hidden');
  els.ownerBadge.textContent = ownerId;
  connect();
}

// ---------- WebSocket signaling ----------
function connect() {
  setConnState('connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    send({
      type: 'register_controller',
      ownerId,
      deviceName: 'Control Panel (Web)',
      platform: 'web',
    });
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    setConnState('offline');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    setConnState('offline');
  });
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(2 * reconnectAttempt, 30) * 1000;
  setTimeout(connect, delay);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setConnState(state) {
  els.connState.className = 'conn-dot conn-' + state;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'registered':
      myDeviceId = msg.deviceId;
      setConnState('online');
      devices = msg.devices || [];
      renderDeviceList();
      break;

    case 'pair_success':
      myDeviceId = msg.deviceId || myDeviceId;
      devices = msg.devices || devices;
      renderDeviceList();
      closePairModal();
      break;

    case 'pair_failed':
      showPairError(msg.reason === 'invalid_or_expired_code'
        ? 'কোড সঠিক নয় বা মেয়াদ শেষ হয়ে গেছে।'
        : 'পেয়ারিং ব্যর্থ হয়েছে।');
      break;

    case 'device_list':
      devices = msg.devices || [];
      renderDeviceList();
      break;

    case 'device_status':
      updateDeviceStatus(msg.deviceId, msg.status);
      break;

    case 'webrtc_answer':
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      break;

    case 'webrtc_ice_candidate':
      if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      }
      break;

    case 'error':
      console.warn('Server error:', msg);
      break;
  }
}

// ---------- Device list rendering ----------
function renderDeviceList() {
  const agents = devices.filter(d => d.role === 'agent');

  if (agents.length === 0) {
    els.deviceList.innerHTML = '<li class="device-empty">কোনো ডিভাইস নেই এখনো</li>';
    return;
  }

  els.deviceList.innerHTML = '';
  agents.forEach(dev => {
    const li = document.createElement('li');
    li.className = 'device-item' + (dev.deviceId === activeDeviceId ? ' active' : '');
    li.dataset.deviceId = dev.deviceId;

    const dotClass = dev.status === 'online' ? 'online' : (dev.status === 'unpaired' ? 'unpaired' : 'offline');
    const statusLabel = dev.status === 'online' ? 'অনলাইন' : (dev.status === 'unpaired' ? 'পেয়ার হয়নি' : 'অফলাইন');

    li.innerHTML = `
      <span class="device-dot ${dotClass}"></span>
      <div class="device-meta">
        <div class="device-name">${escapeHtml(dev.deviceName || 'Unknown Device')}</div>
        <div class="device-sub">${statusLabel}</div>
      </div>
    `;
    li.addEventListener('click', () => selectDevice(dev));
    els.deviceList.appendChild(li);
  });
}

function updateDeviceStatus(deviceId, status) {
  const dev = devices.find(d => d.deviceId === deviceId);
  if (dev) dev.status = status;
  renderDeviceList();
  if (deviceId === activeDeviceId) {
    els.viewerStatus.textContent = status === 'online' ? 'সংযুক্ত' : 'সংযোগ বিচ্ছিন্ন';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Pairing modal ----------
els.pairBtn.addEventListener('click', () => {
  els.pairModal.classList.remove('hidden');
  els.pairCodeInput.value = '';
  els.pairError.classList.add('hidden');
  els.pairCodeInput.focus();
});
els.pairCancel.addEventListener('click', closePairModal);
els.pairSubmit.addEventListener('click', submitPairCode);
els.pairCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPairCode(); });

function closePairModal() {
  els.pairModal.classList.add('hidden');
}

function submitPairCode() {
  const code = els.pairCodeInput.value.trim();
  if (code.length !== 6) {
    showPairError('৬-ডিজিটের কোড দাও।');
    return;
  }
  send({ type: 'pair_with_code', pairingCode: code });
}

function showPairError(text) {
  els.pairError.textContent = text;
  els.pairError.classList.remove('hidden');
}

// ---------- Device selection + WebRTC viewer ----------
function selectDevice(dev) {
  if (dev.deviceId === activeDeviceId) return;
  teardownPeerConnection();
  activeDeviceId = dev.deviceId;
  renderDeviceList();

  els.viewerEmpty.classList.add('hidden');
  els.viewerActive.classList.remove('hidden');
  els.viewerDeviceName.textContent = dev.deviceName || 'Unknown Device';
  els.viewerStatus.textContent = 'সংযোগ হচ্ছে...';

  startViewing(dev.deviceId);
}

async function startViewing(targetDeviceId) {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({
        type: 'webrtc_ice_candidate',
        targetDeviceId,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    }
  };

  pc.ontrack = (event) => {
    els.remoteVideo.srcObject = event.streams[0];
    els.viewerStatus.textContent = 'সংযুক্ত';
  };

  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
      els.viewerStatus.textContent = 'সংযোগ বিচ্ছিন্ন';
    }
  };

  // Controller creates the data channel; agent listens for it (see webrtc_agent_service.dart).
  dataChannel = pc.createDataChannel('remote_input');
  dataChannel.onopen = () => console.log('data channel open');

  const offer = await pc.createOffer({ offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);

  send({
    type: 'webrtc_offer',
    targetDeviceId,
    sdp: { sdp: offer.sdp, type: offer.type },
  });
}

function teardownPeerConnection() {
  if (dataChannel) { dataChannel.close(); dataChannel = null; }
  if (pc) { pc.close(); pc = null; }
  els.remoteVideo.srcObject = null;
}

els.disconnectBtn.addEventListener('click', () => {
  teardownPeerConnection();
  activeDeviceId = null;
  els.viewerActive.classList.add('hidden');
  els.viewerEmpty.classList.remove('hidden');
  renderDeviceList();
});

// ---------- Remote input: click on video -> tap event over data channel ----------
els.remoteVideo.addEventListener('click', (e) => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;

  const rect = els.remoteVideo.getBoundingClientRect();
  // Map click position to normalized 0..1 coords; the agent side should
  // scale these against its actual screen resolution.
  const xNorm = (e.clientX - rect.left) / rect.width;
  const yNorm = (e.clientY - rect.top) / rect.height;

  dataChannel.send(JSON.stringify({
    kind: 'tap',
    x: xNorm,
    y: yNorm,
  }));

  showTapRipple(e.clientX - rect.left, e.clientY - rect.top);
});

function showTapRipple(x, y) {
  const ripple = document.createElement('div');
  ripple.className = 'tap-ripple';
  ripple.style.left = x + 'px';
  ripple.style.top = y + 'px';
  els.videoOverlay.appendChild(ripple);
  setTimeout(() => ripple.remove(), 500);
}
