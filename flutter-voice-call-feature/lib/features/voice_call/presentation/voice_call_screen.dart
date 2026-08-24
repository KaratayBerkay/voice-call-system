import 'package:flutter/material.dart';

import '../domain/voice_call_controller.dart';
import '../models/voice_call.dart';

// Minimal test UI for VoiceCallController. Not meant to be the final design
// -- it exists to exercise and verify the calling flow end to end.
class VoiceCallScreen extends StatefulWidget {
  const VoiceCallScreen({super.key, required this.controller, required this.currentUserId});

  final VoiceCallController controller;
  final String currentUserId;

  @override
  State<VoiceCallScreen> createState() => _VoiceCallScreenState();
}

class _VoiceCallScreenState extends State<VoiceCallScreen> {
  final _peerIdController = TextEditingController();

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onControllerChanged);
    widget.controller.connect();
  }

  void _onControllerChanged() {
    final error = widget.controller.consumeError();
    if (error != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_errorMessage(error))));
    }
    if (mounted) setState(() {});
  }

  String _errorMessage(VoiceCallError error) {
    switch (error) {
      case VoiceCallError.microphonePermissionDenied:
        return 'Microphone permission denied';
      case VoiceCallError.webSocketDisconnected:
        return 'Disconnected from the signaling server';
      case VoiceCallError.calleeUnavailable:
        return 'User is offline or busy';
      case VoiceCallError.callRejected:
        return 'Call rejected';
      case VoiceCallError.callCancelled:
        return 'Call cancelled';
      case VoiceCallError.iceFailed:
        return 'Connection failed (ICE)';
      case VoiceCallError.connectionFailed:
        return 'Connection failed';
      case VoiceCallError.remotePeerDisconnected:
        return 'The other user disconnected';
      case VoiceCallError.timeout:
        return 'No answer';
      case VoiceCallError.unknown:
        return 'Call error';
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    _peerIdController.dispose();
    super.dispose();
  }

  String _formatDuration(Duration d) {
    final minutes = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return '$minutes:$seconds';
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    if (c.state == CallState.idle) return _buildDialScreen(context, c);
    return _buildCallScreen(context, c);
  }

  // --- Idle: a plain dial screen to pick who to call. ---
  Widget _buildDialScreen(BuildContext context, VoiceCallController c) {
    return Scaffold(
      appBar: AppBar(title: const Text('Voice Call')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Current User: ${widget.currentUserId}', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 24),
            TextField(
              controller: _peerIdController,
              decoration: const InputDecoration(labelText: 'User ID'),
            ),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: () {
                final peerId = _peerIdController.text.trim();
                _peerIdController.clear();
                c.startCall(peerId);
              },
              icon: const Icon(Icons.call),
              label: const Text('Call'),
            ),
          ],
        ),
      ),
    );
  }

  // --- Calling/ringing/connecting/connected: a full-screen call UI. ---
  Widget _buildCallScreen(BuildContext context, VoiceCallController c) {
    final peerId = c.call?.peerId ?? '';
    final initial = peerId.isNotEmpty ? peerId[0].toUpperCase() : '?';

    String statusText;
    switch (c.state) {
      case CallState.calling:
        statusText = 'Calling...';
      case CallState.ringing:
        statusText = 'Incoming call...';
      case CallState.connecting:
        statusText = 'Connecting...';
      case CallState.connected:
        statusText = _formatDuration(c.duration);
      default:
        statusText = '';
    }

    return Scaffold(
      body: Container(
        width: double.infinity,
        height: double.infinity,
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF0B3D36), Color(0xFF075E54), Color(0xFF041E1B)],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              const SizedBox(height: 24),
              Text(
                statusText,
                style: const TextStyle(color: Colors.white70, fontSize: 16, letterSpacing: 0.5),
              ),
              const Spacer(),
              _PulsingAvatar(initial: initial, level: c.state == CallState.connected ? c.remoteAudioLevel : 0),
              const SizedBox(height: 20),
              Text(
                peerId,
                style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w500),
              ),
              const SizedBox(height: 28),
              if (c.state == CallState.connected) _AudioLevelBar(level: c.remoteAudioLevel),
              const Spacer(),
              _buildControls(c),
              const SizedBox(height: 48),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildControls(VoiceCallController c) {
    switch (c.state) {
      case CallState.calling:
      case CallState.connecting:
        return _CallActionButton(
          icon: Icons.call_end,
          label: 'Cancel',
          color: Colors.red,
          large: true,
          onTap: c.state == CallState.calling ? c.cancel : c.hangUp,
        );
      case CallState.ringing:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _CallActionButton(
              icon: Icons.call_end,
              label: 'Decline',
              color: Colors.red,
              onTap: c.reject,
            ),
            _CallActionButton(
              icon: Icons.call,
              label: 'Accept',
              color: Colors.green,
              onTap: c.accept,
            ),
          ],
        );
      case CallState.connected:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _ToggleActionButton(
              icon: c.isMuted ? Icons.mic_off : Icons.mic,
              label: c.isMuted ? 'Unmute' : 'Mute',
              active: c.isMuted,
              onTap: c.toggleMute,
            ),
            _CallActionButton(
              icon: Icons.call_end,
              label: 'End',
              color: Colors.red,
              large: true,
              onTap: c.hangUp,
            ),
            _ToggleActionButton(
              icon: c.isSpeakerOn ? Icons.volume_up : Icons.hearing,
              label: c.isSpeakerOn ? 'Speaker' : 'Earpiece',
              active: c.isSpeakerOn,
              onTap: c.toggleSpeaker,
            ),
          ],
        );
      default:
        return const SizedBox.shrink();
    }
  }
}

// Avatar with a soft ring that pulses outward with the remote audio level --
// the "mic is getting voice from the server" indicator.
class _PulsingAvatar extends StatelessWidget {
  const _PulsingAvatar({required this.initial, required this.level});

  final String initial;
  final double level;

  static const _avatarSize = 140.0;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: _avatarSize + 60,
      height: _avatarSize + 60,
      child: Stack(
        alignment: Alignment.center,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: _avatarSize + 60 * level,
            height: _avatarSize + 60 * level,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Colors.white.withValues(alpha: 0.08 + 0.10 * level),
            ),
          ),
          AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: _avatarSize + 24 * level,
            height: _avatarSize + 24 * level,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Colors.white.withValues(alpha: 0.12 + 0.15 * level),
            ),
          ),
          Container(
            width: _avatarSize,
            height: _avatarSize,
            decoration: const BoxDecoration(shape: BoxShape.circle, color: Colors.white24),
            alignment: Alignment.center,
            child: Text(
              initial,
              style: const TextStyle(color: Colors.white, fontSize: 56, fontWeight: FontWeight.w500),
            ),
          ),
        ],
      ),
    );
  }
}

// The literal "progress bar" that fills with the remote audio level, so it's
// visually obvious when the other person's voice is actually arriving.
class _AudioLevelBar extends StatelessWidget {
  const _AudioLevelBar({required this.level});

  final double level;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 56),
      child: Row(
        children: [
          const Icon(Icons.graphic_eq, color: Colors.white70, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: TweenAnimationBuilder<double>(
                tween: Tween(begin: 0, end: level),
                duration: const Duration(milliseconds: 150),
                builder: (context, value, _) => LinearProgressIndicator(
                  value: value.clamp(0.0, 1.0),
                  minHeight: 6,
                  backgroundColor: Colors.white.withValues(alpha: 0.15),
                  valueColor: const AlwaysStoppedAnimation(Colors.greenAccent),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CallActionButton extends StatelessWidget {
  const _CallActionButton({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
    this.large = false,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final size = large ? 72.0 : 60.0;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: color,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(
              width: size,
              height: size,
              child: Icon(icon, color: Colors.white, size: large ? 32 : 26),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: const TextStyle(color: Colors.white70, fontSize: 13)),
      ],
    );
  }
}

class _ToggleActionButton extends StatelessWidget {
  const _ToggleActionButton({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: active ? Colors.white : Colors.white24,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: SizedBox(
              width: 60,
              height: 60,
              child: Icon(icon, color: active ? const Color(0xFF075E54) : Colors.white, size: 26),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: const TextStyle(color: Colors.white70, fontSize: 13)),
      ],
    );
  }
}
