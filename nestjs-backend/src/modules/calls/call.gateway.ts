import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthService } from './auth.service';
import { CallService } from './call.service';
import { CallActionDto } from './dto/call-action.dto';
import { CallInviteDto } from './dto/call-invite.dto';
import { IceCandidateDto, WebrtcSignalDto } from './dto/webrtc-signal.dto';

// Pure signaling relay: call invite/accept/reject/hangup and WebRTC
// offer/answer/ICE candidates. No audio ever passes through this gateway.
@WebSocketGateway({ namespace: '/calls', cors: { origin: '*' } })
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class CallGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(CallGateway.name);

  constructor(
    private readonly calls: CallService,
    private readonly auth: AuthService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    const userId = await this.auth.verifyToken(token);
    if (!userId) {
      client.emit('call:error', { reason: 'unauthenticated' });
      client.disconnect(true);
      return;
    }

    client.data.userId = userId;
    this.calls.registerSocket(userId, client);
    this.logger.log(`[CALL] ${userId} connected`);
  }

  handleDisconnect(client: Socket): void {
    const userId = client.data.userId as string | undefined;
    if (!userId) return;

    const endedCall = this.calls.endActiveCallForUser(userId);
    if (endedCall) {
      const peerId = this.calls.peerOf(endedCall, userId);
      this.emitToUser(peerId, 'call:hangup', { callId: endedCall.callId, reason: 'peer_disconnected' });
      this.logger.log(`[CALL] ${userId} disconnected mid-call, notified ${peerId}`);
    }

    this.calls.unregisterSocket(userId, client);
    this.logger.log(`[CALL] ${userId} disconnected`);
  }

  @SubscribeMessage('call:invite')
  handleInvite(@ConnectedSocket() client: Socket, @MessageBody() dto: CallInviteDto) {
    const callerId = client.data.userId as string;
    this.logger.log(`[CALL] Calling user ${dto.calleeId}`);

    const result = this.calls.invite(callerId, dto.calleeId);
    if (!result.ok) {
      client.emit('call:error', { reason: result.error, calleeId: dto.calleeId });
      return;
    }

    this.emitToUser(dto.calleeId, 'call:invite', {
      callId: result.call.callId,
      from: callerId,
    });
    return { callId: result.call.callId, state: result.call.state };
  }

  @SubscribeMessage('call:accept')
  handleAccept(@ConnectedSocket() client: Socket, @MessageBody() dto: CallActionDto) {
    const userId = client.data.userId as string;
    const result = this.calls.accept(dto.callId, userId);
    if (!result.ok) return client.emit('call:error', { reason: result.error, callId: dto.callId });

    this.logger.log(`[CALL] ${userId} accepted ${dto.callId}`);
    this.emitToUser(result.call.callerId, 'call:accept', { callId: dto.callId, from: userId });
  }

  @SubscribeMessage('call:reject')
  handleReject(@ConnectedSocket() client: Socket, @MessageBody() dto: CallActionDto) {
    const userId = client.data.userId as string;
    const result = this.calls.reject(dto.callId, userId);
    if (!result.ok) return client.emit('call:error', { reason: result.error, callId: dto.callId });

    this.logger.log(`[CALL] ${userId} rejected ${dto.callId}`);
    this.emitToUser(result.call.callerId, 'call:reject', { callId: dto.callId, from: userId });
  }

  @SubscribeMessage('call:cancel')
  handleCancel(@ConnectedSocket() client: Socket, @MessageBody() dto: CallActionDto) {
    const userId = client.data.userId as string;
    const result = this.calls.cancel(dto.callId, userId);
    if (!result.ok) return client.emit('call:error', { reason: result.error, callId: dto.callId });

    this.logger.log(`[CALL] ${userId} cancelled ${dto.callId}`);
    this.emitToUser(result.call.calleeId, 'call:cancel', { callId: dto.callId, from: userId });
  }

  @SubscribeMessage('call:hangup')
  handleHangup(@ConnectedSocket() client: Socket, @MessageBody() dto: CallActionDto) {
    const userId = client.data.userId as string;
    const result = this.calls.hangup(dto.callId, userId);
    if (!result.ok) return client.emit('call:error', { reason: result.error, callId: dto.callId });

    this.logger.log(`[CALL] ${userId} hung up ${dto.callId}`);
    this.emitToUser(this.calls.peerOf(result.call, userId), 'call:hangup', { callId: dto.callId, from: userId });
  }

  // Reported by a client once its own RTCPeerConnection reaches
  // connected/failed -- the signaling server can't observe ICE state
  // itself, since that negotiation happens peer-to-peer.
  @SubscribeMessage('call:connected')
  handleConnected(@ConnectedSocket() client: Socket, @MessageBody() dto: CallActionDto) {
    const userId = client.data.userId as string;
    const result = this.calls.markConnected(dto.callId, userId);
    if (!result.ok) return;
    this.logger.log(`[CALL] Call connected (${dto.callId})`);
  }

  @SubscribeMessage('call:failed')
  handleFailed(@ConnectedSocket() client: Socket, @MessageBody() dto: CallActionDto) {
    const userId = client.data.userId as string;
    const result = this.calls.fail(dto.callId, userId);
    if (!result.ok) return;
    this.logger.log(`[CALL] Call failed (${dto.callId})`);
    this.emitToUser(this.calls.peerOf(result.call, userId), 'call:failed', { callId: dto.callId });
  }

  @SubscribeMessage('webrtc:offer')
  handleOffer(@ConnectedSocket() client: Socket, @MessageBody() dto: WebrtcSignalDto) {
    const userId = client.data.userId as string;
    const call = this.calls.assertParticipant(dto.callId, userId);
    if (!call) return client.emit('call:error', { reason: 'not_found', callId: dto.callId });

    this.logger.log(`[WEBRTC] Offer for ${dto.callId}`);
    this.emitToUser(this.calls.peerOf(call, userId), 'webrtc:offer', { callId: dto.callId, sdp: dto.sdp });
  }

  @SubscribeMessage('webrtc:answer')
  handleAnswer(@ConnectedSocket() client: Socket, @MessageBody() dto: WebrtcSignalDto) {
    const userId = client.data.userId as string;
    const call = this.calls.assertParticipant(dto.callId, userId);
    if (!call) return client.emit('call:error', { reason: 'not_found', callId: dto.callId });

    this.logger.log(`[WEBRTC] Answer for ${dto.callId}`);
    this.emitToUser(this.calls.peerOf(call, userId), 'webrtc:answer', { callId: dto.callId, sdp: dto.sdp });
  }

  @SubscribeMessage('webrtc:ice-candidate')
  handleIceCandidate(@ConnectedSocket() client: Socket, @MessageBody() dto: IceCandidateDto) {
    const userId = client.data.userId as string;
    const call = this.calls.assertParticipant(dto.callId, userId);
    if (!call) return;

    this.emitToUser(this.calls.peerOf(call, userId), 'webrtc:ice-candidate', {
      callId: dto.callId,
      candidate: dto.candidate,
    });
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    this.calls.getSocket(userId)?.emit(event, payload);
  }
}
