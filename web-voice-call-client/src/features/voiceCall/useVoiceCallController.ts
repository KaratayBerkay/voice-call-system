import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceCallSignalingService } from './voiceCallSignalingService'
import { MicPermissionDeniedError, MicUnavailableError, WebRTCVoiceCallService } from './webrtcVoiceCallService'
import type { VoiceCall, VoiceCallError } from './types'

function mapMicError(e: unknown): VoiceCallError {
  if (e instanceof MicPermissionDeniedError) return 'microphonePermissionDenied'
  if (e instanceof MicUnavailableError) return 'microphoneUnavailable'
  return 'unknown'
}

const RING_TIMEOUT_MS = 45_000

export interface VoiceCallControllerOptions {
  baseUrl: string
  authToken: string
  iceServers: RTCConfiguration
}

// Orchestrates VoiceCallSignalingService (call:*/webrtc:* over the socket)
// and WebRTCVoiceCallService (the actual RTCPeerConnection) into the call
// state machine described in the spec: idle -> calling/ringing ->
// connecting -> connected -> ended/rejected/failed/cancelled -> idle.
// Mirrors VoiceCallController from the Flutter feature; a React hook here
// plays the role its ChangeNotifier plays there.
export function useVoiceCallController({ baseUrl, authToken, iceServers }: VoiceCallControllerOptions) {
  const [call, setCall] = useState<VoiceCall | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastError, setLastError] = useState<VoiceCallError | null>(null)
  const [duration, setDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0)

  const signalingRef = useRef<VoiceCallSignalingService | null>(null)
  const webrtcRef = useRef<WebRTCVoiceCallService | null>(null)
  // Mirrors `call` state but readable synchronously from inside callbacks
  // registered once on mount, which would otherwise close over a stale value.
  const callRef = useRef<VoiceCall | null>(null)
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callAttemptRef = useRef<object | null>(null)

  const updateCall = useCallback((next: VoiceCall | null) => {
    callRef.current = next
    setCall(next)
  }, [])

  const reset = useCallback(() => {
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current)
    callAttemptRef.current = null
    webrtcRef.current?.close()
    updateCall(null)
    setRemoteAudioLevel(0)
    setDuration(0)
    setIsMuted(false)
  }, [updateCall])

  const fail = useCallback(
    (error: VoiceCallError) => {
      setLastError(error)
      reset()
    },
    [reset],
  )

  const cancel = useCallback(() => {
    if (!callRef.current) return
    signalingRef.current?.cancel(callRef.current.callId)
    reset()
  }, [reset])

  useEffect(() => {
    const webrtc = new WebRTCVoiceCallService(iceServers)
    const signaling = new VoiceCallSignalingService(baseUrl, authToken)
    webrtcRef.current = webrtc
    signalingRef.current = signaling

    const matches = (data: { callId: string }) => callRef.current !== null && data.callId === callRef.current.callId

    webrtc.onIceCandidate = (candidate) => {
      if (!callRef.current) return
      signaling.sendIceCandidate(callRef.current.callId, candidate)
    }
    webrtc.onConnectionState = (state) => {
      if (!callRef.current) return
      if (state === 'connected') {
        updateCall({ ...callRef.current, state: 'connected' })
        signaling.notifyConnected(callRef.current.callId)
      } else if (state === 'failed') {
        signaling.notifyFailed(callRef.current.callId)
        fail('iceFailed')
      }
    }
    webrtc.onDurationTick = (seconds) => setDuration(seconds)
    webrtc.onRemoteAudioLevel = (level) => setRemoteAudioLevel(level)

    signaling.onInvite = (data) => {
      if (callRef.current) return // server already prevents this; stay defensive
      updateCall({ callId: data.callId, peerId: data.from, direction: 'incoming', state: 'ringing' })
    }
    signaling.onAccept = (data) => {
      if (!matches(data)) return
      updateCall({ ...callRef.current!, state: 'connecting' })
      webrtc
        .createOffer()
        .then((offer) => signaling.sendOffer(callRef.current!.callId, offer))
        .catch((e: unknown) => fail(mapMicError(e)))
    }
    signaling.onReject = (data) => matches(data) && fail('callRejected')
    signaling.onCancel = (data) => matches(data) && fail('callCancelled')
    signaling.onHangup = (data) => matches(data) && reset()
    signaling.onOffer = (data) => {
      if (!matches(data)) return
      webrtc
        .createAnswer(data.sdp)
        .then((answer) => signaling.sendAnswer(callRef.current!.callId, answer))
        .catch((e: unknown) => fail(mapMicError(e)))
    }
    signaling.onAnswer = (data) => {
      if (matches(data)) void webrtc.applyAnswer(data.sdp)
    }
    signaling.onIceCandidate = (data) => {
      if (matches(data)) void webrtc.addRemoteIceCandidate(data.candidate)
    }
    signaling.onFailed = (data) => matches(data) && fail('connectionFailed')
    signaling.onError = (data) => {
      const reason = data.reason
      setLastError(mapServerError(reason))
      if (reason === 'callee_offline' || reason === 'busy' || reason === 'self_call') reset()
    }
    signaling.onConnectionChange = (isConnected) => {
      setConnected(isConnected)
      if (!isConnected && callRef.current) {
        setLastError('webSocketDisconnected')
        reset()
      }
    }

    signaling.connect()

    return () => {
      if (ringTimerRef.current) clearTimeout(ringTimerRef.current)
      webrtc.close()
      signaling.dispose()
    }
  }, [baseUrl, authToken, iceServers, fail, reset, updateCall])

  /** Caller side: request a call. The UI shows "calling" optimistically. */
  const startCall = useCallback(
    (peerId: string) => {
      if (callRef.current || !peerId) return
      setLastError(null)
      const attempt = {}
      callAttemptRef.current = attempt
      updateCall({ callId: '', peerId, direction: 'outgoing', state: 'calling' })

      signalingRef.current?.invite(peerId, (ack) => {
        if (callAttemptRef.current !== attempt) return // superseded by an error/reset already
        if (!ack.callId) return // rejection arrives separately via onError
        updateCall({ callId: ack.callId, peerId, direction: 'outgoing', state: 'calling' })
        if (ringTimerRef.current) clearTimeout(ringTimerRef.current)
        ringTimerRef.current = setTimeout(() => {
          if (callRef.current?.state === 'calling') {
            setLastError('timeout')
            cancel()
          }
        }, RING_TIMEOUT_MS)
      })
    },
    [updateCall, cancel],
  )

  const accept = useCallback(() => {
    if (!callRef.current) return
    signalingRef.current?.accept(callRef.current.callId)
    updateCall({ ...callRef.current, state: 'connecting' })
  }, [updateCall])

  const reject = useCallback(() => {
    if (!callRef.current) return
    signalingRef.current?.reject(callRef.current.callId)
    reset()
  }, [reset])

  const hangUp = useCallback(() => {
    if (!callRef.current) return
    signalingRef.current?.hangup(callRef.current.callId)
    reset()
  }, [reset])

  const toggleMute = useCallback(() => {
    webrtcRef.current?.toggleMute()
    setIsMuted(webrtcRef.current?.isMuted ?? false)
  }, [])

  const clearError = useCallback(() => setLastError(null), [])

  return {
    call,
    state: call?.state ?? 'idle',
    connected,
    lastError,
    clearError,
    duration,
    isMuted,
    remoteAudioLevel,
    startCall,
    accept,
    reject,
    cancel,
    hangUp,
    toggleMute,
  }
}

function mapServerError(reason: string | undefined): VoiceCallError {
  switch (reason) {
    case 'callee_offline':
    case 'busy':
      return 'calleeUnavailable'
    default:
      return 'unknown'
  }
}
