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

  Future<int> swipeBy(WidgetTester tester, double dx) async {
    var replies = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: MessageHoldFeedback(
            onLongPressStart: (_) async {},
            onSwipeReply: () => replies++,
            child: const SizedBox(width: 160, height: 80),
          ),
        ),
      ),
    );
    await tester.drag(find.byType(MessageHoldFeedback), Offset(dx, 0));
    await tester.pumpAndSettle();
    return replies;
  }

  testWidgets('swiping past the threshold starts a reply', (tester) async {
    expect(
      await swipeBy(tester, MessageHoldFeedback.swipeReplyThreshold + 12),
      1,
    );
  });

  testWidgets('a short swipe springs back without replying', (tester) async {
    expect(
      await swipeBy(tester, MessageHoldFeedback.swipeReplyThreshold - 12),
      0,
    );
  });

  testWidgets('swiping the other way never replies', (tester) async {
    expect(
      await swipeBy(tester, -(MessageHoldFeedback.swipeReplyThreshold + 40)),
      0,
    );
  });

  testWidgets('no reply handler means no drag at all', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: MessageHoldFeedback(
            onLongPressStart: (_) async {},
            child: const SizedBox(width: 160, height: 80),
          ),
        ),
      ),
    );

    await tester.drag(find.byType(MessageHoldFeedback), const Offset(120, 0));
    await tester.pump();

    expect(find.byIcon(Icons.reply_outlined), findsNothing);
  });
}
