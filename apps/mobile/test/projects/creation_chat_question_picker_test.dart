import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// A question several options can answer says how it is answered, and keeps count
// of what has been picked so far.

void main() {
  testWidgets('a multi question names its rule and counts the picks', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(replyWithMultiQuestion: true);
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Tales for children');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('Pick as many as you like.'), findsOneWidget);
    expect(find.textContaining('selected'), findsNothing);
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Send answer'),
          )
          .onPressed,
      isNull,
    );

    await tester.ensureVisible(find.text('Forgiveness'));
    await tester.tap(find.text('Forgiveness'));
    await tester.pump();
    expect(find.text('1 selected'), findsOneWidget);

    await tester.ensureVisible(find.text('Patience'));
    await tester.tap(find.text('Patience'));
    await tester.pump();
    expect(find.text('2 selected'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Send 2 answers'), findsOneWidget);

    // Tapping a pick again takes it back.
    await tester.ensureVisible(find.text('Forgiveness'));
    await tester.tap(find.text('Forgiveness'));
    await tester.pump();
    expect(find.text('1 selected'), findsOneWidget);

    await tester.teardownScreen();
  });
}
