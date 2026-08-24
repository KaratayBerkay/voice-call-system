import 'package:flutter_test/flutter_test.dart';

import 'package:voice_call_test_app/main.dart';

void main() {
  testWidgets('renders the sign-in screen', (WidgetTester tester) async {
    await tester.pumpWidget(const TestApp());

    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('User ID'), findsOneWidget);
  });
}
