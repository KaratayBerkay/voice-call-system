import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';

typedef IceCandidateCallback = void Function(RTCIceCandidate candidate);
typedef ConnectionStateCallback = void Function(RTCPeerConnectionState state);

class MicPermissionDeniedException implements Exception {
  const MicPermissionDeniedException();
  @override
  String toString() => 'Microphone permission denied';
}

// Pure WebRTC mechanics for a single 1-to-1 audio call. Knows nothing about
// call invites/accept/reject/state -- that's VoiceCallSignalingService's and
// the orchestrating controller's job. This class only ever touches the
// RTCPeerConnection itself.
class WebRTCVoiceCallService {
  WebRTCVoiceCallService({required Map<String, dynamic> iceServers}) : _iceServers = iceServers;

  final Map<String, dynamic> _iceServers;

  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  Timer? _durationTimer;

  // ICE candidates can arrive from signaling before the remote description
  // is set (the other side may start trickling candidates before this
  // side has finished processing the offer/answer) -- buffer and flush
  // rather than silently dropping them.
  bool _remoteDescriptionSet = false;
  final List<Map<String, dynamic>> _pendingCandidates = [];

  IceCandidateCallback? onIceCandidate;
  ConnectionStateCallback? onConnectionState;
  void Function(Duration duration)? onDurationTick;

  /// Fires roughly 5x/second while connected with the remote inbound audio
  /// level (0.0-1.0, from WebRTC's own stats), so the UI can show a live
  /// "is the other person's voice actually arriving" indicator.
  void Function(double level)? onRemoteAudioLevel;
  Timer? _audioLevelTimer;

  bool _muted = false;
  bool get isMuted => _muted;

  bool _speakerOn = true;
  bool get isSpeakerOn => _speakerOn;

  Duration _duration = Duration.zero;
  Duration get duration => _duration;

  Future<void> _ensureMicPermission() async {
    final status = await Permission.microphone.request();
    if (!status.isGranted) throw const MicPermissionDeniedException();
  }

  Future<void> _createPeerConnection() async {
    _log('Creating peer connection');
    final pc = await createPeerConnection(_iceServers);
    pc.onIceCandidate = (candidate) => onIceCandidate?.call(candidate);
    pc.onConnectionState = (state) {
      _log('Connection state: ${state.name}');
      onConnectionState?.call(state);
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _startDurationTimer();
        _startAudioLevelPolling();
      }
    };
    _pc = pc;
  }

  void _startAudioLevelPolling() {
    _audioLevelTimer?.cancel();
    _audioLevelTimer = Timer.periodic(const Duration(milliseconds: 200), (_) async {
      final pc = _pc;
      if (pc == null) return;
      try {
        final reports = await pc.getStats();
        for (final report in reports) {
          if (report.type != 'inbound-rtp') continue;
          final kind = report.values['kind'] ?? report.values['mediaType'];
          final level = report.values['audioLevel'];
          if (kind == 'audio' && level is num) {
            onRemoteAudioLevel?.call(level.toDouble().clamp(0.0, 1.0));
          }
        }
      } catch (e) {
        _log('getStats error: $e');
      }
    });
  }

  Future<void> _attachMicrophone() async {
    await _ensureMicPermission();
    _localStream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': false});
    for (final track in _localStream!.getTracks()) {
      await _pc!.addTrack(track, _localStream!);
    }
  }

  /// Caller side: create the connection, attach the mic, and produce an
  /// SDP offer to send to the callee.
  Future<Map<String, dynamic>> createOffer() async {
    await _createPeerConnection();
    await _attachMicrophone();
    _log('Creating offer');
    final offer = await _pc!.createOffer({'offerToReceiveAudio': 1});
    await _pc!.setLocalDescription(offer);
    return {'sdp': offer.sdp, 'type': offer.type};
  }

  /// Callee side: create the connection, attach the mic, apply the caller's
  /// offer, and produce an SDP answer to send back.
  Future<Map<String, dynamic>> createAnswer(Map<String, dynamic> remoteOffer) async {
    await _createPeerConnection();
    await _attachMicrophone();
    await _pc!.setRemoteDescription(
      RTCSessionDescription(remoteOffer['sdp'] as String, remoteOffer['type'] as String),
    );
    await _flushPendingCandidates();
    final answer = await _pc!.createAnswer({'offerToReceiveAudio': 1});
    await _pc!.setLocalDescription(answer);
    return {'sdp': answer.sdp, 'type': answer.type};
  }

  /// Caller side: apply the callee's answer once it arrives.
  Future<void> applyAnswer(Map<String, dynamic> remoteAnswer) async {
    _log('Received answer');
    await _pc?.setRemoteDescription(
      RTCSessionDescription(remoteAnswer['sdp'] as String, remoteAnswer['type'] as String),
    );
    await _flushPendingCandidates();
  }

  Future<void> addRemoteIceCandidate(Map<String, dynamic> candidate) async {
    if (_pc == null || !_remoteDescriptionSet) {
      _pendingCandidates.add(candidate);
      return;
    }
    await _applyCandidate(candidate);
  }

  Future<void> _flushPendingCandidates() async {
    _remoteDescriptionSet = true;
    for (final candidate in _pendingCandidates) {
      await _applyCandidate(candidate);
    }
    _pendingCandidates.clear();
  }

  Future<void> _applyCandidate(Map<String, dynamic> candidate) async {
    _log('ICE candidate');
    await _pc!.addCandidate(
      RTCIceCandidate(
        candidate['candidate'] as String?,
        candidate['sdpMid'] as String?,
        candidate['sdpMLineIndex'] as int?,
      ),
    );
  }

  void toggleMute() {
    if (_localStream == null) return;
    _muted = !_muted;
    for (final track in _localStream!.getAudioTracks()) {
      track.enabled = !_muted;
    }
  }

  Future<void> toggleSpeaker() async {
    _speakerOn = !_speakerOn;
    await Helper.setSpeakerphoneOn(_speakerOn);
  }

  void _startDurationTimer() {
    _durationTimer?.cancel();
    _duration = Duration.zero;
    _durationTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      _duration += const Duration(seconds: 1);
      onDurationTick?.call(_duration);
    });
  }

  /// Stops local audio, closes the peer connection, and clears all
  /// SDP/ICE state. Safe to call multiple times.
  Future<void> close() async {
    _durationTimer?.cancel();
    _durationTimer = null;
    _audioLevelTimer?.cancel();
    _audioLevelTimer = null;
    onRemoteAudioLevel?.call(0.0);
    _duration = Duration.zero;
    _muted = false;
    _speakerOn = true;
    _remoteDescriptionSet = false;
    _pendingCandidates.clear();

    await _pc?.close();
    _pc = null;

    for (final track in _localStream?.getTracks() ?? const <MediaStreamTrack>[]) {
      await track.stop();
    }
    await _localStream?.dispose();
    _localStream = null;
  }

  void _log(String message) => debugPrint('[WEBRTC] $message');
}
