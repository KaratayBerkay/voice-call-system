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

## Layout

```
voice-call-system/
  nestjs-backend/                 Signaling gateway (this repo, runnable standalone)
    src/modules/calls/
      call.gateway.ts             WebSocket events, routes messages
      call.service.ts             Call state machine, socket <-> userId registry
      auth.service.ts             INTEGRATION POINT: plug in your real auth
      dto/                        class-validator payload shapes
      interfaces/call.interface.ts
  coturn/
    docker-compose.yml            TURN/STUN relay
    .env.example                  Copy to .env; see local vs VPS guidance inside
  flutter-voice-call-feature/     Standalone Dart package -- copy lib/features/voice_call
    lib/features/voice_call/      into your app, or add this as a local path dependency
      models/voice_call.dart
      services/
        webrtc_voice_call_service.dart      Pure RTCPeerConnection mechanics
        voice_call_signaling_service.dart   Socket.IO client for the gateway
      domain/voice_call_controller.dart     Ties the two together + call state machine
      presentation/voice_call_screen.dart   Minimal test UI
```

## Why NestJS uses Socket.IO

`@nestjs/websockets` + `@nestjs/platform-socket.io` (the standard NestJS
gateway stack) speaks the Socket.IO protocol, not raw WebSocket framing. The
Flutter side must use `socket_io_client` to match — a plain `WebSocket`/
`web_socket_channel` connection cannot talk to a NestJS `@WebSocketGateway()`.

## Setup

### 1. Signaling server

```bash
cd nestjs-backend
npm install
npm run build
PORT=3001 npm start
# or for development with auto-restart:
npm run start:dev
```

### 2. TURN/STUN (coturn)

```bash
cd coturn
cp .env.example .env
# edit .env -- see the comments inside for local-dev vs VPS values
docker compose up -d
```

**Read the comments in `.env.example` before starting.** The short version:
`TURN_LISTENING_IP` and `TURN_RELAY_IP` must be a real, routable interface
address (your machine's LAN IP for local dev, or the VPS's interface for
production) — **not** `127.0.0.1` or `localhost`. A relay socket bound to
loopback can physically only reach itself, so calls that need the TURN
relay (which, on real phone networks, is most of them) will connect but
carry no audio if this is misconfigured. This isn't a hypothetical: it's the
exact bug hit and fixed while building this.

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

Both sides log with `[CALL]`/`[WEBRTC]` prefixes (Nest's `Logger` on the
backend, `dart:developer log(name: 'CALL'|'WEBRTC')` on the client) — call
routing and connection-state transitions, never TURN credentials, tokens, or
SDP contents.

## Testing procedure

1. `cd nestjs-backend && npm run start:dev`
2. `cd coturn && docker compose up -d`
3. Run the Flutter app on device/emulator A, sign in as user A.
4. Run the Flutter app on device/emulator B, sign in as user B.
5. On A, enter B's user id and tap Call.
6. B should see the incoming-call screen within ~1s.
7. Tap Accept on B.
8. Both sides should reach `connected` within a few seconds; speak into each
   mic and confirm you hear the other side.
9. Tap Mute on A; confirm B stops hearing A (A still hears B).
10. Tap Speaker on either side; confirm output routes to the loudspeaker vs
    earpiece.
11. Tap End Call on either side; both should return to idle.
12. Repeat the call (register/re-invite cleanly — the userActiveCall map
    should be free after step 11's cleanup).
13. Call again and have B tap Reject; A should see `callRejected` and return
    to idle.
14. Call again and have A tap Cancel before B answers; B's incoming-call
    screen should disappear.
15. Mid-call, force-quit one app (or kill its process) — the other side
    should get `call:hangup` (`peer_disconnected`) and return to idle within
    a couple seconds.
16. Toggle airplane mode/WiFi off on one device to break its WebSocket, then
    back on — reconnect and confirm a fresh call can be placed afterward
    (the busy state should have been released by the disconnect handler).

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

While building this, the signaling server and a test coturn instance were
started on this machine (`10.10.2.51`): signaling on port 3001, TURN on port
3480 (avoids clashing with an unrelated project's coturn on 3478), with
`TURN_USERNAME=testuser` / `TURN_PASSWORD=testpass`. Point your Flutter app's
config at `10.10.2.51:3001` / `10.10.2.51:3480` if your other computer is on
the same LAN, to test immediately without deploying anything yourself. These
are dev/test instances, not meant to be left running long-term or exposed
beyond your LAN.
