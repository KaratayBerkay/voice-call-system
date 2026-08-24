import { useState, type FormEvent } from 'react'
import { iceServers, signalingUrl } from './config'
import { useVoiceCallController } from './useVoiceCallController'
import type { VoiceCallError } from './types'

// Top-level UI: a login screen (userId doubles as the auth token, matching
// the backend's placeholder AuthService) followed by the call screen.
// Mirrors voice_call_screen.dart's role in the Flutter feature.
export function VoiceCallApp() {
  const [userId, setUserId] = useState<string | null>(null)
  return userId ? (
    <CallScreen userId={userId} onSignOut={() => setUserId(null)} />
  ) : (
    <LoginScreen onSignIn={setUserId} />
  )
}

function LoginScreen({ onSignIn }: { onSignIn: (userId: string) => void }) {
  const [value, setValue] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (trimmed) onSignIn(trimmed)
  }

  return (
    <main>
      <h1>Voice Call Test Client</h1>
      <p className="hint">
        Signaling server: <code>{signalingUrl}</code>
      </p>
      <form className="panel" onSubmit={submit}>
        <div className="row">
          <input
            type="text"
            autoFocus
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Your user id (e.g. web-1)"
          />
          <button type="submit" className="primary">
            Sign in
          </button>
        </div>
      </form>
    </main>
  )
}

function CallScreen({ userId, onSignOut }: { userId: string; onSignOut: () => void }) {
  const controller = useVoiceCallController({ baseUrl: signalingUrl, authToken: userId, iceServers })
  const [targetId, setTargetId] = useState('')

  const startCall = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = targetId.trim()
    if (trimmed) controller.startCall(trimmed)
  }

  return (
    <main>
      <div className="header">
        <span>
          Signed in as <strong>{userId}</strong>
        </span>
        <span className="status">
          <span className={`status-dot${controller.connected ? ' connected' : ''}`} />
          {controller.connected ? 'connected' : 'disconnected'}
        </span>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </div>

      {controller.lastError && (
        <div className="alert" role="alert">
          <span>{describeError(controller.lastError)}</span>
          <button className="ghost" onClick={controller.clearError}>
            Dismiss
          </button>
        </div>
      )}

      {controller.state === 'idle' && (
        <form className="panel" onSubmit={startCall}>
          <p className="call-sub">Enter another signed-in user's id to call them.</p>
          <div className="row">
            <input
              type="text"
              required
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="User id to call"
            />
            <button type="submit" className="primary" disabled={!controller.connected}>
              Call
            </button>
          </div>
        </form>
      )}

      {controller.state === 'calling' && (
        <div className="panel">
          <p className="call-peer">Calling {controller.call?.peerId}…</p>
          <p className="call-sub">Waiting for them to answer.</p>
          <div className="actions">
            <button className="danger" onClick={controller.cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {controller.state === 'ringing' && controller.call?.direction === 'incoming' && (
        <div className="panel">
          <p className="call-peer">Incoming call from {controller.call.peerId}</p>
          <div className="actions">
            <button className="primary" onClick={controller.accept}>
              Accept
            </button>
            <button className="danger" onClick={controller.reject}>
              Reject
            </button>
          </div>
        </div>
      )}

      {controller.state === 'connecting' && (
        <div className="panel">
          <p className="call-peer">Connecting to {controller.call?.peerId}…</p>
          <p className="call-sub">Negotiating WebRTC / ICE.</p>
        </div>
      )}

      {controller.state === 'connected' && (
        <div className="panel">
          <p className="call-peer">Connected to {controller.call?.peerId}</p>
          <p className="call-sub">{formatDuration(controller.duration)}</p>

          <div className="meter-label">
            <span>Remote audio level</span>
            <span>{controller.remoteAudioLevel.toFixed(5)}</span>
          </div>
          <div className="meter-track">
            <div
              className={`meter-fill${controller.remoteAudioLevel > 0.02 ? ' active' : ''}`}
              style={{ width: `${Math.round(Math.min(1, controller.remoteAudioLevel) * 100)}%` }}
            />
          </div>

          <div className="actions">
            <button onClick={controller.toggleMute}>{controller.isMuted ? 'Unmute' : 'Mute'}</button>
            <button className="danger" onClick={controller.hangUp}>
              Hang up
            </button>
          </div>
        </div>
      )}
    </main>
  )
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0')
  const seconds = (totalSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}

function describeError(error: VoiceCallError): string {
  switch (error) {
    case 'microphonePermissionDenied':
      return 'Microphone permission denied.'
    case 'microphoneUnavailable':
      return (
        "Browser blocked mic access because this page isn't a secure context " +
        '(only https:// or localhost qualify -- a plain http:// LAN address like this one doesn\'t). ' +
        'Enable chrome://flags/#unsafely-treat-insecure-origin-as-secure for this URL, or use HTTPS.'
      )
    case 'webSocketDisconnected':
      return 'Lost connection to the signaling server.'
    case 'calleeUnavailable':
      return 'That user is offline or already on a call.'
    case 'callRejected':
      return 'Call was rejected.'
    case 'callCancelled':
      return 'Call was cancelled.'
    case 'iceFailed':
      return 'Connection failed (ICE/TURN negotiation failed).'
    case 'connectionFailed':
      return 'Connection failed.'
    case 'remotePeerDisconnected':
      return 'The other person disconnected.'
    case 'timeout':
      return 'No answer.'
    case 'unknown':
      return 'Something went wrong.'
  }
}
