import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/projects/presentation/chat_assistant_avatar.dart';
import 'package:tomeza/features/projects/presentation/chat_thinking_bubble.dart';

Widget _host(Widget child, {bool disableAnimations = false}) => MaterialApp(
  theme: buildTomezaLightTheme(),
  builder: (context, home) => MediaQuery(
    data: MediaQuery.of(context).copyWith(disableAnimations: disableAnimations),
    child: home!,
  ),
  home: Scaffold(body: child),
);

void main() {
  testWidgets('says what it is doing and moves on to later stages', (
    tester,
  ) async {
    await tester.pumpWidget(_host(const ChatThinkingBubble()));
    expect(find.text('Thinking…'), findsOneWidget);

    await tester.pump(const Duration(seconds: 4));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Thinking about your book…'), findsOneWidget);

    // Settles on the last stage instead of wrapping around.
    await tester.pump(const Duration(seconds: 20));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Almost there…'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('wears the assistant avatar only when asked to', (tester) async {
    await tester.pumpWidget(_host(const ChatThinkingBubble()));
    expect(find.byType(ChatAssistantAvatar), findsNothing);

    await tester.pumpWidget(_host(const ChatThinkingBubble(showAvatar: true)));
    expect(find.byType(ChatAssistantAvatar), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('holds still when the platform asks for reduced motion', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(const ChatThinkingBubble(), disableAnimations: true),
    );
    // Nothing is animating, so the frame queue drains instead of running on.
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse);

    await tester.pumpWidget(const SizedBox());
  });
}
