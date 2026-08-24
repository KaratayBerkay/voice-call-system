// Baked in at `vite build` time via Docker build args (see
// web-voice-call-client/Dockerfile and the root docker-compose.yml) -- not
// meant to hold production secrets, only this LAN test deployment's TURN
// credentials, same as the Flutter test-app's hardcoded config.
//
// A Docker ARG that's declared but never given a --build-arg/compose value
// resolves to '' (empty string), not undefined -- so these fallbacks must
// treat '' as "unset" too. `??` alone doesn't (it only catches null/
// undefined), which previously baked in a literal `{urls: ''}` STUN server
// and made `new RTCPeerConnection()` throw synchronously on every call.
function envOrDefault(value: string | undefined, fallback: string): string {
  return value ? value : fallback
}

export const signalingUrl = envOrDefault(import.meta.env.VITE_SIGNALING_URL, 'http://localhost:3001')

const turnUrl = import.meta.env.VITE_TURN_URL
const turnUsername = import.meta.env.VITE_TURN_USERNAME
const turnPassword = import.meta.env.VITE_TURN_PASSWORD

export const iceServers: RTCConfiguration = {
  iceServers: [
    { urls: envOrDefault(import.meta.env.VITE_STUN_URL, 'stun:stun.l.google.com:19302') },
    ...(turnUrl ? [{ urls: turnUrl, username: turnUsername ?? '', credential: turnPassword ?? '' }] : []),
  ],
}
