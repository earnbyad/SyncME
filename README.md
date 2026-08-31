# SyncME Clone — Signaling Server (Phase 1)

WebSocket-based signaling server for a multi-device remote-control system
(Flutter agent on Android + Flutter controller app, WebRTC for screen share /
remote control).

## Run locally
```bash
npm install
npm start
```
Server listens on `PORT` (default 3000), WebSocket endpoint at `/ws`.

## Deploy (same pattern as your Render Express backend)
- Push this folder to a repo (or a subfolder of your existing repo)
- Render: New Web Service → Node → Build: `npm install` → Start: `npm start`
- Note the deployed URL, e.g. `wss://syncme-clone-xxxx.onrender.com/ws`

## Protocol overview

### 1. Agent registration + pairing code
```
Agent -> Server:  { "type": "register_agent", "deviceName": "Pixel 7", "platform": "android" }
Server -> Agent:  { "type": "registered", "deviceId": "...", "pairingCode": "482913" }
```
Agent shows `pairingCode` on screen. Code expires in 5 minutes.

### 2. Controller registration
```
Controller -> Server: { "type": "register_controller", "ownerId": "user_123", "deviceName": "My Phone" }
Server -> Controller: { "type": "registered", "deviceId": "...", "devices": [...] }
```
`ownerId` should come from your existing auth (Firebase Auth uid, matching
your other projects).

### 3. Pairing
```
Controller -> Server: { "type": "pair_with_code", "pairingCode": "482913" }
Server -> Controller: { "type": "pair_success", "deviceId": "...", "devices": [...] }
Server -> Agent:      { "type": "paired", "ownerId": "user_123" }
```

### 4. Device list + presence
```
-> { "type": "list_devices" }
<- { "type": "device_list", "devices": [ { deviceId, deviceName, platform, role, status, lastSeen } ] }

-> { "type": "heartbeat", "status": "online" }   // send every ~15s
<- (broadcast to owner's other devices) { "type": "device_status", "deviceId": "...", "status": "online" }
```

### 5. WebRTC signaling relay
These are relayed verbatim to `targetDeviceId`, with `fromDeviceId` added:
```
{ "type": "webrtc_offer", "targetDeviceId": "...", "sdp": {...} }
{ "type": "webrtc_answer", "targetDeviceId": "...", "sdp": {...} }
{ "type": "webrtc_ice_candidate", "targetDeviceId": "...", "candidate": {...} }
```

### 6. Remote control + file sync (fallback / signaling-relay path)
Once the WebRTC data channel is up, prefer sending these directly over it
(lower latency). The server also relays them as a fallback:
```
{ "type": "remote_input", "targetDeviceId": "...", "event": { "kind": "tap", "x": 120, "y": 480 } }
{ "type": "file_sync_meta", "targetDeviceId": "...", "fileName": "...", "size": 1234 }
{ "type": "file_sync_chunk", "targetDeviceId": "...", "chunkIndex": 0, "data": "<base64>" }
```

## Design notes / things this fixes vs. your current SyncME issue

- **Single source of truth for device identity**: each WebSocket connection
  gets exactly one `deviceId` on `register_agent`. If your current duplicate-agent
  bug is from two agent processes both registering, this server will show
  *two separate deviceIds* for the same physical device in `device_list` —
  that's your smoking gun. Add a `installationId` (persisted on device, e.g.
  via `shared_preferences`) to `register_agent` and re-use the same
  `deviceId` on reconnect instead of minting a new one, to collapse duplicates.
- **ownerId-scoped broadcast**: devices only see/hear about other devices
  under the same `ownerId`, so this is multi-tenant safe from the start.
- **In-memory only**: for production, back `devices`/`pairingCodes` with
  Firestore or Redis so state survives server restarts — straightforward
  swap since you're already using Firestore in your other projects.

## Next phases
- Phase 2: Flutter **agent** app (screen capture via `flutter_webrtc` +
  `MediaProjection` on Android, remote input execution, signaling client)
- Phase 3: Flutter **controller** app (device list UI, video renderer,
  touch-to-remote-input mapping, file browser)
