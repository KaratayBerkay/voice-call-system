# Voice Call System

A 1-to-1 WebRTC voice calling system: a NestJS WebSocket signaling gateway,
a coturn TURN/STUN server, and a Flutter feature module. Audio is peer-to-peer
over WebRTC; NestJS only ever relays small JSON messages (call
invite/accept/reject/hangup, SDP offer/answer, ICE candidates) — never audio.
No SFU, no push notifications, no CallKit/ConnectionService, no background
calling: a call only works while both apps are open and connected to the
signaling server.

```
Flutter A  ──call:invite──▶  NestJS  ──call:invite──▶  Flutter B
Flutter A  ◀─call:accept──   (relay)  ◀──call:accept──  Flutter B
Flutter A  ──webrtc:offer──▶ NestJS  ──webrtc:offer──▶  Flutter B
Flutter A  ◀─webrtc:answer─  (relay)  ◀─webrtc:answer──  Flutter B
Flutter A  ⇄═══════════ WebRTC audio (P2P, via STUN/TURN) ═══════════⇄ Flutter B
```

A browser test client (`web-voice-call-client/`) speaks the exact same
signaling protocol and can call to/from the Flutter app, or to another
browser tab/device. It exists because a real browser's `getUserMedia`
captures real microphone audio unconditionally, which an Android emulator's
virtual mic cannot be relied on to do (see "Prefer the web client..." under
Testing procedure below) — it's the fastest way to prove the
signaling/ICE/TURN/audio pipeline actually carries real voice before
involving physical phones.

## Layout

```
voice-call-system/
  docker-compose.yml             Brings up turn + backend + web together
  nestjs-backend/                 Signaling gateway (this repo, runnable standalone)
    Dockerfile
    src/modules/calls/
      call.gateway.ts             WebSocket events, routes messages
      call.service.ts             Call state machine, socket <-> userId registry
      auth.service.ts             INTEGRATION POINT: plug in your real auth
      dto/                        class-validator payload shapes
      interfaces/call.interface.ts
  coturn/
    .env                          Real values (gitignored); .env -> here via root symlink
    .env.example                  Copy to .env; see local vs VPS guidance inside
  flutter-voice-call-feature/     Standalone Dart package -- copy lib/features/voice_call
    lib/features/voice_call/      into your app, or add this as a local path dependency
      models/voice_call.dart
      services/
        webrtc_voice_call_service.dart      Pure RTCPeerConnection mechanics
        voice_call_signaling_service.dart   Socket.IO client for the gateway
      domain/voice_call_controller.dart     Ties the two together + call state machine
      presentation/voice_call_screen.dart   Minimal test UI
  web-voice-call-client/          TanStack Start browser test client
    Dockerfile
    src/features/voiceCall/       Port of the Flutter feature above, browser-native
      voiceCallSignalingService.ts    socket.io-client wrapper (same events/payloads)
      webrtcVoiceCallService.ts       Native RTCPeerConnection + getUserMedia
      useVoiceCallController.ts       Same call state machine, as a React hook
      VoiceCallApp.tsx                Login screen + call screen UI
```

## Why NestJS uses Socket.IO

`@nestjs/websockets` + `@nestjs/platform-socket.io` (the standard NestJS
gateway stack) speaks the Socket.IO protocol, not raw WebSocket framing. The
Flutter side must use `socket_io_client` to match — a plain `WebSocket`/
`web_socket_channel` connection cannot talk to a NestJS `@WebSocketGateway()`.

## Setup

### 1. Signaling server + TURN/STUN (docker compose)

```bash
cp coturn/.env.example coturn/.env
# edit coturn/.env -- see the comments inside for local-dev vs VPS values
ln -s coturn/.env .env   # lets docker compose interpolate ${TURN_*} in the command
docker compose up -d --build
```

This builds the NestJS gateway into a container and starts it alongside
coturn, both on `network_mode: host` so they bind directly to the machine's
real network interface (needed for coturn's wide UDP relay port range, and
convenient for the gateway too — no per-port mapping to keep in sync).

`docker compose logs -f backend` / `docker compose logs -f turn` to watch
either service; `docker compose down` to stop both.

**Note:** the `${TURN_LISTENING_IP}`-style variables in `docker-compose.yml`
are resolved by Compose itself from a `.env` file *next to the compose file*
-- the `env_file: ./coturn/.env` line on the `turn` service only injects
those vars into the *container's* runtime environment, which happens too
late for the `command:` list. Hence the symlink above; don't skip it or
coturn silently starts with a blank `--relay-ip=`.

#### Alternative: run the signaling server without Docker

```bash
cd nestjs-backend
npm install
npm run build
PORT=3001 npm start
# or for development with auto-restart:
npm run start:dev
```

**Either way, read the comments in `coturn/.env.example` before starting.**
The short version:
`TURN_LISTENING_IP` and `TURN_RELAY_IP` must be a real, routable interface
address (your machine's LAN IP for local dev, or the VPS's interface for
production) — **not** `127.0.0.1` or `localhost`. A relay socket bound to
loopback can physically only reach itself, so calls that need the TURN
relay (which, on real phone networks, is most of them) will connect but
carry no audio if this is misconfigured. This isn't a hypothetical: it's the
exact bug hit and fixed while building this.

### 2. Web test client

Already running as the `web` service once step 1's `docker compose up -d
--build` has finished — no separate command needed. Open
`http://<this-host-LAN-IP>:3002` in a browser (any device on the same LAN,
including this machine itself). Sign in with any user id you like (it
doubles as the auth token, same placeholder behavior as
`auth.service.ts` — see "Auth integration point" below), then call another
user id that's also signed in, whether that's a second browser
tab/window/device or the Flutter app.

The `web` service's build bakes `VITE_SIGNALING_URL`/`VITE_TURN_URL`/
`VITE_TURN_USERNAME`/`VITE_TURN_PASSWORD` in from the same root `.env` used
by `coturn` (see `docker-compose.yml`'s `web.build.args`) — changing TURN
credentials or the host IP means re-running `docker compose up -d --build
web` to re-bake them, since Vite embeds `VITE_*` vars into the browser
bundle at build time, not read at container start.

**Microphone access needs a secure context.** Browsers only expose
`navigator.mediaDevices`/`getUserMedia` on `https://` origins or
`http://localhost` — a plain `http://<LAN-IP>:3002` (which is what every
*other* device on your network sees this as) doesn't qualify, and the app
will show "browser blocked mic access" instead of ever prompting for
permission. On every device that will actually place/receive a call (not
just view the page), either:
- Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enable
  it, add `http://<this-host-LAN-IP>:3002` to the list, and relaunch the
  browser (Chrome/Edge; Firefox has an equivalent via
  `about:config` → `network.proxy.allow_hijacking_localhost`-adjacent
  flags, but it's not worth the detour for a quick LAN test — use Chrome
  here), or
- Serve it over real HTTPS instead — set `PUBLIC_SIGNALING_URL` in the root
  `.env` to your `https://` origin (see `coturn/.env.example`) and point a
  reverse proxy at this host: `/` (or whatever path serves the `web`
  container) to port 3002, **and** `/socket.io` on that *same* domain to
  port 3001. Both have to be on the same origin — once the page loads over
  https, the browser blocks a plain `http://` signaling connection as mixed
  content, so signaling can't stay on the LAN-IP/http address even though
  network-wise it's reachable. `VITE_TURN_URL` doesn't need this — `turn:`
  URLs in ICE config aren't subject to mixed-content blocking. Re-run
  `docker compose up -d --build web` after setting `PUBLIC_SIGNALING_URL` —
  it's a Vite build arg, baked into the bundle at build time, not read at
  container start.
This only blocks the *microphone*, not the app itself — signing in,
inviting, and the call state machine all work fine over plain HTTP; only
`getUserMedia` cares.

#### Alternative: run the web client without Docker

```bash
cd web-voice-call-client
cp .env.example .env   # then edit the VITE_* values if not testing on localhost
npm install
npm run dev             # http://localhost:3002, hot-reloads on save
```

Much faster than a full `docker compose up --build` loop while iterating on
the client itself.

### 3. Flutter integration

Copy `flutter-voice-call-feature/lib/features/voice_call/` into your app's
`lib/features/` directory (or add `flutter-voice-call-feature` as a local
path dependency in your `pubspec.yaml`). Add its dependencies to your app's
`pubspec.yaml`:

```yaml
dependencies:
  flutter_webrtc: ^1.6.0
  socket_io_client: ^3.1.2
  permission_handler: ^12.0.1
```

Wire it up:

```dart
import 'features/voice_call/domain/voice_call_controller.dart';
import 'features/voice_call/presentation/voice_call_screen.dart';
import 'features/voice_call/services/voice_call_signaling_service.dart';

final iceServers = {
  'iceServers': [
    {'urls': 'stun:YOUR_TURN_HOST:3478'},
    {
      'urls': 'turn:YOUR_TURN_HOST:3478',
      'username': const String.fromEnvironment('TURN_USERNAME'),
      'credential': const String.fromEnvironment('TURN_PASSWORD'),
    },
  ],
};

final controller = VoiceCallController(
  signaling: VoiceCallSignalingService(
    baseUrl: 'http://YOUR_SIGNALING_HOST:3001',
    authToken: myApp.currentAuthToken, // whatever your existing auth already issues
  ),
  iceServers: iceServers,
);

// Anywhere in your widget tree:
VoiceCallScreen(controller: controller, currentUserId: myApp.currentUserId);
```

Pass TURN credentials via `--dart-define` (or your existing config/env
mechanism) rather than hardcoding them:

```bash
flutter run --dart-define=TURN_USERNAME=... --dart-define=TURN_PASSWORD=...
```

### Auth integration point

`nestjs-backend/src/modules/calls/auth.service.ts` has one method,
`verifyToken`, that as shipped just trusts the raw token as a user id (so the
module is runnable standalone). **Replace its body** with your app's real
token verification (JWT verify, session lookup, call into your existing auth
module, etc.) and return the authenticated user id. Everything downstream —
routing, the busy/self-call/not-participant checks — trusts only what this
method returns, never anything the client sends directly. This is also the
one place you'd wire in your existing NestJS app's `AuthModule`/guards if you
end up integrating this `CallsModule` into that app directly instead of
running it standalone.

### Android permissions

Already required in `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
```

No camera permission is needed. `permission_handler`'s `Permission.microphone.request()`
handles the runtime prompt; `MicPermissionDeniedException` surfaces a denial
as `VoiceCallError.microphonePermissionDenied`.

### iOS permissions

In `Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Needed to make voice calls</string>
```

No `NSCameraUsageDescription` is needed — this is audio-only.

## Call state machine

```
idle -> calling (caller) / ringing (callee) -> connecting -> connected -> idle
                                             \-> rejected/cancelled/failed/ended -> idle
```

Enforced server-side in `call.service.ts`:
- a user can't call themselves (`self_call`)
- a user with an active call (incoming or outgoing) can't start or receive
  another one (`busy`) — covers "A can't have multiple outgoing calls" and
  "B can't accept multiple simultaneous incoming calls"
- accept/reject only succeed for the actual callee, on a call that exists
  and is still `RINGING` (`not_participant` / `not_found` / `invalid_state`)
- cancel only succeeds for the actual caller
- offer/answer/ICE-candidate relaying only succeeds for an actual
  participant of that `callId`

## Error handling

| Scenario | How it's surfaced |
|---|---|
| Microphone permission denied | `WebRTCVoiceCallService` throws `MicPermissionDeniedException`; wire this to `VoiceCallError.microphonePermissionDenied` in your own try/catch around `startCall`/`accept` if you don't use the provided controller's flow as-is |
| WebSocket disconnected mid-call | `VoiceCallSignalingService.onConnectionChange(false)` → controller resets to idle, `lastError = webSocketDisconnected` |
| Callee unavailable / busy | Gateway emits `call:error` → `calleeUnavailable` |
| Call rejected / cancelled | `call:reject` / `call:cancel` → `callRejected` / `callCancelled` |
| ICE failed | `RTCPeerConnectionState.failed` → `call:failed` sent to peer, `iceFailed` |
| Remote peer disconnects mid-call | Gateway's `handleDisconnect` ends the active call and emits `call:hangup` with `reason: 'peer_disconnected'` to the other side |
| No answer | 45s ring timeout in the controller auto-cancels, `timeout` |

Every terminal case runs through `VoiceCallController._reset()`: stops local
tracks, closes the peer connection, clears SDP/ICE state, and returns to
`idle`. `lastError` carries the reason for one read (`consumeError()`) so the
UI can show it without it re-firing on the next rebuild.

## Logging

All sides log with `[CALL]`/`[WEBRTC]` prefixes (Nest's `Logger` on the
backend, `debugPrint` on the Flutter client, the browser console on the web
client) — call routing and connection-state transitions, never TURN
credentials, tokens, or SDP contents. The web client's WebRTC service also
logs throttled `getStats()` snapshots (bytes/packets/loss/audioLevel, once
every ~2s while connected) to the browser console — open DevTools if the
"Remote audio level" meter isn't moving and you need to see whether packets
are flowing at all.

## Testing procedure

1. `docker compose up -d --build` (from the repo root — starts both the
   signaling server and coturn; see Setup above)
2. Run the Flutter app on device/emulator A, sign in as user A.
3. Run the Flutter app on device/emulator B, sign in as user B.
4. On A, enter B's user id and tap Call.
5. B should see the incoming-call screen within ~1s.
6. Tap Accept on B.
7. Both sides should reach `connected` within a few seconds; speak into each
   mic and confirm you hear the other side.
8. Tap Mute on A; confirm B stops hearing A (A still hears B).
9. Tap Speaker on either side; confirm output routes to the loudspeaker vs
   earpiece.
10. Tap End Call on either side; both should return to idle.
11. Repeat the call (register/re-invite cleanly — the userActiveCall map
    should be free after step 10's cleanup).
12. Call again and have B tap Reject; A should see `callRejected` and return
    to idle.
13. Call again and have A tap Cancel before B answers; B's incoming-call
    screen should disappear.
14. Mid-call, force-quit one app (or kill its process) — the other side
    should get `call:hangup` (`peer_disconnected`) and return to idle within
    a couple seconds.
15. Toggle airplane mode/WiFi off on one device to break its WebSocket, then
    back on — reconnect and confirm a fresh call can be placed afterward
    (the busy state should have been released by the disconnect handler).

### Prefer the web client for your first end-to-end audio check

Android emulators (QEMU) don't reliably deliver real host microphone audio
into the guest's `AudioRecord`/WebRTC capture pipeline, even with
`-allow-host-audio` enabled and a confirmed-working host audio signal — the
transport layer (ICE/DTLS/SRTP/RTP) connects and looks perfectly healthy,
but the decoded audio level on the receiving end stays pinned at silence.
This isn't a bug in this codebase, it's a QEMU limitation, and it'll waste
your time if you try to debug "no audio" starting from two emulators.

Two browser tabs (or two devices, each with `http://<host-LAN-IP>:3002`
open) don't have this problem — `getUserMedia` captures the real mic. Get a
real call working there first (steps 2, 4-8, 10 above translate directly:
sign in with two different user ids, call, accept, watch the "Remote audio
level" meter move while you speak, mute, hang up) to prove the signaling +
ICE + TURN + audio pipeline is sound end-to-end, *before* chasing anything
that looks like an audio bug on an emulator. Physical phones are the other
reliable option; emulator-to-emulator is the one combination not worth
trusting for audio specifically.

### Testing across different networks

Everything above works over a LAN with a loopback-adjacent TURN config, but
that's not representative of real phones on real (cellular/different WiFi)
networks. To actually validate that:

- Deploy `coturn` on a small VPS with a public IP (see the VPS section in
  `coturn/.env.example`) rather than running it on your LAN.
- Point both phones' `iceServers` config at that public host/IP instead of a
  LAN address.
- Put one phone on WiFi and the other on cellular data (or two different
  WiFi networks/routers) — this is what actually exercises NAT traversal.
  Two phones on the *same* WiFi router will often connect via a direct/
  host candidate and never touch TURN at all, which doesn't prove anything
  about the real-world case.
- If the VPS itself is behind a cloud provider's NAT (its interface IP
  differs from its internet-facing IP), you must set `TURN_EXTERNAL_IP` to
  the actual public IP (or `public/private` combined form) — otherwise
  coturn advertises an address phones on the internet can't reach, and
  you'll see calls that connect on a LAN but silently carry no audio for
  real users.
- A public STUN server (`stun:stun.l.google.com:19302`) is included in the
  example ICE config as a first attempt; TURN is the fallback that makes the
  call reliable when direct/STUN paths are blocked by NAT — which is common
  enough on real networks that you should not skip testing it.

## Already running for you to test against

While building this, `docker compose up -d` was run on this machine
(`10.10.2.51`): signaling on port 3001, the web test client on port 3002,
TURN on port 3480 (avoids clashing with an unrelated project's coturn on
3478), with `TURN_USERNAME=testuser` / `TURN_PASSWORD=testpass`. All three
containers have `restart: unless-stopped`, so they'll survive a Docker
daemon restart. Open `http://10.10.2.51:3002` in a browser for the fastest
possible test (see "Prefer the web client..." above), or point your Flutter
app's config at `10.10.2.51:3001` / `10.10.2.51:3480` if your other computer
is on the same LAN — either way, no separate "start the server" step
needed. These are dev/test instances, not meant to be left running
long-term or exposed beyond your LAN. If your other device can't reach any
of these ports, check this host's firewall (`ufw`/`iptables`) for inbound
rules on 3001/tcp, 3002/tcp, and 3480/tcp+udp plus the 49260-49300/udp relay
range — Docker's `network_mode: host` means the containers bind directly to
the host's real interface, so host firewall rules still apply to them.
