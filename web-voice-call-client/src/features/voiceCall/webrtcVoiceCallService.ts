import type { IceCandidatePayload, SdpPayload } from './types'

export class MicPermissionDeniedError extends Error {
  constructor() {
    super('Microphone permission denied')
  }
}

// Browsers only expose navigator.mediaDevices in a "secure context" --
// https://, or http://localhost -- never plain http:// on a LAN IP like
// http://10.10.2.51. That's indistinguishable from a permission prompt at
// the getUserMedia call site (both just fail), so it's detected separately
// here and surfaced as its own error rather than a misleading "permission
// denied" that sends people looking for a prompt that will never appear.
export class MicUnavailableError extends Error {
  constructor() {
    super('Microphone API unavailable (page is not a secure context)')
  }
}

// Pure WebRTC mechanics for a single 1-to-1 audio call, using the browser's
// native RTCPeerConnection directly (no flutter_webrtc equivalent needed --
// this *is* the platform API). Knows nothing about call invites/accept/
// reject/state -- that's VoiceCallSignalingService's and the controller's
// job. Mirrors WebRTCVoiceCallService from the Flutter feature.
export class WebRTCVoiceCallService {
  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  // Browsers don't auto-route an inbound MediaStream to an output device the
  // way flutter_webrtc does on mobile -- an <audio> element has to actually
  // play it. Kept detached from the DOM; holding the reference is enough to
  // stop it being garbage-collected mid-call.
  private remoteAudioEl: HTMLAudioElement | null = null

  private durationTimer: ReturnType<typeof setInterval> | null = null
  private audioLevelTimer: ReturnType<typeof setInterval> | null = null
  private statsPollCount = 0

  // ICE candidates can arrive from signaling before the remote description is
  // set -- buffer and flush rather than silently dropping them.
  private remoteDescriptionSet = false
  private pendingCandidates: IceCandidatePayload[] = []

  private muted = false
  get isMuted(): boolean {
    return this.muted
  }

  private duration = 0
  get durationSeconds(): number {
    return this.duration
  }

  onIceCandidate?: (candidate: IceCandidatePayload) => void
  onConnectionState?: (state: RTCPeerConnectionState) => void
  onDurationTick?: (seconds: number) => void
  /** Fires ~5x/second while connected with the remote inbound audio level (0.0-1.0). */
  onRemoteAudioLevel?: (level: number) => void

  constructor(private readonly iceServers: RTCConfiguration) {}

  private createPeerConnection(): void {
    this.log('Creating peer connection')
    const pc = new RTCPeerConnection(this.iceServers)

    pc.onicecandidate = (event) => {
      if (event.candidate) this.onIceCandidate?.(event.candidate.toJSON() as IceCandidatePayload)
    }
    pc.onconnectionstatechange = () => {
      this.log(`Connection state: ${pc.connectionState}`)
      this.onConnectionState?.(pc.connectionState)
      if (pc.connectionState === 'connected') {
        this.startDurationTimer()
        this.startAudioLevelPolling()
      }
    }
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams
      if (remoteStream) this.playRemoteStream(remoteStream)
    }

    this.pc = pc
  }

  private playRemoteStream(stream: MediaStream): void {
    if (!this.remoteAudioEl) {
      this.remoteAudioEl = document.createElement('audio')
      this.remoteAudioEl.autoplay = true
    }
    this.remoteAudioEl.srcObject = stream
  }

  private startAudioLevelPolling(): void {
    if (this.audioLevelTimer) clearInterval(this.audioLevelTimer)
    this.statsPollCount = 0
    this.audioLevelTimer = setInterval(() => {
      const pc = this.pc
      if (!pc) return
      this.statsPollCount++
      const verbose = this.statsPollCount % 10 === 0 // ~once every 2s

      pc.getStats()
        .then((reports) => {
          reports.forEach((report) => {
            if (verbose && (report.type === 'outbound-rtp' || report.type === 'inbound-rtp') && report.kind === 'audio') {
              const bytes = report.bytesReceived ?? report.bytesSent
              const packets = report.packetsReceived ?? report.packetsSent
              this.log(
                `${report.type} bytes=${bytes} packets=${packets} lost=${report.packetsLost} level=${report.audioLevel}`,
              )
            }
            if (report.type === 'inbound-rtp' && report.kind === 'audio' && typeof report.audioLevel === 'number') {
              this.onRemoteAudioLevel?.(Math.min(1, Math.max(0, report.audioLevel)))
            }
          })
        })
        .catch((e: unknown) => this.log(`getStats error: ${String(e)}`))
    }, 200)
  }

  private async attachMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicUnavailableError()
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch (e) {
      // getUserMedia rejects for several distinct reasons (denied, no device,
      // device already in use, OS-level block) but the UI only has one
      // "permission denied" message -- log the real DOMException name/message
      // so it's visible in DevTools instead of silently discarded.
      this.log(`getUserMedia failed: ${e instanceof DOMException ? `${e.name}: ${e.message}` : String(e)}`)
      throw new MicPermissionDeniedError()
    }
    this.localStream = stream
    for (const track of stream.getTracks()) {
      this.pc!.addTrack(track, stream)
    }
  }

  /** Caller side: create the connection, attach the mic, and produce an SDP offer to send to the callee. */
  async createOffer(): Promise<SdpPayload> {
    this.createPeerConnection()
    await this.attachMicrophone()
    this.log('Creating offer')
    const offer = await this.pc!.createOffer()
    await this.pc!.setLocalDescription(offer)
    return { sdp: offer.sdp!, type: offer.type }
  }

  /** Callee side: create the connection, attach the mic, apply the caller's offer, and produce an SDP answer. */
  async createAnswer(remoteOffer: SdpPayload): Promise<SdpPayload> {
    this.createPeerConnection()
    await this.attachMicrophone()
    await this.pc!.setRemoteDescription(new RTCSessionDescription(remoteOffer as RTCSessionDescriptionInit))
    await this.flushPendingCandidates()
    const answer = await this.pc!.createAnswer()
    await this.pc!.setLocalDescription(answer)
    return { sdp: answer.sdp!, type: answer.type }
  }

  /** Caller side: apply the callee's answer once it arrives. */
  async applyAnswer(remoteAnswer: SdpPayload): Promise<void> {
    this.log('Received answer')
    await this.pc?.setRemoteDescription(new RTCSessionDescription(remoteAnswer as RTCSessionDescriptionInit))
    await this.flushPendingCandidates()
  }

  async addRemoteIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate)
      return
    }
    await this.applyCandidate(candidate)
  }

  private async flushPendingCandidates(): Promise<void> {
    this.remoteDescriptionSet = true
    for (const candidate of this.pendingCandidates) {
      await this.applyCandidate(candidate)
    }
    this.pendingCandidates = []
  }

  private async applyCandidate(candidate: IceCandidatePayload): Promise<void> {
    this.log('ICE candidate')
    await this.pc!.addIceCandidate(new RTCIceCandidate(candidate))
  }

  toggleMute(): void {
    if (!this.localStream) return
    this.muted = !this.muted
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !this.muted
    }
  }

  private startDurationTimer(): void {
    if (this.durationTimer) clearInterval(this.durationTimer)
    this.duration = 0
    this.durationTimer = setInterval(() => {
      this.duration += 1
      this.onDurationTick?.(this.duration)
    }, 1000)
  }

  /** Stops local audio, closes the peer connection, and clears all SDP/ICE state. Safe to call multiple times. */
  close(): void {
    if (this.durationTimer) clearInterval(this.durationTimer)
    this.durationTimer = null
    if (this.audioLevelTimer) clearInterval(this.audioLevelTimer)
    this.audioLevelTimer = null
    this.onRemoteAudioLevel?.(0)
    this.duration = 0
    this.muted = false
    this.remoteDescriptionSet = false
    this.pendingCandidates = []

    this.pc?.close()
    this.pc = null

    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop()
    }
    this.localStream = null

    if (this.remoteAudioEl) {
      this.remoteAudioEl.srcObject = null
      this.remoteAudioEl = null
    }
  }

  private log(message: string): void {
    console.log(`[WEBRTC] ${message}`)
  }
}
