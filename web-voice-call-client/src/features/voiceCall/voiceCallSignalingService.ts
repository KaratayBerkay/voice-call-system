import { io, type Socket } from 'socket.io-client'
import type { IceCandidatePayload, SdpPayload } from './types'

interface InviteAck {
  callId?: string
  state?: string
}

interface CallEventPayload {
  callId: string
  from: string
}

interface ErrorPayload {
  reason?: string
  callId?: string
  calleeId?: string
}

// Thin wrapper around the Socket.IO connection to the NestJS CallGateway
// (the `/calls` namespace). Only ever exchanges call setup/state and WebRTC
// signaling (offer/answer/ICE candidates) -- never audio. Mirrors
// VoiceCallSignalingService from the Flutter feature 1:1, event for event.
//
// INTEGRATION POINT: `authToken` should be whatever token your app's real
// authentication produces. The server resolves it to a user id itself and
// never trusts a client-supplied id.
export class VoiceCallSignalingService {
  private socket: Socket | null = null

  onInvite?: (data: CallEventPayload) => void
  onAccept?: (data: CallEventPayload) => void
  onReject?: (data: CallEventPayload) => void
  onCancel?: (data: CallEventPayload) => void
  onHangup?: (data: CallEventPayload) => void
  onOffer?: (data: { callId: string; sdp: SdpPayload }) => void
  onAnswer?: (data: { callId: string; sdp: SdpPayload }) => void
  onIceCandidate?: (data: { callId: string; candidate: IceCandidatePayload }) => void
  onFailed?: (data: { callId: string }) => void
  onError?: (data: ErrorPayload) => void
  onConnectionChange?: (connected: boolean) => void

  constructor(
    private readonly baseUrl: string,
    private readonly authToken: string,
  ) {}

  get isConnected(): boolean {
    return this.socket?.connected ?? false
  }

  connect(): void {
    const socket = io(`${this.baseUrl}/calls`, {
      transports: ['websocket'],
      auth: { token: this.authToken },
      autoConnect: false,
    })
    this.socket = socket

    socket.on('connect', () => {
      this.log('connected')
      this.onConnectionChange?.(true)
    })
    socket.on('disconnect', () => {
      this.log('disconnected')
      this.onConnectionChange?.(false)
    })
    socket.on('call:invite', (data: CallEventPayload) => this.onInvite?.(data))
    socket.on('call:accept', (data: CallEventPayload) => this.onAccept?.(data))
    socket.on('call:reject', (data: CallEventPayload) => this.onReject?.(data))
    socket.on('call:cancel', (data: CallEventPayload) => this.onCancel?.(data))
    socket.on('call:hangup', (data: CallEventPayload) => this.onHangup?.(data))
    socket.on('webrtc:offer', (data: { callId: string; sdp: SdpPayload }) => this.onOffer?.(data))
    socket.on('webrtc:answer', (data: { callId: string; sdp: SdpPayload }) => this.onAnswer?.(data))
    socket.on('webrtc:ice-candidate', (data: { callId: string; candidate: IceCandidatePayload }) =>
      this.onIceCandidate?.(data),
    )
    socket.on('call:failed', (data: { callId: string }) => this.onFailed?.(data))
    socket.on('call:error', (data: ErrorPayload) => this.onError?.(data))

    socket.connect()
  }

  invite(calleeId: string, onAck: (ack: InviteAck) => void): void {
    this.log(`Calling user ${calleeId}`)
    this.socket?.emit('call:invite', { calleeId }, (ack: InviteAck) => onAck(ack))
  }

  accept(callId: string): void {
    this.socket?.emit('call:accept', { callId })
  }

  reject(callId: string): void {
    this.socket?.emit('call:reject', { callId })
  }

  cancel(callId: string): void {
    this.socket?.emit('call:cancel', { callId })
  }

  hangup(callId: string): void {
    this.socket?.emit('call:hangup', { callId })
  }

  notifyConnected(callId: string): void {
    this.socket?.emit('call:connected', { callId })
  }

  notifyFailed(callId: string): void {
    this.socket?.emit('call:failed', { callId })
  }

  sendOffer(callId: string, sdp: SdpPayload): void {
    this.log('Creating offer')
    this.socket?.emit('webrtc:offer', { callId, sdp })
  }

  sendAnswer(callId: string, sdp: SdpPayload): void {
    this.socket?.emit('webrtc:answer', { callId, sdp })
  }

  sendIceCandidate(callId: string, candidate: IceCandidatePayload): void {
    this.socket?.emit('webrtc:ice-candidate', { callId, candidate })
  }

  private log(message: string): void {
    console.log(`[CALL] ${message}`)
  }

  dispose(): void {
    this.socket?.disconnect()
    this.socket = null
  }
}
