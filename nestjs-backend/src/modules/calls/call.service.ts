import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Socket } from 'socket.io';
import { CallSession, CallState } from './interfaces/call.interface';

type InviteError = 'self_call' | 'busy' | 'callee_offline';
type ActionError = 'not_found' | 'not_participant' | 'invalid_state';

type InviteResult = { ok: true; call: CallSession } | { ok: false; error: InviteError };
type ActionResult = { ok: true; call: CallSession } | { ok: false; error: ActionError };

// Owns the call state machine and the userId <-> socket registry. Holds
// everything in memory: calls only need to work while both apps are open
// and connected, so there's nothing to persist across restarts.
@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);

  private readonly sockets = new Map<string, Socket>();
  private readonly calls = new Map<string, CallSession>();
  private readonly userActiveCall = new Map<string, string>();

  registerSocket(userId: string, socket: Socket): void {
    const existing = this.sockets.get(userId);
    if (existing && existing !== socket) existing.disconnect(true);
    this.sockets.set(userId, socket);
  }

  unregisterSocket(userId: string, socket: Socket): void {
    if (this.sockets.get(userId) === socket) this.sockets.delete(userId);
  }

  getSocket(userId: string): Socket | undefined {
    return this.sockets.get(userId);
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  getCall(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  getActiveCallForUser(userId: string): CallSession | undefined {
    const callId = this.userActiveCall.get(userId);
    return callId ? this.calls.get(callId) : undefined;
  }

  peerOf(call: CallSession, userId: string): string {
    return call.callerId === userId ? call.calleeId : call.callerId;
  }

  // Only a call's caller or callee may drive its signaling.
  assertParticipant(callId: string, userId: string): CallSession | null {
    const call = this.calls.get(callId);
    if (!call) return null;
    if (call.callerId !== userId && call.calleeId !== userId) return null;
    return call;
  }

  invite(callerId: string, calleeId: string): InviteResult {
    if (callerId === calleeId) return { ok: false, error: 'self_call' };
    if (this.userActiveCall.has(callerId) || this.userActiveCall.has(calleeId)) {
      return { ok: false, error: 'busy' };
    }
    if (!this.isOnline(calleeId)) return { ok: false, error: 'callee_offline' };

    const call: CallSession = {
      callId: randomUUID(),
      callerId,
      calleeId,
      state: CallState.RINGING,
      createdAt: Date.now(),
    };
    this.calls.set(call.callId, call);
    this.userActiveCall.set(callerId, call.callId);
    this.userActiveCall.set(calleeId, call.callId);
    this.logger.log(`[CALL] ${callerId} calling ${calleeId} (${call.callId})`);
    return { ok: true, call };
  }

  accept(callId: string, userId: string): ActionResult {
    const call = this.calls.get(callId);
    if (!call) return { ok: false, error: 'not_found' };
    if (call.calleeId !== userId) return { ok: false, error: 'not_participant' };
    if (call.state !== CallState.RINGING) return { ok: false, error: 'invalid_state' };
    call.state = CallState.CONNECTING;
    return { ok: true, call };
  }

  reject(callId: string, userId: string): ActionResult {
    const call = this.calls.get(callId);
    if (!call) return { ok: false, error: 'not_found' };
    if (call.calleeId !== userId) return { ok: false, error: 'not_participant' };
    if (call.state !== CallState.RINGING) return { ok: false, error: 'invalid_state' };
    call.state = CallState.REJECTED;
    this.release(call);
    return { ok: true, call };
  }

  // The caller backing out before the callee answers.
  cancel(callId: string, userId: string): ActionResult {
    const call = this.calls.get(callId);
    if (!call) return { ok: false, error: 'not_found' };
    if (call.callerId !== userId) return { ok: false, error: 'not_participant' };
    if (call.state !== CallState.RINGING) return { ok: false, error: 'invalid_state' };
    call.state = CallState.CANCELLED;
    this.release(call);
    return { ok: true, call };
  }

  markConnected(callId: string, userId: string): ActionResult {
    const call = this.assertParticipant(callId, userId);
    if (!call) return { ok: false, error: 'not_found' };
    call.state = CallState.CONNECTED;
    return { ok: true, call };
  }

  fail(callId: string, userId: string): ActionResult {
    const call = this.assertParticipant(callId, userId);
    if (!call) return { ok: false, error: 'not_found' };
    call.state = CallState.FAILED;
    this.release(call);
    return { ok: true, call };
  }

  hangup(callId: string, userId: string): ActionResult {
    const call = this.assertParticipant(callId, userId);
    if (!call) return { ok: false, error: 'not_found' };
    call.state = CallState.ENDED;
    this.release(call);
    return { ok: true, call };
  }

  // Called on disconnect: whatever call the user was in ends immediately.
  endActiveCallForUser(userId: string): CallSession | undefined {
    const call = this.getActiveCallForUser(userId);
    if (!call) return undefined;
    call.state = CallState.ENDED;
    this.release(call);
    return call;
  }

  private release(call: CallSession): void {
    this.calls.delete(call.callId);
    if (this.userActiveCall.get(call.callerId) === call.callId) {
      this.userActiveCall.delete(call.callerId);
    }
    if (this.userActiveCall.get(call.calleeId) === call.callId) {
      this.userActiveCall.delete(call.calleeId);
    }
  }
}
