export enum CallState {
  RINGING = 'RINGING',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ENDED = 'ENDED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface CallSession {
  callId: string;
  callerId: string;
  calleeId: string;
  state: CallState;
  createdAt: number;
}
