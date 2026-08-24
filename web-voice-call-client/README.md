# web-voice-call-client

Browser test client for the voice-call-system signaling protocol, built with
TanStack Start. See the [repo root README](../README.md) for the full
picture (architecture, Docker Compose setup, testing procedure). This file
only covers local commands specific to this package.

```bash
cp .env.example .env   # edit VITE_* if not testing on localhost
npm install
npm run dev             # http://localhost:3002, hot-reloads on save
```

`src/features/voiceCall/` is a browser-native port of
`flutter-voice-call-feature/lib/features/voice_call/` — same signaling
events/payloads, same call state machine, native `RTCPeerConnection` +
`getUserMedia` instead of `flutter_webrtc`.

## Build

```bash
npm run build
node .output/server/index.mjs
```

The build output (`.output/`) is a self-contained Node server via Nitro's
`node-server` preset — no `node_modules` needed at runtime. `PORT` (default
3002) selects the listen port. See `Dockerfile` for how this project bakes
`VITE_*` config in at build time via Docker build args.
