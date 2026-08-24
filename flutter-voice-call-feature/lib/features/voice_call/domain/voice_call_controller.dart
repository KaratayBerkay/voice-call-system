import 'dart:async' show Timer, unawaited;

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' show RTCPeerConnectionState;

import '../models/voice_call.dart';
import '../services/voice_call_signaling_service.dart';
import '../services/webrtc_voice_call_service.dart';

const _ringTimeout = Duration(seconds: 45);

// Orchestrates VoiceCallSignalingService (call:*/webrtc:* over the socket)
// and WebRTCVoiceCallService (the actual RTCPeerConnection) into the call
// state machine described in the spec: idle -> calling/ringing ->
// connecting -> connected -> ended/rejected/failed/cancelled -> idle.
class VoiceCallController extends ChangeNotifier {
  VoiceCallController({required this.signaling, required Map<String, dynamic> iceServers})
      : _webrtc = WebRTCVoiceCallService(iceServers: iceServers) {
    _wireSignaling();
    _wireWebRtc();
  }

  final VoiceCallSignalingService signaling;
  final WebRTCVoiceCallService _webrtc;

  VoiceCall? _call;
  VoiceCall? get call => _call;
  CallState get state => _call?.state ?? CallState.idle;

  /// Set whenever a call ends abnormally; read this once (e.g. to show a
  /// SnackBar) after `state` has already returned to idle.
  VoiceCallError? lastError;

  Duration get duration => _webrtc.duration;
  bool get isMuted => _webrtc.isMuted;
  bool get isSpeakerOn => _webrtc.isSpeakerOn;

  /// Live remote inbound audio level (0.0-1.0), updated ~5x/second while
  /// connected. Drives the "receiving voice" indicator in the UI.
  double remoteAudioLevel = 0.0;

  Timer? _ringTimer;
  Object? _callAttempt;

  /// Reads and clears `lastError` in one step, for one-shot UI feedback
  /// (e.g. a SnackBar) that shouldn't repeat on the next rebuild.
  VoiceCallError? consumeError() {
    final error = lastError;
    lastError = null;
    return error;
  }

  void connect() => signaling.connect();

  void _wireSignaling() {
    signaling.onInvite.listen((data) {
      if (_call != null) return; // server already prevents this; stay defensive
      final callId = data['callId'] as String;
      final from = data['from'] as String;
      _log('Incoming call from $from');
      _call = VoiceCall(callId: callId, peerId: from, direction: CallDirection.incoming, state: CallState.ringing);
      notifyListeners();
    });

    signaling.onAccept.listen((data) async {
      if (!_matchesCurrentCall(data)) return;
      _setState(CallState.connecting);
      final offer = await _webrtc.createOffer();
      signaling.sendOffer(_call!.callId, offer);
    });

    signaling.onReject.listen((data) {
      if (!_matchesCurrentCall(data)) return;
      _log('Call ended');
      _fail(VoiceCallError.callRejected);
    });

    signaling.onCancel.listen((data) {
      if (!_matchesCurrentCall(data)) return;
      _log('Call ended');
      _fail(VoiceCallError.callCancelled);
    });

    signaling.onHangup.listen((data) {
      if (!_matchesCurrentCall(data)) return;
      _log('Call ended');
      _reset();
    });

    signaling.onOffer.listen((data) async {
      if (!_matchesCurrentCall(data)) return;
      final sdp = Map<String, dynamic>.from(data['sdp'] as Map);
      final answer = await _webrtc.createAnswer(sdp);
      signaling.sendAnswer(_call!.callId, answer);
    });

    signaling.onAnswer.listen((data) async {
      if (!_matchesCurrentCall(data)) return;
      final sdp = Map<String, dynamic>.from(data['sdp'] as Map);
      await _webrtc.applyAnswer(sdp);
    });

    signaling.onIceCandidate.listen((data) async {
      if (!_matchesCurrentCall(data)) return;
      final candidate = Map<String, dynamic>.from(data['candidate'] as Map);
      await _webrtc.addRemoteIceCandidate(candidate);
    });

    signaling.onFailed.listen((data) {
      if (!_matchesCurrentCall(data)) return;
      _fail(VoiceCallError.connectionFailed);
    });

    signaling.onError.listen((data) {
      final reason = data['reason'] as String?;
      lastError = _mapServerError(reason);
      if (reason == 'callee_offline' || reason == 'busy' || reason == 'self_call') {
        _reset();
      } else {
        notifyListeners();
      }
    });

    signaling.onConnectionChange.listen((connected) {
      if (!connected && _call != null) {
        lastError = VoiceCallError.webSocketDisconnected;
        _reset();
      }
    });
  }

  void _wireWebRtc() {
    _webrtc.onIceCandidate = (candidate) {
      if (_call == null) return;
      signaling.sendIceCandidate(_call!.callId, {
        'candidate': candidate.candidate,
        'sdpMid': candidate.sdpMid,
        'sdpMLineIndex': candidate.sdpMLineIndex,
      });
    };

    _webrtc.onConnectionState = (rtcState) {
      if (_call == null) return;
      switch (rtcState) {
        case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
          _log('Call connected');
          _setState(CallState.connected);
          signaling.notifyConnected(_call!.callId);
        case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
          signaling.notifyFailed(_call!.callId);
          _fail(VoiceCallError.iceFailed);
        default:
          break;
      }
    };

    _webrtc.onDurationTick = (_) => notifyListeners();
    _webrtc.onRemoteAudioLevel = (level) {
      remoteAudioLevel = level;
      notifyListeners();
    };
  }

  bool _matchesCurrentCall(Map<String, dynamic> data) => _call != null && data['callId'] == _call!.callId;

  /// Caller side: request a call. The UI shows "calling" optimistically;
  /// it's finalized (or torn back down) once the server responds.
  void startCall(String peerId) {
    if (_call != null || peerId.isEmpty) return;
    lastError = null;
    _log('Calling user $peerId');

    final attempt = Object();
    _callAttempt = attempt;
    _call = VoiceCall(callId: '', peerId: peerId, direction: CallDirection.outgoing, state: CallState.calling);
    notifyListeners();

    signaling.invite(peerId, (ack) {
      if (_callAttempt != attempt) return; // superseded by an error/reset already
      final callId = ack['callId'] as String?;
      if (callId == null) return; // rejection arrives separately via onError
      _call = VoiceCall(callId: callId, peerId: peerId, direction: CallDirection.outgoing, state: CallState.calling);
      _startRingTimeout();
      notifyListeners();
    });
  }

  void accept() {
    if (_call == null) return;
    signaling.accept(_call!.callId);
    _setState(CallState.connecting);
  }

  void reject() {
    if (_call == null) return;
    signaling.reject(_call!.callId);
    _reset();
  }

  /// Caller backing out before the callee answers.
  void cancel() {
    if (_call == null) return;
    signaling.cancel(_call!.callId);
    _reset();
  }

  void hangUp() {
    if (_call == null) return;
    signaling.hangup(_call!.callId);
    _log('Call ended');
    _reset();
  }

  void toggleMute() {
    _webrtc.toggleMute();
    notifyListeners();
  }

  Future<void> toggleSpeaker() async {
    await _webrtc.toggleSpeaker();
    notifyListeners();
  }

  void _startRingTimeout() {
    _ringTimer?.cancel();
    _ringTimer = Timer(_ringTimeout, () {
      if (_call?.state == CallState.calling) {
        lastError = VoiceCallError.timeout;
        cancel();
      }
    });
  }

  void _setState(CallState newState) {
    if (_call == null) return;
    _call = _call!.copyWith(state: newState);
    notifyListeners();
  }

  void _fail(VoiceCallError error) {
    lastError = error;
    _reset();
  }

  /// Stops local audio, closes the peer connection, clears SDP/ICE state,
  /// and returns the state machine to idle. Safe to call from any state.
  void _reset() {
    _ringTimer?.cancel();
    _callAttempt = null;
    unawaited(_webrtc.close());
    _call = null;
    remoteAudioLevel = 0.0;
    notifyListeners();
  }

  VoiceCallError _mapServerError(String? reason) {
    switch (reason) {
      case 'callee_offline':
      case 'busy':
        return VoiceCallError.calleeUnavailable;
      default:
        return VoiceCallError.unknown;
    }
  }

  void _log(String message) => debugPrint('[CALL] $message');

  @override
  void dispose() {
    _ringTimer?.cancel();
    unawaited(_webrtc.close());
    signaling.dispose();
    super.dispose();
  }
}
