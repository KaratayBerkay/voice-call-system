enum CallDirection { outgoing, incoming }

enum CallState {
  idle,
  calling,
  ringing,
  connecting,
  connected,
  ended,
  rejected,
  failed,
  cancelled,
}

class VoiceCall {
  const VoiceCall({
    required this.callId,
    required this.peerId,
    required this.direction,
    required this.state,
  });

  final String callId;
  final String peerId;
  final CallDirection direction;
  final CallState state;

  VoiceCall copyWith({CallState? state}) {
    return VoiceCall(
      callId: callId,
      peerId: peerId,
      direction: direction,
      state: state ?? this.state,
    );
  }
}

// Distinct, user-facing failure reasons the UI/error handling can branch on.
enum VoiceCallError {
  microphonePermissionDenied,
  webSocketDisconnected,
  calleeUnavailable,
  callRejected,
  callCancelled,
  iceFailed,
  connectionFailed,
  remotePeerDisconnected,
  timeout,
  unknown,
}
