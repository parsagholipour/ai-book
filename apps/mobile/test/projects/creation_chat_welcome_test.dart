import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_helpers.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The blank page: what a brand-new chat says before anyone has typed, and the
// moment it gives way to the conversation.

const _welcome = ValueKey('creation-welcome');

void main() {
  testWidgets(
    'a new chat opens on the welcome, ideas first, nothing to build',
    (tester) async {
      final creation = ScriptedCreationRepository()
        ..greetingQuickReplies = const ['A kids book', 'A workbook'];
      await tester.pumpWidget(app(creation: creation));
      await tester.pumpAndSettle();

      expect(find.byKey(_welcome), findsOneWidget);
      expect(find.text('Turn an idea into a book'), findsOneWidget);
      // The assistant's own greeting leads, once, and the ideas are offered as
      // cards rather than a second row of chips under the composer.
      expect(find.text(greeting), findsOneWidget);
      expect(find.text('A kids book'), findsOneWidget);
      expect(find.byType(ActionChip), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Build the plan'), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).decoration?.hintText,
        'Describe your book…',
      );

      await tester.teardownScreen();
    },
  );

  testWidgets('tapping an idea starts the chat and the welcome steps aside', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    expect(creation.startedMessages, ['A kids book']);
    expect(find.byKey(_welcome), findsNothing);
    expect(find.text(reply), findsOneWidget);
    // Now there is something to build, and the button has arrived.
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a saved chat never shows the welcome, however short it is', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [chatSession(draftId: 'draft-a', title: 'Saved')],
    );
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-a'));
    await tester.pumpAndSettle();

    expect(find.byKey(_welcome), findsNothing);
    expect(find.text('Selected chat draft-a'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('the tips do what they say: @ types one, attach opens the sheet', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    final mentionTip = find.text(
      'Type @ to bring a saved character into your book.',
    );
    await tester.ensureVisible(mentionTip);
    await tester.tap(mentionTip);
    // Pumped, not settled: the suggestion strip waits on the character library.
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller?.text,
      '@',
    );

    final attachTip = find.text(
      'Add notes, a document or a photo and I read it first.',
    );
    await tester.ensureVisible(attachTip);
    await tester.tap(attachTip);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Photo library'), findsOneWidget);
  });

  test('the built-in examples are said by the person making the book', () {
    // "Bedtime story for 5 year olds" read, to a store reviewer, as an app
    // aimed at children. The maker of a bedtime story is a parent.
    final ideas = creationChatLocalGreetingTurn.quickReplies;
    expect(ideas, contains('A bedtime story for my 5-year-old'));
    for (final idea in ideas) {
      expect(
        idea,
        isNot(matches(RegExp(r'for \d+ ?year olds', caseSensitive: false))),
      );
    }
  });
}
