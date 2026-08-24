export type CallDirection = 'outgoing' | 'incoming'

export type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'rejected'
  | 'failed'
  | 'cancelled'

export interface VoiceCall {
  callId: string
  peerId: string
  direction: CallDirection
  state: CallState
}

// Distinct, user-facing failure reasons the UI can branch on -- mirrors
// VoiceCallError in the Flutter feature.
export type VoiceCallError =
  | 'microphonePermissionDenied'
  | 'microphoneUnavailable'
  | 'webSocketDisconnected'
  | 'calleeUnavailable'
  | 'callRejected'
  | 'callCancelled'
  | 'iceFailed'
  | 'connectionFailed'
  | 'remotePeerDisconnected'
  | 'timeout'
  | 'unknown'

export interface SdpPayload {
  sdp: string
  type: string
}

export interface IceCandidatePayload {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}
