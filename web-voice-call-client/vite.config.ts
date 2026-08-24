import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    nitro({
      rollupConfig: { external: [/^@sentry\//] },
      // Lets the signaling socket.io connection ride the same origin as the
      // page (see webrtcVoiceCallService/VITE_SIGNALING_URL) without needing
      // a second reverse-proxy rule in front of this container: the `web`
      // and `backend` compose services both use network_mode: host, so the
      // backend is always reachable at 127.0.0.1:3001 from here regardless
      // of how the public domain is fronted. Only proxies the HTTP
      // polling transport, not the WebSocket upgrade (Nitro's node preset
      // only wires up its 'upgrade' listener for its own websocket routes,
      // not routeRules proxies) -- socket.io transparently falls back to
      // long-polling when the upgrade probe fails, which is fine here since
      // this channel only ever carries small JSON signaling messages, never
      // audio (that's peer-to-peer WebRTC).
      routeRules: {
        '/socket.io/**': { proxy: 'http://127.0.0.1:3001/socket.io/**' },
      },
    }),

    tanstackStart(),
    viteReact(),
  ],
})

export default config
