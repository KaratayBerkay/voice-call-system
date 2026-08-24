import 'dart:async';
import 'package:flutter/foundation.dart' show debugPrint;

import 'package:socket_io_client/socket_io_client.dart' as socket_io;

// Thin wrapper around the Socket.IO connection to the NestJS CallGateway
// (the `/calls` namespace). Only ever exchanges call setup/state and WebRTC
// signaling (offer/answer/ICE candidates) -- never audio.
//
// INTEGRATION POINT: `authToken` should be whatever token your app's
// existing authentication already produces (the same one your other API
// calls use). The server resolves it to a user id itself and never trusts a
// client-supplied id, so this class never needs to know your app's user id
// ahead of time.
class VoiceCallSignalingService {
  VoiceCallSignalingService({required this.baseUrl, required this.authToken});

  final String baseUrl;
  final String authToken;

  socket_io.Socket? _socket;

  final _onInvite = StreamController<Map<String, dynamic>>.broadcast();
  final _onAccept = StreamController<Map<String, dynamic>>.broadcast();
  final _onReject = StreamController<Map<String, dynamic>>.broadcast();
  final _onCancel = StreamController<Map<String, dynamic>>.broadcast();
  final _onHangup = StreamController<Map<String, dynamic>>.broadcast();
  final _onOffer = StreamController<Map<String, dynamic>>.broadcast();
  final _onAnswer = StreamController<Map<String, dynamic>>.broadcast();
  final _onIceCandidate = StreamController<Map<String, dynamic>>.broadcast();
  final _onFailed = StreamController<Map<String, dynamic>>.broadcast();
  final _onError = StreamController<Map<String, dynamic>>.broadcast();
  final _onConnectionChange = StreamController<bool>.broadcast();

  Stream<Map<String, dynamic>> get onInvite => _onInvite.stream;
  Stream<Map<String, dynamic>> get onAccept => _onAccept.stream;
  Stream<Map<String, dynamic>> get onReject => _onReject.stream;
  Stream<Map<String, dynamic>> get onCancel => _onCancel.stream;
  Stream<Map<String, dynamic>> get onHangup => _onHangup.stream;
  Stream<Map<String, dynamic>> get onOffer => _onOffer.stream;
  Stream<Map<String, dynamic>> get onAnswer => _onAnswer.stream;
  Stream<Map<String, dynamic>> get onIceCandidate => _onIceCandidate.stream;
  Stream<Map<String, dynamic>> get onFailed => _onFailed.stream;
  Stream<Map<String, dynamic>> get onError => _onError.stream;

  /// Emits `true`/`false` as the WebSocket connects/disconnects. A `false`
  /// while a call is active means the call can no longer be signaled --
  /// treat it as `VoiceCallError.webSocketDisconnected`.
  Stream<bool> get onConnectionChange => _onConnectionChange.stream;

  bool get isConnected => _socket?.connected ?? false;

  void connect() {
    final socket = socket_io.io(
      '$baseUrl/calls',
      socket_io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': authToken})
          .disableAutoConnect()
          .build(),
    );
    _socket = socket;

    socket.onConnect((_) {
      _log('connected');
      _onConnectionChange.add(true);
    });
    socket.onDisconnect((_) {
      _log('disconnected');
      _onConnectionChange.add(false);
    });
    socket.on('call:invite', (data) => _onInvite.add(_asMap(data)));
    socket.on('call:accept', (data) => _onAccept.add(_asMap(data)));
    socket.on('call:reject', (data) => _onReject.add(_asMap(data)));
    socket.on('call:cancel', (data) => _onCancel.add(_asMap(data)));
    socket.on('call:hangup', (data) => _onHangup.add(_asMap(data)));
    socket.on('webrtc:offer', (data) => _onOffer.add(_asMap(data)));
    socket.on('webrtc:answer', (data) => _onAnswer.add(_asMap(data)));
    socket.on('webrtc:ice-candidate', (data) => _onIceCandidate.add(_asMap(data)));
    socket.on('call:failed', (data) => _onFailed.add(_asMap(data)));
    socket.on('call:error', (data) => _onError.add(_asMap(data)));

    socket.connect();
  }

  Map<String, dynamic> _asMap(dynamic data) => Map<String, dynamic>.from(data as Map);

  void invite(String calleeId, void Function(Map<String, dynamic> ack) onAck) {
    _log('Calling user $calleeId');
    _socket?.emitWithAck('call:invite', {'calleeId': calleeId}, ack: (dynamic data) {
      onAck(_asMap(data));
    });
  }

  void accept(String callId) => _socket?.emit('call:accept', {'callId': callId});
  void reject(String callId) => _socket?.emit('call:reject', {'callId': callId});
  void cancel(String callId) => _socket?.emit('call:cancel', {'callId': callId});
  void hangup(String callId) => _socket?.emit('call:hangup', {'callId': callId});
  void notifyConnected(String callId) => _socket?.emit('call:connected', {'callId': callId});
  void notifyFailed(String callId) => _socket?.emit('call:failed', {'callId': callId});

  void sendOffer(String callId, Map<String, dynamic> sdp) {
    _log('Creating offer');
    _socket?.emit('webrtc:offer', {'callId': callId, 'sdp': sdp});
  }

  void sendAnswer(String callId, Map<String, dynamic> sdp) {
    _socket?.emit('webrtc:answer', {'callId': callId, 'sdp': sdp});
  }

  void sendIceCandidate(String callId, Map<String, dynamic> candidate) {
    _socket?.emit('webrtc:ice-candidate', {'callId': callId, 'candidate': candidate});
  }

  void _log(String message) => debugPrint('[CALL] $message');

  void dispose() {
    _socket?.dispose();
    _socket = null;
    _onInvite.close();
    _onAccept.close();
    _onReject.close();
    _onCancel.close();
    _onHangup.close();
    _onOffer.close();
    _onAnswer.close();
    _onIceCandidate.close();
    _onFailed.close();
    _onError.close();
    _onConnectionChange.close();
  }
}
