import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/message_hold_feedback.dart';

void main() {
  testWidgets('message gives visual feedback while held', (tester) async {
    final menuCompleter = Completer<void>();
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: MessageHoldFeedback(
            onLongPressStart: (_) => menuCompleter.future,
            child: const SizedBox(width: 160, height: 80),
          ),
        ),
      ),
    );

    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(MessageHoldFeedback)),
    );
    await tester.pump(const Duration(milliseconds: 100));

    expect(
      tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale,
      MessageHoldFeedback.pressedScale,
    );
    expect(
      tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity,
      MessageHoldFeedback.pressedOpacity,
    );

    await tester.pump(const Duration(milliseconds: 600));
    await gesture.up();
    await tester.pump();

    expect(
      tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale,
      MessageHoldFeedback.pressedScale,
    );

    menuCompleter.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale, 1);
    expect(
      tester.widget<AnimatedOpacity>(find.byType(AnimatedOpacity)).opacity,
      1,
    );
  });

  testWidgets('horizontal drags do not move the message or show reply UI', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: MessageHoldFeedback(
            onLongPressStart: (_) async {},
            child: const SizedBox(
              key: ValueKey('message'),
              width: 160,
              height: 80,
            ),
          ),
        ),
      ),
    );

    final message = find.byKey(const ValueKey('message'));
    final before = tester.getTopLeft(message);
    await tester.drag(find.byType(MessageHoldFeedback), const Offset(120, 0));
    await tester.pump();

    expect(tester.getTopLeft(message), before);
    expect(find.byIcon(Icons.reply_outlined), findsNothing);
  });
}
