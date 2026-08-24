import 'package:flutter/material.dart';
import 'package:voice_call_feature/features/voice_call/domain/voice_call_controller.dart';
import 'package:voice_call_feature/features/voice_call/presentation/voice_call_screen.dart';
import 'package:voice_call_feature/features/voice_call/services/voice_call_signaling_service.dart';

// Test-only config pointing at the signaling + TURN services running on the
// dev machine. The placeholder AuthService on the backend trusts the raw
// token as the user id, so entering "alice" both identifies this client and
// authenticates it as user "alice" -- a real app would use its actual login
// token here instead.
const _signalingBaseUrl = 'http://10.10.2.51:3001';
final _iceServers = <String, dynamic>{
  'iceServers': [
    {'urls': 'stun:stun.l.google.com:19302'},
    {
      'urls': 'turn:10.10.2.51:3480',
      'username': 'testuser',
      'credential': 'testpass',
    },
  ],
};

void main() {
  runApp(const TestApp());
}

class TestApp extends StatelessWidget {
  const TestApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Voice Call Test',
      theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
      home: const LoginScreen(),
    );
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _userIdController = TextEditingController();

  void _signIn() {
    final userId = _userIdController.text.trim();
    if (userId.isEmpty) return;

    final controller = VoiceCallController(
      signaling: VoiceCallSignalingService(baseUrl: _signalingBaseUrl, authToken: userId),
      iceServers: _iceServers,
    );

    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => VoiceCallScreen(controller: controller, currentUserId: userId),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Voice Call Test')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _userIdController,
              decoration: const InputDecoration(labelText: 'User ID'),
            ),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _signIn, child: const Text('Sign in')),
          ],
        ),
      ),
    );
  }
}
