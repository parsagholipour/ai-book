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
}
