import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';
import 'package:tomeza/features/projects/presentation/chat_thinking_bubble.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/pending_chat_sessions.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

void main() {
  testWidgets('greeting and quick replies render; build is gated until ready', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.text(greeting), findsOneWidget);
    expect(find.text('A kids book'), findsOneWidget);
    expect(creation.startedMessages, isEmpty);

    final buildFinder = find.widgetWithText(FilledButton, 'Build the plan');
    expect(tester.widget<FilledButton>(buildFinder).onPressed, isNull);

    await tester.teardownScreen();
  });

  testWidgets('quick reply chips scroll; only an edge swipe opens the drawer', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository()
      ..greetingQuickReplies = const [
        'Bedtime story for 5 year olds',
        'Lead magnet about pricing',
        'Workbook for new coaches',
        'Short story about a garden mystery',
      ];
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    // A horizontal drag on the chip row scrolls the chips instead of being
    // captured by the drawer's full-screen gesture layer.
    final firstChip = find.widgetWithText(
      ActionChip,
      'Bedtime story for 5 year olds',
    );
    final chipLeftBefore = tester.getTopLeft(firstChip).dx;
    await tester.drag(firstChip, const Offset(-250, 0));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(firstChip).dx, lessThan(chipLeftBefore));
    expect(find.byType(ChatHistoryDrawer), findsNothing);

    // A swipe from the screen's start edge still opens the chat history.
    await tester.dragFrom(const Offset(4, 300), const Offset(300, 0));
    await tester.pumpAndSettle();
    expect(find.byType(ChatHistoryDrawer), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('replying enables build and records the message', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    expect(creation.startedMessages, contains('A kids book'));
    expect(creation.sentMessages, contains('A kids book'));
    expect(find.text(reply), findsOneWidget);
    await tester.tap(find.text('Book brief'));
    await tester.pumpAndSettle();
    expect(find.text('Cover: Included'), findsOneWidget);
    expect(find.text('Illustrations: Included'), findsOneWidget);

    final buildFinder = find.widgetWithText(FilledButton, 'Build the plan');
    expect(tester.widget<FilledButton>(buildFinder).onPressed, isNotNull);

    await tester.teardownScreen();
  });

  testWidgets('holding a message shows a copy option', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.longPress(find.text(greeting));
    await tester.pumpAndSettle();

    expect(find.text('Copy'), findsOneWidget);

    String? copiedText;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          final arguments = call.arguments as Map<Object?, Object?>;
          copiedText = arguments['text'] as String?;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );

    await tester.tap(find.text('Copy'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump();

    expect(copiedText, greeting);
    expect(find.text('Message copied'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('grounded creation answers render tappable web sources', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [chatSession(draftId: 'research-chat', title: 'Research chat')],
    );
    creation.resumeMessages['research-chat'] = const [
      {
        'role': 'assistant',
        'content': 'A recent exoplanet discovery is a strong topic.',
        'research': {
          'query': 'recent exoplanet discovery',
          'summary': 'Grounded summary',
          'sources': [
            {
              'title': 'NASA Science',
              'url': 'https://science.nasa.gov/example',
              'summary': 'NASA explains the discovery.',
            },
            {
              'title': 'Grounded note',
              'summary': 'A source without a public URL.',
            },
          ],
        },
      },
    ];
    await tester.pumpWidget(app(creation: creation, draftId: 'research-chat'));
    await tester.pumpAndSettle();

    expect(find.text('Sources'), findsOneWidget);
    expect(find.textContaining('NASA Science'), findsOneWidget);
    expect(find.textContaining('science.nasa.gov'), findsOneWidget);
    expect(find.textContaining('Grounded note'), findsOneWidget);
    final links = tester
        .widgetList<Semantics>(find.byType(Semantics))
        .where((widget) => widget.properties.link == true);
    expect(links.length, 1);

    final sourceSemantics = tester.widgetList<Semantics>(
      find.ancestor(
        of: find.textContaining('NASA Science'),
        matching: find.byType(Semantics),
      ),
    );
    expect(
      sourceSemantics.any(
        (widget) =>
            widget.properties.link == true &&
            (widget.properties.label ?? '').contains('science.nasa.gov'),
      ),
      isTrue,
    );

    await tester.teardownScreen();
  });

  test('creation research parsing stays backward compatible', () {
    final legacy = MobileCreationMessage.fromJson(const {
      'role': 'assistant',
      'content': 'Legacy answer',
    });
    final grounded = MobileCreationMessage.fromJson(const {
      'role': 'assistant',
      'content': 'Grounded answer',
      'research': {
        'query': 'current topic',
        'summary': 'Summary',
        'sources': [
          {
            'title': 'Example',
            'url': 'https://example.com/source',
            'summary': 'Evidence',
          },
          {
            'title': 'Unsafe URL',
            'url': 'javascript:alert(1)',
            'summary': 'Not tappable',
          },
        ],
      },
    });

    expect(legacy.research, isNull);
    expect(grounded.research?.sources, hasLength(2));
    expect(grounded.research?.sources.first.uri?.host, 'example.com');
    expect(grounded.research?.sources.last.uri, isNull);
  });

  testWidgets('replying quotes the message and sends it with the reply', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    // The greeting is a local turn the server has never seen, so there is
    // nothing to quote until a real exchange exists.
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText(reply));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();

    // The composer says what it is attached to, and — unlike an edit — leaves
    // whatever is typed alone.
    expect(find.text('Replying to the assistant'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'The second one');
    // The send button enables on the frame the typed text lands in.
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages.last, 'The second one');
    expect(creation.replyRequests.last, 'assistant-reply');
    expect(creation.editRequests, isEmpty);
    // The banner is for the next message only.
    expect(find.text('Replying to the assistant'), findsNothing);
    // The sent bubble carries the quote above its own text.
    expect(find.text('Assistant'), findsOneWidget);
    expect(bubbleText('The second one'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('cancelling a reply sends the message unquoted', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText(reply));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Cancel reply'));
    await tester.pumpAndSettle();

    expect(find.text('Replying to the assistant'), findsNothing);

    await tester.enterText(find.byType(TextField).first, 'Make it shorter');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    // It really sent — an unsent message would also report a null reply.
    expect(creation.sentMessages.last, 'Make it shorter');
    expect(creation.replyRequests.last, isNull);

    await tester.teardownScreen();
  });

  testWidgets('the reply banner scrolls to its message after moving away', (
    tester,
  ) async {
    const draftId = 'long-reply-chat';
    final creation = ScriptedCreationRepository(
      sessions: [chatSession(draftId: draftId, title: 'Long reply chat')],
    );
    creation.resumeMessages[draftId] = [
      for (var index = 0; index < 40; index++)
        {
          'id': 'history-$index',
          'role': index.isEven ? 'user' : 'assistant',
          'content': 'History message $index',
        },
    ];
    await tester.pumpWidget(app(creation: creation, draftId: draftId));
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText('History message 39'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();

    final transcript = tester
        .widgetList<ListView>(find.byType(ListView))
        .firstWhere(
          (list) =>
              list.scrollDirection == Axis.vertical &&
              list.controller?.hasClients == true &&
              list.controller!.position.maxScrollExtent > 0,
        );
    final position = transcript.controller!.position;
    expect(find.byTooltip('Go to replied message'), findsOneWidget);

    position.jumpTo(position.minScrollExtent);
    await tester.pump();
    expect(position.pixels, position.minScrollExtent);

    await tester.tap(find.byTooltip('Go to replied message'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(position.pixels, greaterThan(position.maxScrollExtent * 0.8));
    await tester.teardownScreen();
  });

  testWidgets('starting an edit drops a pending reply', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.longPress(bubbleText(reply));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reply'));
    await tester.pumpAndSettle();
    expect(find.text('Replying to the assistant'), findsOneWidget);

    // The two modes share one composer, so the strip can never show both.
    await tester.longPress(bubbleText('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    expect(find.text('Editing message'), findsOneWidget);
    expect(find.text('Replying to the assistant'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('editing a sent message forks a branch with arrows', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    // Long-press the sent user bubble and pick Edit. (The session title also
    // echoes the message, so scope the lookup to the transcript list.)
    await tester.longPress(bubbleText('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    // The composer switches into edit mode with the original text loaded.
    expect(find.text('Editing message'), findsOneWidget);
    final composer = tester.widget<TextField>(find.byType(TextField).first);
    expect(composer.controller?.text, 'A kids book');
    expect(composer.focusNode?.hasFocus, isTrue);

    await tester.enterText(find.byType(TextField).first, 'A space adventure');
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    // The edit was sent as a fork of the original message.
    expect(creation.editRequests, ['user-current']);
    expect(creation.sentMessages.last, 'A space adventure');
    expect(find.text('Editing message'), findsNothing);
    expect(bubbleText('A space adventure'), findsOneWidget);
    expect(bubbleText('A kids book'), findsNothing);
    expect(find.text('2/2'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('branch arrows switch back to the previous thread', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.longPress(bubbleText('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'A space adventure');
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Previous branch'));
    await tester.pumpAndSettle();

    expect(creation.branchSwitches, hasLength(1));
    expect(creation.branchSwitches.single.messageId, 'user-current');
    expect(creation.branchSwitches.single.direction, 'previous');
    // The original thread is visible again with its branch position.
    expect(bubbleText('A kids book'), findsOneWidget);
    expect(bubbleText('A space adventure'), findsNothing);
    expect(find.text('1/2'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('cancelling an edit restores the normal composer', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.longPress(bubbleText('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();
    expect(find.text('Editing message'), findsOneWidget);

    await tester.tap(find.byTooltip('Cancel edit'));
    await tester.pumpAndSettle();

    expect(find.text('Editing message'), findsNothing);
    final composer = tester.widget<TextField>(find.byType(TextField).first);
    expect(composer.controller?.text, isEmpty);
    expect(creation.editRequests, isEmpty);

    await tester.teardownScreen();
  });

  testWidgets(
    'advanced sheet overrides the book type with a Your choice badge',
    (tester) async {
      final creation = ScriptedCreationRepository();
      await tester.pumpWidget(app(creation: creation));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Advanced settings'));
      await tester.pumpAndSettle();

      expect(find.text('Advanced settings'), findsOneWidget);
      expect(find.text('Auto'), findsWidgets);
      await tester.tap(find.byKey(const ValueKey('book-type-auto')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Workbook').last);
      await tester.pumpAndSettle();

      expect(find.text('Your choice'), findsWidgets);

      final doneButton = find.widgetWithText(FilledButton, 'Done');
      await tester.ensureVisible(doneButton);
      await tester.tap(doneButton);
      await tester.pumpAndSettle();

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'advanced sheet defaults pages to Auto and accepts Custom pages',
    (tester) async {
      final creation = ScriptedCreationRepository();
      await tester.pumpWidget(app(creation: creation));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Advanced settings'));
      await tester.pumpAndSettle();

      expect(find.text('Pages'), findsWidgets);
      expect(find.text('Auto'), findsWidgets);

      await tester.tap(find.text('Custom').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.widgetWithText(TextField, 'Pages'), '14');
      await tester.pumpAndSettle();

      // A live package-cost estimate appears for the entered page count,
      // matching the plan-approval estimator exactly.
      final expected14 = estimateProjectCredits(
        bookType: 'lead_magnet',
        qualityPreset: 'balanced',
        coverEnabled: true,
        illustrationsEnabled: true,
        targetPages: 14,
        creditCosts: const {},
      );
      expect(
        find.textContaining('≈ $expected14 credits for 14 pages'),
        findsOneWidget,
      );

      final doneButton = find.widgetWithText(FilledButton, 'Done');
      await tester.ensureVisible(doneButton);
      await tester.tap(doneButton);
      await tester.pumpAndSettle();

      await tester.tap(find.text('A kids book'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(creation.buildPresets?.targetPages, 14);
      expect(creation.buildPresets?.pageCountSource, 'settings');

      await tester.teardownScreen();
    },
  );

  testWidgets('advanced sheet sends the author name to the build', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Advanced settings'));
    await tester.pumpAndSettle();

    final authorField = find.byKey(const ValueKey('author-name-field'));
    await tester.ensureVisible(authorField);
    await tester.enterText(authorField, 'Ada Lovelace');
    await tester.pumpAndSettle();

    // No "Your choice" badge: the studio never proposes a byline, so there is
    // nothing for the reader to be overriding.
    expect(find.text('Your choice'), findsNothing);

    final doneButton = find.widgetWithText(FilledButton, 'Done');
    await tester.ensureVisible(doneButton);
    await tester.tap(doneButton);
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(creation.buildOptionalDetails?.authorName, 'Ada Lovelace');

    await tester.teardownScreen();
  });

  testWidgets(
    'a byline stated in chat fills the advanced sheet and the build',
    (tester) async {
      final creation = ScriptedCreationRepository(replyAuthorName: 'Parsa Gh.');
      await tester.pumpWidget(app(creation: creation));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byType(TextField).first,
        'A fable about generosity, put my name Parsa Gh. on it',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Advanced settings'));
      await tester.pumpAndSettle();

      final authorField = find.byKey(const ValueKey('author-name-field'));
      await tester.ensureVisible(authorField);
      expect(
        tester.widget<TextField>(authorField).controller?.text,
        'Parsa Gh.',
      );
      // Still no badge: the value is the reader's own words being transcribed,
      // not a studio proposal they overrode.
      expect(find.text('Your choice'), findsNothing);

      final doneButton = find.widgetWithText(FilledButton, 'Done');
      await tester.ensureVisible(doneButton);
      await tester.tap(doneButton);
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(creation.buildOptionalDetails?.authorName, 'Parsa Gh.');

      await tester.teardownScreen();
    },
  );

  testWidgets('build asks for pages when preflight requires a page count', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      preflightRequiresPageCount: true,
    );
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pumpAndSettle();

    expect(find.text('How many pages?'), findsOneWidget);

    // Every suggestion shows its description and estimated package cost,
    // computed with the same estimator as the plan-approval dialog.
    int expectedCredits(int pages) => estimateProjectCredits(
      bookType: 'lead_magnet',
      qualityPreset: 'balanced',
      coverEnabled: true,
      illustrationsEnabled: true,
      targetPages: pages,
      creditCosts: const {},
    );
    expect(find.text('≈ ${expectedCredits(8)} credits'), findsOneWidget);
    expect(find.text('≈ ${expectedCredits(12)} credits'), findsOneWidget);
    expect(find.text('Recommended for a compact book.'), findsOneWidget);
    expect(find.text('More room for detail.'), findsOneWidget);

    // The custom field shows a live estimate for whatever the user types.
    await tester.enterText(
      find.widgetWithText(TextField, 'Custom pages'),
      '30',
    );
    await tester.pump();
    expect(
      find.textContaining('≈ ${expectedCredits(30)} credits for 30 pages'),
      findsOneWidget,
    );

    await tester.tap(find.text('8 pages'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(creation.buildPresets?.targetPages, 8);
    expect(creation.buildPresets?.pageCountSource, 'recommended');

    await tester.teardownScreen();
  });

  testWidgets('cover and illustration choices stay independent across chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Advanced settings'));
    await tester.pumpAndSettle();

    final cover = find.widgetWithText(SwitchListTile, 'AI cover art');
    final illustrations = find.widgetWithText(
      SwitchListTile,
      'In-book illustrations',
    );
    expect(cover, findsOneWidget);
    expect(illustrations, findsOneWidget);
    expect(tester.widget<SwitchListTile>(cover).value, isTrue);
    expect(tester.widget<SwitchListTile>(illustrations).value, isTrue);

    await tester.ensureVisible(cover);
    await tester.tap(cover);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(cover).value, isFalse);
    expect(tester.widget<SwitchListTile>(illustrations).value, isTrue);

    final doneButton = find.widgetWithText(FilledButton, 'Done');
    await tester.ensureVisible(doneButton);
    await tester.tap(doneButton);
    await tester.pumpAndSettle();

    // The fake server replies with the legacy all-images=true field. The
    // manually chosen cover value must remain sticky without pinning the
    // separate illustration setting.
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Advanced settings'));
    await tester.pumpAndSettle();

    final stickyCover = find.widgetWithText(SwitchListTile, 'AI cover art');
    final stickyIllustrations = find.widgetWithText(
      SwitchListTile,
      'In-book illustrations',
    );
    expect(tester.widget<SwitchListTile>(stickyCover).value, isFalse);
    expect(tester.widget<SwitchListTile>(stickyIllustrations).value, isTrue);

    await tester.teardownScreen();
  });

  testWidgets('building shows the generated plan in-chat', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(creation.buildDraftId, 'draft-1');
    expect(
      find.descendant(
        of: find.byType(AppBar),
        matching: find.text('A kids book'),
      ),
      findsOneWidget,
    );
    expect(find.text(planTitle), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'answering plan questions keeps revision loading instead of restarting',
    (tester) async {
      final creation = ScriptedCreationRepository();
      final projects = PlanProjectsRepository(
        project: plannedProject(plan: questionPlan()),
      );
      await tester.pumpWidget(app(creation: creation, projects: projects));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A kids book'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Question 1 of 2'), findsOneWidget);
      expect(find.byTooltip('Minimize question'), findsOneWidget);

      await tester.tap(find.byTooltip('Minimize question'));
      await tester.pump();
      expect(find.text('Busy solo teachers'), findsNothing);
      expect(find.byTooltip('Expand question'), findsOneWidget);

      await tester.tap(find.byTooltip('Expand question'));
      await tester.pump();
      expect(find.text('Busy solo teachers'), findsOneWidget);

      await tester.tap(find.text('Busy solo teachers'));
      await tester.pump();

      expect(find.text('Question 2 of 2'), findsOneWidget);

      await tester.tap(find.text('Live classes'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(projects.revisionMessages, hasLength(1));
      expect(projects.revisionMessages.single, contains('Busy solo teachers'));
      expect(projects.revisionMessages.single, contains('Live classes'));
      expect(find.textContaining('Revising your book plan'), findsWidgets);
      expect(find.text('Question 1 of 2'), findsNothing);

      await tester.teardownScreen();
    },
  );

  // The planner asks "which of these themes?" about a book of tales. One answer
  // was all the drawer could send, so the plan revision only ever heard one.
  testWidgets('a multi-answer plan question revises with every pick', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(plan: multiQuestionPlan()),
    );
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Question 1 of 1'), findsOneWidget);
    expect(find.text('Pick as many as you like.'), findsOneWidget);

    await tester.tap(find.text('Forgiveness'));
    await tester.pump();
    // A tap is a pick, not an answer: nothing has been sent yet.
    expect(projects.revisionMessages, isEmpty);

    await tester.ensureVisible(find.text('Justice'));
    await tester.pump();
    await tester.tap(find.text('Justice'));
    await tester.pump();

    final sendFinder = find.widgetWithText(FilledButton, 'Send 2 answers');
    await tester.ensureVisible(sendFinder);
    await tester.pump();
    await tester.tap(sendFinder);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(projects.revisionMessages, hasLength(1));
    expect(
      projects.revisionMessages.single,
      contains('Which themes should the tales carry?: Forgiveness, Justice'),
    );

    await tester.teardownScreen();
  });

  testWidgets(
    'a plan question with no premade answers opens its field without the keyboard',
    (tester) async {
      final creation = ScriptedCreationRepository();
      final projects = PlanProjectsRepository(
        project: plannedProject(plan: openQuestionPlan()),
      );
      await tester.pumpWidget(app(creation: creation, projects: projects));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A kids book'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      final customField = find.byWidgetPredicate(
        (widget) =>
            widget is TextField &&
            widget.decoration?.hintText == 'Type your own answer…',
      );

      expect(
        find.text('What name should appear as the author?'),
        findsOneWidget,
      );
      // Nothing to tap, so the field is already open - but it must not grab
      // focus, because the keyboard would collapse the question it answers.
      expect(find.widgetWithText(TextButton, 'Custom…'), findsNothing);
      expect(customField, findsOneWidget);
      expect(tester.widget<TextField>(customField).autofocus, isFalse);

      await tester.enterText(customField, 'Parsa');
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pump();

      // The next question has real choices, so the field goes away again
      // instead of carrying the previous answer over.
      expect(find.text('Question 2 of 2'), findsOneWidget);
      expect(customField, findsNothing);
      expect(find.text('Live classes'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('long question options wrap instead of fading away', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(360, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(plan: longQuestionPlan()),
    );
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    const longOption = 'Busy solo teachers launching their first live course';
    final optionText = find.text(longOption);
    expect(optionText, findsOneWidget);
    expect(find.text('1.'), findsOneWidget);
    expect(find.text('2.'), findsOneWidget);
    final paragraph = tester.renderObject<RenderParagraph>(optionText);
    expect(paragraph.softWrap, isTrue);
    expect(paragraph.size.height, greaterThan(20));
    expect(tester.getSize(optionText).width, lessThan(360));

    await tester.teardownScreen();
  });

  testWidgets('plan questions scroll separately from revision controls', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(plan: longQuestionPlan()),
    );
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    final questionScroll = find.byKey(const ValueKey('plan-question-scroll'));
    final questionScrollable = find.descendant(
      of: questionScroll,
      matching: find.byType(Scrollable),
    );
    final revisionComposer = find.widgetWithText(
      TextField,
      'Ask about or request a change to the plan…',
    );
    final approveButton = find.widgetWithText(
      FilledButton,
      'Approve and start writing',
    );

    expect(find.text('Question 1 of 1'), findsOneWidget);
    expect(questionScrollable, findsOneWidget);
    expect(
      tester
          .state<ScrollableState>(questionScrollable)
          .position
          .maxScrollExtent,
      greaterThan(0),
    );
    expect(find.text('Scroll for more'), findsOneWidget);
    final scrollbar = tester.widget<Scrollbar>(
      find.descendant(of: questionScroll, matching: find.byType(Scrollbar)),
    );
    expect(scrollbar.controller, isNotNull);
    expect(
      find.descendant(of: questionScroll, matching: revisionComposer),
      findsNothing,
    );
    expect(
      find.descendant(of: questionScroll, matching: approveButton),
      findsNothing,
    );

    await tester.tap(find.byTooltip('Minimize question'));
    await tester.pump();
    expect(find.text('Scroll for more'), findsNothing);

    await tester.tap(find.byTooltip('Expand question'));
    await tester.pumpAndSettle();
    expect(find.text('Scroll for more'), findsOneWidget);

    await tester.drag(questionScroll, const Offset(0, -1000));
    await tester.pumpAndSettle();
    expect(find.text('Scroll for more'), findsNothing);

    await tester.showKeyboard(revisionComposer);
    tester.view.viewInsets = FakeViewPadding(
      bottom: tester.view.physicalSize.height / 2,
    );
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();

    final keyboardTop =
        (tester.view.physicalSize.height - tester.view.viewInsets.bottom) /
        tester.view.devicePixelRatio;
    expect(approveButton, findsOneWidget);
    expect(
      tester.getRect(revisionComposer).bottom,
      lessThanOrEqualTo(keyboardTop),
    );
    expect(
      tester.getRect(approveButton).bottom,
      lessThanOrEqualTo(keyboardTop),
    );

    await tester.teardownScreen();
  });
  testWidgets(
    'failed plan revision clears spinner and keeps old plan visible',
    (tester) async {
      final creation = ScriptedCreationRepository();
      final projects = PlanProjectsRepository(
        project: plannedProject(plan: questionPlan()),
      );
      await tester.pumpWidget(app(creation: creation, projects: projects));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A kids book'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      await tester.tap(find.text('Busy solo teachers'));
      await tester.pump();
      await tester.tap(find.text('Live classes'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.textContaining('Revising your book plan'), findsWidgets);

      projects.failLatestPlanRevision();
      await tester.pump(const Duration(seconds: 4));
      await tester.pump();
      await tester.pump();

      expect(
        find.text('Plan revision failed. Your current plan is unchanged.'),
        findsOneWidget,
      );
      expect(find.textContaining('Revising your book plan'), findsNothing);
      expect(find.text(planTitle), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('changing draftId reloads the selected chat', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-a'));
    await tester.pumpAndSettle();

    expect(find.text('Title for draft-a'), findsOneWidget);
    expect(find.text('Selected chat draft-a'), findsOneWidget);

    await tester.pumpWidget(app(creation: creation, draftId: 'draft-b'));
    await tester.pumpAndSettle();

    expect(creation.resumedDraftIds, ['draft-a', 'draft-b']);
    expect(find.text('Title for draft-a'), findsNothing);
    expect(find.text('Title for draft-b'), findsOneWidget);
    expect(find.text('Selected chat draft-a'), findsNothing);
    expect(find.text('Selected chat draft-b'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'returning to an opened chat renders cached content immediately',
    (tester) async {
      final creation = ScriptedCreationRepository();
      await tester.pumpWidget(app(creation: creation, draftId: 'draft-a'));
      await tester.pumpAndSettle();

      expect(find.text('Selected chat draft-a'), findsOneWidget);

      await tester.pumpWidget(app(creation: creation, draftId: 'draft-b'));
      await tester.pumpAndSettle();

      final refreshGate = Completer<void>();
      creation.resumeByIdGate = refreshGate.future;
      creation.resumeAssistantMessages['draft-a'] = 'Refreshed chat draft-a';

      await tester.pumpWidget(app(creation: creation, draftId: 'draft-a'));
      await tester.pump();
      await tester.pump();

      expect(find.text('Selected chat draft-a'), findsOneWidget);
      expect(find.text('Refreshed chat draft-a'), findsNothing);
      expect(creation.resumedDraftIds, ['draft-a', 'draft-b', 'draft-a']);

      refreshGate.complete();
      await tester.pumpAndSettle();

      expect(find.text('Selected chat draft-a'), findsNothing);
      expect(find.text('Refreshed chat draft-a'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('selected chat title shows before messages load', (tester) async {
    final resumeGate = Completer<void>();
    final creation = ScriptedCreationRepository(
      resumeByIdGate: resumeGate.future,
      sessions: [chatSession(draftId: 'draft-a', title: 'Title for draft-a')],
    );
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-a'));
    await tester.pump();
    await tester.pump();

    expect(find.text('Title for draft-a'), findsOneWidget);
    expect(find.text('Selected chat draft-a'), findsNothing);

    resumeGate.complete();
    await tester.pumpAndSettle();

    expect(find.text('Selected chat draft-a'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('drawer marks the selected chat as active', (tester) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(draftId: 'draft-a', title: 'Title for draft-a'),
        chatSession(draftId: 'draft-b', title: 'Title for draft-b'),
      ],
    );
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-a'));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();

    final activeTile = tester.widget<ListTile>(
      find.widgetWithText(ListTile, 'Title for draft-a'),
    );
    final inactiveTile = tester.widget<ListTile>(
      find.widgetWithText(ListTile, 'Title for draft-b'),
    );
    expect(activeTile.selected, isTrue);
    expect(inactiveTile.selected, isFalse);

    await tester.teardownScreen();
  });

  // Regression: GoRouter treats navigating to the exact location you're
  // already on as a no-op (no rebuild at all), and this screen is on
  // `/books/new?fresh=true` for the rest of a conversation once it's reached
  // that route — build, edit, look at the book, all without the location
  // changing. Tapping "New book" again used to just close the drawer.
  testWidgets(
    'New book resets the chat even when already on a fresh chat location',
    (tester) async {
      final creation = ScriptedCreationRepository();
      await tester.pumpWidget(
        routerApp(
          creation: creation,
          projects: PlanProjectsRepository(),
          initialLocation: '/books/new?fresh=true&r=already-fresh',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Tell me about the book'), findsOneWidget);

      await tester.enterText(
        find.byType(TextField).last,
        'A workbook for new coaches',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();

      // Reach the output stage, same as generating a book and looking at it.
      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text(planTitle), findsOneWidget);

      // Already sitting on /books/new?fresh=true (the initial location):
      // tapping "New book" targets that same path+fresh flag again, differing
      // only by the nonce a real tap always mints.
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New book'));
      await tester.pumpAndSettle();

      expect(find.text(planTitle), findsNothing);
      expect(find.text('A workbook for new coaches'), findsNothing);
      expect(find.textContaining('Tell me about the book'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('completed drawer chat opens chat history with the plan', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(draftId: 'draft-a', title: 'Active idea'),
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: PlanProjectsRepository(),
        initialLocation: '/books/chat/draft-a',
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Completed idea'));
    await tester.pumpAndSettle();

    expect(creation.resumedDraftIds, contains('draft-done'));
    expect(find.text('Completed idea'), findsOneWidget);
    expect(find.text('Original completed chat transcript'), findsOneWidget);
    expect(find.text(planTitle), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsNothing);
    expect(find.text('Approve and start writing'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('resuming a completed chat loads its linked plan in-chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = PlanProjectsRepository();

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    expect(creation.resumedDraftIds, ['draft-done']);
    expect(projects.requestedProjectIds, ['project-1']);
    expect(find.text('Completed idea'), findsOneWidget);
    expect(find.text('Original completed chat transcript'), findsOneWidget);
    expect(find.text(planTitle), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsNothing);
    expect(find.text('Approve and start writing'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('completed chat keeps composer for plan edits', (tester) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = PlanProjectsRepository();

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'Make the examples warmer',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send revision'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(projects.revisionMessages, contains('Make the examples warmer'));
    expect(find.text('Make the examples warmer'), findsOneWidget);
    expect(find.text('I’ll revise the plan now.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('plan questions reply in chat without revision loading', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository();

    await tester.pumpWidget(app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(
      find.widgetWithText(
        TextField,
        'Ask about or request a change to the plan…',
      ),
      findsOneWidget,
    );

    await tester.enterText(
      find.widgetWithText(
        TextField,
        'Ask about or request a change to the plan…',
      ),
      'What is this plan about?',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send revision'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(projects.revisionMessages, contains('What is this plan about?'));
    expect(find.text('What is this plan about?'), findsOneWidget);
    expect(find.text('Here’s the current plan.'), findsOneWidget);
    expect(find.textContaining('Revising the plan'), findsNothing);
    expect(find.textContaining('Revising your book plan'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('revised plan appears as a new chat item', (tester) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(plan: plan(title: 'Original launch plan')),
    );

    await tester.pumpWidget(app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Original launch plan'), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(
        TextField,
        'Ask about or request a change to the plan…',
      ),
      'Make the plan warmer',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send revision'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    projects.completeLatestPlanRevision(title: 'Warmer revised plan');
    await tester.pump(const Duration(seconds: 4));
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.drag(find.byType(ListView), const Offset(0, -600));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Previous plan'), findsOneWidget);
    expect(find.text('Revised plan ready'), findsOneWidget);
    expect(find.text('Original launch plan'), findsOneWidget);
    expect(find.text('Warmer revised plan'), findsOneWidget);
    expect(find.text('Make the plan warmer'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('approved linked plan is compact and opens the book page', (
    tester,
  ) async {
    // The book page is one scrolling list, and the default test viewport cuts
    // it off above the plan summary — which a lazy ListView never builds.
    await tester.binding.setSurfaceSize(const Size(1000, 2000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'generating',
        currentAction: 'Writing your book.',
        plan: approvedPlan(),
      ),
    );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Book plan approved'), findsOneWidget);
    expect(find.text('Tap to open your book'), findsOneWidget);
    expect(find.text('Approve and start writing'), findsNothing);
    expect(find.text('Premise'), findsNothing);

    await tester.tap(find.text('Tap to open your book'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    // One page per book: it opens on the writing, and the plan the reader
    // already approved is folded into a summary rather than leading.
    expect(
      find.descendant(of: find.byType(AppBar), matching: find.text(planTitle)),
      findsOneWidget,
    );
    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Book plan'), findsOneWidget);
    expect(find.text('Premise'), findsNothing);
    expect(find.text('This plan is approved.'), findsNothing);

    await tester.tap(find.text('Book plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Set the promise'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('failed initial plan stops loading and retries from the chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Completed transcript';
    final resumeGate = Completer<void>();
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'failed',
        currentAction: 'Needs attention.',
        withoutPlan: true,
      ),
      status: projectStatus(
        status: 'failed',
        currentAction: 'Needs attention.',
        failureMessage: 'We hit a problem while creating your plan.',
        retryAvailable: true,
        completedPages: 0,
        imageCount: 0,
      ),
    )..resumeGate = resumeGate;

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Plan generation failed'), findsOneWidget);
    expect(find.text('Your plan needs a retry'), findsOneWidget);
    expect(
      find.text('We hit a problem while creating your plan.'),
      findsWidgets,
    );
    expect(find.text('Understanding your idea'), findsNothing);
    expect(
      find.text('You can leave this chat — we’ll keep working.'),
      findsNothing,
    );
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    await tester.tap(find.widgetWithText(FilledButton, 'Retry plan'));
    await tester.pump();
    await tester.tap(find.text('Retry for 40'));
    await tester.pump();

    expect(projects.resumedProjectIds, ['project-1']);
    final retryingButton = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Retrying…'),
    );
    expect(retryingButton.onPressed, isNull);

    resumeGate.complete();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('Retry plan'), findsNothing);
    expect(find.text('Plan generation failed'), findsNothing);
    expect(find.text('Understanding your idea'), findsWidgets);
    expect(find.text('Retrying your book plan.'), findsWidgets);

    await tester.teardownScreen();
  });

  testWidgets('failed plan retry errors remain recoverable', (tester) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Completed transcript';
    final projects =
        PlanProjectsRepository(
            project: plannedProject(
              status: 'failed',
              currentAction: 'Needs attention.',
              withoutPlan: true,
            ),
            status: projectStatus(
              status: 'failed',
              currentAction: 'Needs attention.',
              failureMessage: 'We hit a problem while creating your plan.',
              retryAvailable: true,
              completedPages: 0,
              imageCount: 0,
            ),
          )
          ..resumeFailure = const ApiException(
            code: 'RECOVERY_NOT_AVAILABLE',
            message: 'Generation is still winding down. Try again in a moment.',
            statusCode: 409,
          );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.widgetWithText(FilledButton, 'Retry plan'));
    await tester.pump();
    await tester.tap(find.text('Retry for 40'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(projects.resumedProjectIds, ['project-1']);
    expect(
      find.text('Generation is still winding down. Try again in a moment.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Retry plan'), findsOneWidget);
    expect(find.text('Understanding your idea'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets(
    'nonrecoverable plan failure offers a status refresh, not retry',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-done',
            title: 'Completed idea',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
          ),
        ],
      );
      creation.resumeAssistantMessages['draft-done'] = 'Completed transcript';
      final projects = PlanProjectsRepository(
        project: plannedProject(
          // The streamed status is newer than this stale planning snapshot.
          status: 'planning',
          currentAction: 'Creating your book plan.',
          withoutPlan: true,
        ),
        status: projectStatus(
          status: 'failed',
          currentAction: 'Needs attention.',
          failureMessage: 'This plan cannot be retried yet.',
          retryAvailable: false,
          completedPages: 0,
          imageCount: 0,
        ),
      );

      await tester.pumpWidget(
        routerApp(
          creation: creation,
          projects: projects,
          initialLocation: '/books/chat/draft-done',
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Your plan needs attention'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Check again'), findsOneWidget);
      expect(find.text('Retry plan'), findsNothing);

      await tester.tap(find.widgetWithText(FilledButton, 'Check again'));
      await tester.pump();

      expect(projects.resumedProjectIds, isEmpty);

      await tester.teardownScreen();
    },
  );

  testWidgets('plan retry completion does not disturb another output', (
    tester,
  ) async {
    final failedOutput = creationOutput(
      projectId: 'project-1',
      title: 'Failed plan',
      sequence: 1,
    );
    final otherOutput = creationOutput(
      projectId: 'project-2',
      title: 'Other plan',
      sequence: 2,
    );
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
          activeProjectId: 'project-1',
          outputs: [failedOutput, otherOutput],
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Completed transcript';
    final resumeGate = Completer<void>();
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'failed',
        currentAction: 'Needs attention.',
        withoutPlan: true,
      ),
      status: projectStatus(
        status: 'failed',
        currentAction: 'Needs attention.',
        failureMessage: 'We hit a problem while creating your plan.',
        retryAvailable: true,
        completedPages: 0,
        imageCount: 0,
      ),
    )..resumeGate = resumeGate;

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    await tester.tap(find.widgetWithText(FilledButton, 'Retry plan'));
    await tester.pump();
    await tester.tap(find.text('Retry for 40'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilterChip, 'Other plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(
      tester
          .widget<FilterChip>(find.widgetWithText(FilterChip, 'Other plan'))
          .selected,
      isTrue,
    );

    resumeGate.complete();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(projects.resumedProjectIds, ['project-1']);
    expect(
      tester
          .widget<FilterChip>(find.widgetWithText(FilterChip, 'Other plan'))
          .selected,
      isTrue,
    );
    expect(
      find.descendant(
        of: find.byType(SnackBar),
        matching: find.text('Retrying your book plan.'),
      ),
      findsNothing,
    );

    await tester.teardownScreen();
  });

  testWidgets('planning shows trustworthy live progress in chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'planning',
        currentAction: 'Creating your book plan.',
        withoutPlan: true,
      ),
      status: projectStatus(
        status: 'planning',
        statusLabel: 'Creating your book plan',
        progressPercent: 10,
        currentAction: 'Shaping the chapters and flow',
        completedPages: 0,
        imageCount: 0,
        planningProgress: const MobilePlanningProgress(
          percent: 55,
          steps: [
            MobileProjectStatusStep(
              key: 'understand',
              label: 'Understanding your idea',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'shape',
              label: 'Shaping the chapters and flow',
              status: 'active',
            ),
            MobileProjectStatusStep(
              key: 'finalize',
              label: 'Finalizing your plan',
              status: 'pending',
            ),
          ],
        ),
      ),
    );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Creating your book plan'), findsOneWidget);
    expect(find.text('55%'), findsOneWidget);
    expect(find.text('Understanding your idea'), findsWidgets);
    expect(find.text('Shaping the chapters and flow'), findsWidgets);
    expect(find.text('Finalizing your plan'), findsOneWidget);
    expect(
      find.text('You can leave this chat — we’ll keep working.'),
      findsOneWidget,
    );
    final semantics = tester.ensureSemantics();
    expect(
      tester.getSemantics(find.byType(LinearProgressIndicator)),
      matchesSemantics(
        label: 'Book plan progress',
        value: '55 percent complete',
      ),
    );
    semantics.dispose();
    expect(
      find.bySemanticsLabel('Shaping the chapters and flow. In progress.'),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.bySemanticsLabel(
          'Shaping the chapters and flow. In progress.',
        ),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );

    await tester.teardownScreen();
  });

  testWidgets('completed planning progress hands off without regressing', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Completed transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'planning',
        currentAction: 'Finalizing your plan',
        withoutPlan: true,
      ),
      status: projectStatus(
        status: 'plan_ready',
        statusLabel: 'Review your book plan',
        progressPercent: 20,
        currentAction: 'Ready for review.',
        completedPages: 0,
        imageCount: 0,
        planningProgress: const MobilePlanningProgress(
          percent: 100,
          steps: [
            MobileProjectStatusStep(
              key: 'understand',
              label: 'Understanding your idea',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'shape',
              label: 'Shaping the chapters and flow',
              status: 'done',
            ),
            MobileProjectStatusStep(
              key: 'finalize',
              label: 'Finalizing your plan',
              status: 'done',
            ),
          ],
        ),
      ),
    );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Your book plan is ready'), findsOneWidget);
    expect(find.text('Opening it for review…'), findsOneWidget);
    expect(find.text('100%'), findsOneWidget);
    expect(
      find.bySemanticsLabel('Finalizing your plan. Done.'),
      findsOneWidget,
    );
    expect(
      find.bySemanticsLabel('Understanding your idea. In progress.'),
      findsNothing,
    );

    await tester.teardownScreen();
  });

  testWidgets('planning without live fields keeps useful milestone feedback', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Completed transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'planning',
        currentAction: 'Creating your book plan.',
        withoutPlan: true,
      ),
      status: projectStatus(
        status: 'planning',
        currentAction: 'Creating your book plan.',
        completedPages: 0,
        imageCount: 0,
      ),
    );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Creating your book plan'), findsOneWidget);
    expect(find.text('Understanding your idea'), findsWidgets);
    expect(find.text('Shaping the chapters and flow'), findsOneWidget);
    expect(find.text('Finalizing your plan'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);

    await tester.teardownScreen();
  });
  testWidgets('approved generating plan shows compact progress in chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'generating',
        currentAction: 'Writing your book.',
        plan: approvedPlan(),
      ),
      status: projectStatus(
        progressPercent: 38,
        currentAction: 'Writing your book pages.',
        completedPages: 3,
        targetPages: 28,
        imageCount: 1,
      ),
    );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Book plan approved'), findsOneWidget);
    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing your book pages.'), findsOneWidget);
    expect(find.text('38%'), findsOneWidget);
    expect(find.text('3/28 pages'), findsOneWidget);
    expect(find.text('1 visual'), findsOneWidget);
    expect(find.text('View progress'), findsOneWidget);
    final composer = tester.widget<TextField>(find.byType(TextField));
    expect(composer.enabled, isFalse);
    expect(composer.decoration?.hintText, 'Generating your book…');
    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNull,
    );
    expect(projects.revisionMessages, isEmpty);

    await tester.tap(find.text('View progress'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 300));

    expect(
      find.descendant(of: find.byType(AppBar), matching: find.text(planTitle)),
      findsOneWidget,
    );
    expect(find.text('Writing your book pages.'), findsWidgets);

    await tester.teardownScreen();
  });

  testWidgets('completed generation downloads an unlocked export in chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'complete',
        currentAction: 'Ready to download.',
        plan: approvedPlan(),
      ),
      status: projectStatus(
        status: 'complete',
        progressPercent: 100,
        currentAction: 'Ready to download.',
        completedPages: 28,
        targetPages: 28,
        imageCount: 1,
        exports: unlockedExports,
      ),
    );

    await tester.pumpWidget(
      routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Ready to export'), findsOneWidget);
    expect(find.text('Open PDF'), findsOneWidget);
    expect(find.text('View progress'), findsOneWidget);

    await tester.tap(find.text('Open PDF'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(projects.openedFormats, ['pdf']);

    await tester.teardownScreen();
  });

  testWidgets(
    'failed generation keeps approved plan and shows attention copy',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-done',
            title: 'Completed idea',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
          ),
        ],
      );
      creation.resumeAssistantMessages['draft-done'] =
          'Original completed chat transcript';
      final projects = PlanProjectsRepository(
        project: plannedProject(
          status: 'failed',
          currentAction: 'Needs attention.',
          plan: approvedPlan(),
        ),
        status: projectStatus(
          status: 'failed',
          statusLabel: 'Needs attention',
          progressPercent: 42,
          currentAction: 'Needs attention.',
          failureMessage: 'We hit a problem while writing page 4.',
          retryAvailable: true,
          completedPages: 3,
          targetPages: 28,
          imageCount: 1,
        ),
      );

      await tester.pumpWidget(
        routerApp(
          creation: creation,
          projects: projects,
          initialLocation: '/books/chat/draft-done',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Book plan approved'), findsOneWidget);
      expect(find.text(planTitle), findsOneWidget);
      expect(find.text('Needs attention'), findsOneWidget);
      expect(
        find.text('We hit a problem while writing page 4.'),
        findsOneWidget,
      );
      expect(find.text('Approve and start writing'), findsNothing);

      await tester.teardownScreen();
    },
  );

  testWidgets('completed book chat sends edits without leaving the chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'Rewrite page 1 to sound warmer',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(
      projects.chatMessages.map((message) => message.content),
      contains('Rewrite page 1 to sound warmer'),
    );
    expect(find.text('Rewrite page 1 to sound warmer'), findsOneWidget);
    expect(find.text('I can help edit this book.'), findsOneWidget);
    expect(find.text('Completed book'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a book edit stays on screen while the assistant works on it', (
    tester,
  ) async {
    // The composer clears the moment you send. Without an echo and a thinking
    // bubble the message simply vanished for as long as the server took, and
    // the only sign of life was a disabled button.
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );
    final gate = Completer<void>();
    projects.sendGate = gate;

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'Rewrite page 1 to sound warmer',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    expect(find.text('Rewrite page 1 to sound warmer'), findsOneWidget);
    expect(find.byType(ChatThinkingBubble), findsOneWidget);
    expect(find.text('Reading your message…'), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();

    // Exactly once: the echo hands over to the real transcript, not beside it.
    expect(find.text('Rewrite page 1 to sound warmer'), findsOneWidget);
    expect(find.byType(ChatThinkingBubble), findsNothing);
    expect(find.text('I can help edit this book.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a failed book edit keeps the message with retry rather than '
      'dropping it back in the composer', (tester) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );
    projects.sendFailure = Exception('offline');

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'Rewrite page 1 to sound warmer',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('Rewrite page 1 to sound warmer'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Dismiss'), findsOneWidget);
    expect(find.byType(ChatThinkingBubble), findsNothing);

    // Retrying sends the same text again rather than making the user retype it.
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(
      projects.revisionMessages
          .where((message) => message == 'Rewrite page 1 to sound warmer')
          .length,
      2,
    );
    expect(find.text('I can help edit this book.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'editing a brainstorm message after build forks a creation branch',
    (tester) async {
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-done',
            title: 'Completed book',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
          ),
        ],
      );
      creation.resumeMessages['draft-done'] = [
        {'id': 'c0', 'role': 'assistant', 'content': 'Book transcript'},
        {'id': 'c1', 'role': 'user', 'content': 'Original brainstorm idea'},
      ];
      final projects = PlanProjectsRepository(
        project: plannedProject(status: 'complete', plan: approvedPlan()),
      );

      await tester.pumpWidget(
        app(creation: creation, projects: projects, draftId: 'draft-done'),
      );
      await tester.pumpAndSettle();

      // The built plan renders below the brainstorm before the edit.
      expect(find.text(planTitle), findsOneWidget);

      await tester.longPress(bubbleText('Original brainstorm idea'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Edit'));
      await tester.pumpAndSettle();

      // The output-stage composer is reused for the brainstorm edit.
      expect(find.text('Editing message'), findsOneWidget);
      final composer = tester.widget<TextField>(find.byType(TextField).first);
      expect(composer.controller?.text, 'Original brainstorm idea');
      expect(composer.focusNode?.hasFocus, isTrue);

      await tester.enterText(
        find.byType(TextField).first,
        'A better brainstorm',
      );
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();

      // The submit went to the creation edit API (a fork), not project chat.
      expect(creation.editRequests, ['c1']);
      expect(projects.chatMessages, isEmpty);
      expect(find.text('Editing message'), findsNothing);
      expect(bubbleText('A better brainstorm'), findsOneWidget);
      expect(find.text('2/2'), findsOneWidget);
      // The old branch's plan left the view and the chat is back in the
      // pre-build stage, ready to build a new output from the fork.
      expect(find.text(planTitle), findsNothing);
      expect(
        find.widgetWithText(FilledButton, 'Build the plan'),
        findsOneWidget,
      );

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'a chat build request starts the build without tapping the button',
    (tester) async {
      final creation = ScriptedCreationRepository(replyWithBuildRequest: true);
      await tester.pumpWidget(
        app(creation: creation, projects: PlanProjectsRepository()),
      );
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).last, 'Ok, build it');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.continuePastVisualsPrompt();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      expect(creation.buildCount, 1);
      expect(creation.buildDraftId, 'draft-1');
      expect(find.text(planTitle), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('assistant content cards render book content in the chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );
    projects.chatMessages.add(
      MobileProjectChatMessage(
        id: 'chat-card-1',
        projectId: 'project-1',
        role: 'assistant',
        content: 'Here’s the outline of your book.',
        metadata: const {
          'contentCard': {
            'type': 'outline',
            'title': 'Your book outline',
            'sections': [
              {
                'label': '1. Set the promise',
                'body': 'Define the result the student should get.',
              },
            ],
          },
        },
        createdAt: DateTime.utc(2026, 6, 15, 12),
      ),
    );

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    expect(find.text('Here’s the outline of your book.'), findsOneWidget);
    expect(find.text('Your book outline'), findsOneWidget);
    expect(find.text('1. Set the promise'), findsOneWidget);
    expect(
      find.text('Define the result the student should get.'),
      findsOneWidget,
    );

    await tester.teardownScreen();
  });

  testWidgets('replan copy reference switches to the copied output', (
    tester,
  ) async {
    final originalOutput = creationOutput(
      projectId: 'project-1',
      title: 'Original book',
      sequence: 1,
    );
    final englishOutput = creationOutput(
      projectId: 'project-2',
      title: 'English book',
      sequence: 2,
    );
    final creation = ScriptedCreationRepository(
      sessions: [
        chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
          activeProjectId: 'project-1',
          outputs: [originalOutput],
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    creation.resumeSyncedOutputs['draft-done'] = [
      originalOutput,
      englishOutput,
    ];
    final projects = PlanProjectsRepository(
      project: plannedProject(status: 'complete', plan: approvedPlan()),
    );
    projects.chatMessages.add(
      MobileProjectChatMessage(
        id: 'chat-replan-copy-1',
        projectId: 'project-1',
        role: 'assistant',
        content: 'I created a new copy of your book.',
        metadata: const {
          'replanCopy': {
            'sourceProjectId': 'project-1',
            'targetProjectId': 'project-2',
            'targetLanguage': 'en',
          },
        },
        createdAt: DateTime.utc(2026, 6, 15, 12),
      ),
    );

    await tester.pumpWidget(
      app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    expect(find.text('I created a new copy of your book.'), findsOneWidget);
    expect(find.text('Open the new book'), findsOneWidget);
    expect(find.widgetWithText(FilterChip, 'English book'), findsOneWidget);
    var chips = tester.widgetList<FilterChip>(find.byType(FilterChip)).toList();
    expect(chips, hasLength(2));
    expect(chips.first.selected, isTrue);
    expect(chips.last.selected, isFalse);

    await tester.ensureVisible(find.text('Open the new book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open the new book'));
    await tester.pumpAndSettle();

    expect(projects.requestedProjectIds, contains('project-2'));
    chips = tester.widgetList<FilterChip>(find.byType(FilterChip)).toList();
    expect(chips.first.selected, isFalse);
    expect(chips.last.selected, isTrue);
    expect(find.text('Open the new book'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('one chat can build multiple outputs and selects the latest', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(
      app(creation: creation, projects: PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.byTooltip('New output in this chat'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final chips = tester.widgetList<FilterChip>(find.byType(FilterChip));
    expect(creation.buildCount, 2);
    expect(chips, hasLength(2));
    expect(chips.last.selected, isTrue);
    expect(find.text(planTitle), findsWidgets);

    await tester.teardownScreen();
  });

  testWidgets('fresh new chat is saved only after the first message', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    expect(find.textContaining('Tell me about the book'), findsOneWidget);
    expect(creation.startedMessages, isEmpty);

    await tester.enterText(
      find.byType(TextField).last,
      'A workbook for new coaches',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.startedMessages, ['A workbook for new coaches']);
    expect(find.text(reply), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'composer hint only mentions answering when a question is active',
    (tester) async {
      final creation = ScriptedCreationRepository(replyWithQuestion: true);
      await tester.pumpWidget(app(creation: creation, startFresh: true));
      await tester.pumpAndSettle();

      TextField composer() =>
          tester.widget<TextField>(find.byType(TextField).last);

      expect(composer().decoration?.hintText, 'Describe your book…');

      await tester.enterText(
        find.byType(TextField).last,
        'A practical guide for new managers',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();

      expect(find.text('Who is this book for?'), findsOneWidget);
      expect(composer().decoration?.hintText, 'Answer the question above…');

      await tester.teardownScreen();
    },
  );

  // A name, a title or a date is a value only the reader has. The API sends
  // that question with no options rather than inventing three that describe
  // how the reader would answer, so the card has to point at the message box.
  testWidgets('an open question points at the composer instead of options', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(replyWithOpenQuestion: true);
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'A tale published under my own name',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('What name should appear as the author?'), findsOneWidget);
    expect(find.text('Type your answer below.'), findsOneWidget);
    // No numbered choices to tap, and the composer is the way to answer.
    expect(find.text('1.'), findsNothing);
    final composer = tester.widget<TextField>(find.byType(TextField).last);
    expect(composer.decoration?.hintText, 'Answer the question above…');

    await tester.enterText(find.byType(TextField).last, 'Parsa');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages.last, 'Parsa');

    await tester.teardownScreen();
  });

  // "Which of these themes?" is answered by several options at once. Sending the
  // first tap dropped the rest, so the interviewer stopped offering options at
  // all and asked for a typed list instead.
  testWidgets('a multi-answer question sends every pick as one answer', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(replyWithMultiQuestion: true);
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'A tale like Saadi\'s Bustan',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('Which themes should the tales carry?'), findsOneWidget);
    expect(find.text('Pick as many as you like.'), findsOneWidget);
    // Checkboxes, not a numbered fork, and nothing is sent by a tap.
    expect(find.text('1.'), findsNothing);

    await tester.tap(find.text('Forgiveness'));
    await tester.pump();
    expect(creation.sentMessages, ['A tale like Saadi\'s Bustan']);

    // The drawer scrolls when a long option list does not fit above the
    // composer, so reach the last option the way a reader would.
    await tester.ensureVisible(find.text('Justice'));
    await tester.pump();
    await tester.tap(find.text('Justice'));
    await tester.pump();

    final sendFinder = find.widgetWithText(FilledButton, 'Send 2 answers');
    await tester.ensureVisible(sendFinder);
    await tester.pump();
    await tester.tap(sendFinder);
    await tester.pumpAndSettle();

    // Offered order, and one message rather than two.
    expect(creation.sentMessages.last, 'Forgiveness, Justice');

    await tester.teardownScreen();
  });

  testWidgets('a question offers a skip that still builds the plan', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository(replyWithQuestion: true);
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        startFresh: true,
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'A practical guide for new managers',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('Who is this book for?'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsNothing);

    // Answering is optional, so the button stays enabled and says what
    // tapping it does to the question on screen.
    final skipFinder = find.widgetWithText(
      FilledButton,
      'Skip and build the plan',
    );
    expect(tester.widget<FilledButton>(skipFinder).onPressed, isNotNull);

    await tester.tap(skipFinder);
    await tester.continuePastVisualsPrompt();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(creation.buildCount, 1);
    expect(find.text(planTitle), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('question drawer can be minimized and expanded', (tester) async {
    final creation = ScriptedCreationRepository(replyWithQuestion: true);
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byType(TextField).last,
      'A practical guide for new managers',
    );
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.byTooltip('Minimize question'), findsOneWidget);
    expect(find.text('New managers'), findsOneWidget);
    expect(find.text('1.'), findsOneWidget);

    await tester.tap(find.byTooltip('Minimize question'));
    await tester.pump();

    expect(find.text('Who is this book for?'), findsOneWidget);
    expect(find.text('New managers'), findsNothing);
    expect(find.text('1.'), findsNothing);
    expect(find.byTooltip('Expand question'), findsOneWidget);
    expect(find.text('Scroll for more'), findsNothing);
    final promptRect = tester.getRect(find.text('Who is this book for?'));
    final expandButtonRect = tester.getRect(find.byTooltip('Expand question'));
    final composerRect = tester.getRect(find.byType(TextField).last);
    expect(
      (promptRect.center.dy - expandButtonRect.center.dy).abs(),
      lessThanOrEqualTo(1),
    );
    expect(composerRect.top - expandButtonRect.bottom, 12);

    await tester.tap(find.byTooltip('Expand question'));
    await tester.pump();

    expect(find.text('New managers'), findsOneWidget);
    expect(find.text('1.'), findsOneWidget);
    expect(find.byTooltip('Minimize question'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'typing with a question active keeps the composer above the keyboard '
    'and collapses the options',
    (tester) async {
      final creation = ScriptedCreationRepository(replyWithQuestion: true);
      await tester.pumpWidget(app(creation: creation, startFresh: true));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byType(TextField).last,
        'A practical guide for new managers',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();
      expect(find.text('Who is this book for?'), findsOneWidget);

      final contextScroll = find.byKey(
        const ValueKey('conversation-context-scroll'),
      );
      final contextScrollable = find.descendant(
        of: contextScroll,
        matching: find.byType(Scrollable),
      );
      final composer = find.byType(TextField).last;
      final buildButton = find.widgetWithText(
        FilledButton,
        'Skip and build the plan',
      );
      expect(contextScrollable, findsOneWidget);
      expect(
        find.descendant(of: contextScroll, matching: composer),
        findsNothing,
      );
      expect(
        find.descendant(of: contextScroll, matching: buildButton),
        findsNothing,
      );

      // Focus the composer and simulate the keyboard taking the bottom half
      // of the screen. Any footer overflow would fail the test here.
      await tester.showKeyboard(find.byType(TextField).last);
      tester.view.viewInsets = FakeViewPadding(
        bottom: tester.view.physicalSize.height / 2,
      );
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();

      // The prompt stays readable, the options collapse, and the
      // composer sits above the keyboard instead of being pushed off screen.
      expect(find.text('Who is this book for?'), findsOneWidget);
      expect(find.text('New managers'), findsNothing);
      expect(find.text('1.'), findsNothing);
      expect(buildButton, findsOneWidget);
      // Collapsing must not rebuild the composer's element: that would drop
      // focus and dismiss the keyboard the user just opened.
      final editable = tester.widget<EditableText>(
        find.byType(EditableText).last,
      );
      expect(editable.focusNode.hasFocus, isTrue);
      final keyboardTop =
          (tester.view.physicalSize.height - tester.view.viewInsets.bottom) /
          tester.view.devicePixelRatio;
      expect(
        tester.getRect(buildButton).bottom,
        lessThanOrEqualTo(keyboardTop),
      );
      expect(
        tester.getRect(find.byType(TextField).last).bottom,
        lessThanOrEqualTo(keyboardTop),
      );

      await tester.teardownScreen();
    },
  );

  testWidgets('attaching a document shows a ready chip and sends it with the '
      'message', (tester) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    final controller = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);
    await controller.attachFile(
      filename: 'outline.txt',
      bytes: const [104, 101, 108, 108, 111],
      isPhoto: false,
    );
    await tester.pumpAndSettle();

    expect(find.text('outline.txt'), findsOneWidget);
    expect(find.text('Ready to send'), findsOneWidget);

    await tester.enterText(find.byType(TextField).last, 'Use this outline');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages, contains('Use this outline'));
    expect(creation.sentAttachmentIds.last, ['att-1']);
    // The chip left the composer and now renders on the sent message bubble.
    expect(find.text('Ready to send'), findsNothing);
    expect(find.text('outline.txt'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a photo can be sent without any text, like a real chat', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    // The transcript photo falls back to the server copy, which needs asset
    // headers; the scripted projects repository keeps that request offline.
    await tester.pumpWidget(
      app(
        creation: creation,
        projects: PlanProjectsRepository(),
        startFresh: true,
      ),
    );
    await tester.pumpAndSettle();

    final controller = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);

    // Nothing attached and no text: send stays disabled.
    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNull,
    );

    await controller.attachFile(
      filename: 'cover-idea.jpg',
      bytes: const [1, 2, 3],
      isPhoto: true,
      mimeType: 'image/jpeg',
    );
    await tester.pumpAndSettle();

    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNotNull,
    );
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(creation.sentMessages.last, isEmpty);
    expect(creation.sentAttachmentIds.last, ['att-1']);

    // The server copy's URL is kept so the photo can render after an app
    // restart or on another device, where the local file path is gone.
    final state = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider);
    expect(
      state.attachmentUrls['att-1'],
      '/api/mobile/creation-sessions/draft-1/attachments/att-1/file',
    );

    await tester.teardownScreen();
  });

  testWidgets('failed uploads offer retry and removal', (tester) async {
    final creation = ScriptedCreationRepository()
      ..uploadError = Exception('network down');
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    final controller = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
    ).read(creationChatControllerProvider.notifier);
    await controller.attachFile(
      filename: 'draft.pdf',
      bytes: const [1, 2, 3],
      isPhoto: false,
    );
    await tester.pumpAndSettle();

    expect(find.text('Something went wrong. Try again.'), findsOneWidget);
    // Sending is not possible with only a failed attachment.
    expect(
      tester
          .widget<IconButton>(
            find.widgetWithIcon(IconButton, Icons.send_rounded),
          )
          .onPressed,
      isNull,
    );

    // The scripted upload error was consumed, so the retry succeeds.
    await tester.tap(find.text('Something went wrong. Try again.'));
    await tester.pumpAndSettle();

    expect(find.text('Ready to send'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close));
    await tester.pumpAndSettle();

    expect(find.text('draft.pdf'), findsNothing);
    expect(creation.deletedAttachmentIds, ['att-1']);

    await tester.teardownScreen();
  });

  testWidgets('failed sends keep the message with retry and dismiss', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository()
      ..sendError = Exception('offline');
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'Hello book');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(find.text('Hello book'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Dismiss'), findsOneWidget);

    creation.sendError = null;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(find.text(reply), findsOneWidget);
    expect(find.text('Retry'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('server warnings render above the transcript', (tester) async {
    final creation = ScriptedCreationRepository()
      ..replyWarnings = const ['Keep the tone gentle for young readers.'];
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'A bedtime story');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    expect(
      find.text('Keep the tone gentle for young readers.'),
      findsOneWidget,
    );

    await tester.teardownScreen();
  });

  testWidgets('attach menu offers photos, documents, and pasted notes', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Attach a photo, document, or notes'));
    await tester.pumpAndSettle();

    expect(find.text('Photo library'), findsOneWidget);
    expect(find.text('Take a photo'), findsOneWidget);
    expect(find.text('Document'), findsOneWidget);
    expect(find.text('Paste text notes'), findsOneWidget);

    await tester.tap(find.text('Paste text notes'));
    await tester.pumpAndSettle();

    expect(find.text('Source notes'), findsWidgets);

    await tester.teardownScreen();
  });

  testWidgets('a new chat started mid-send survives switching chats', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository()..sendGate = sendGate.future;
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Switch to another chat while the first send is still running.
    await tester.pumpWidget(app(creation: creation, draftId: 'draft-b'));
    await tester.pumpAndSettle();
    expect(find.text('Selected chat draft-b'), findsOneWidget);

    final container = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
      listen: false,
    );
    final callsBefore = creation.listSessionsCalls;

    sendGate.complete();
    await tester.pumpAndSettle();

    // The created chat is cached and the drawer list refetched, so it is
    // reachable again without reopening the app.
    expect(
      container.read(creationConversationCacheProvider).readById('draft-1'),
      isNotNull,
    );
    expect(creation.listSessionsCalls, greaterThan(callsBefore));
    // The chat the user switched to is untouched by the stale response.
    expect(find.text('Selected chat draft-b'), findsOneWidget);
    expect(find.text(reply), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('drawer shows an in-progress tile for a chat being created', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository(sessions: <MobileChatSession>[])
      ..sendGate = sendGate.future;
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Timed pumps: the pending tile's indeterminate spinner animates forever,
    // so pumpAndSettle would never settle while the send is in flight.
    await tester.tap(find.byTooltip('Open navigation menu'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final drawerTile = find.descendant(
      of: find.byType(ChatHistoryDrawer),
      matching: find.text('My new book idea'),
    );
    expect(find.text('In progress'), findsOneWidget);
    expect(drawerTile, findsOneWidget);
    expect(find.text('Creating…'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(ChatHistoryDrawer),
        matching: find.byType(CircularProgressIndicator),
      ),
      findsOneWidget,
    );

    // Tapping while still creating explains instead of navigating.
    await tester.tap(drawerTile);
    await tester.pump();
    expect(
      find.text('Still creating this chat — it will be ready in a moment.'),
      findsOneWidget,
    );
    expect(find.byType(ChatHistoryDrawer), findsOneWidget);

    // Once the send finishes and the refreshed list contains the chat, the
    // real tile takes over.
    creation.sessions.add(
      chatSession(draftId: 'draft-1', title: 'My new book idea'),
    );
    sendGate.complete();
    await tester.pumpAndSettle();

    expect(find.text('In progress'), findsNothing);
    expect(find.text('Creating…'), findsNothing);
    expect(drawerTile, findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a failed send after switching chats does not touch the open '
      'chat', (tester) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository()..sendGate = sendGate.future;
    await tester.pumpWidget(app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    await tester.pumpWidget(app(creation: creation, draftId: 'draft-b'));
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
      listen: false,
    );

    sendGate.completeError(Exception('offline'));
    await tester.pumpAndSettle();

    final state = container.read(creationChatControllerProvider);
    expect(state.initError, isNull);
    expect(state.messages.any((message) => message.isFailedSend), isFalse);
    expect(container.read(pendingChatSessionsProvider), isEmpty);
    expect(find.text('Selected chat draft-b'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('a new chat finishing after leaving the screen is still saved', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = ScriptedCreationRepository()..sendGate = sendGate.future;

    Widget shell(Widget home) => ProviderScope(
      overrides: [
        creationRepositoryProvider.overrideWithValue(creation),
        billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
      ],
      child: MaterialApp(theme: buildTomezaLightTheme(), home: home),
    );

    await tester.pumpWidget(shell(const CreationChatScreen(startFresh: true)));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Leave the chat area entirely; the controller has no listeners left.
    await tester.pumpWidget(shell(const Scaffold(body: Text('Account'))));
    await tester.pump();

    final container = ProviderScope.containerOf(
      tester.element(find.text('Account')),
      listen: false,
    );

    sendGate.complete();
    await tester.pumpAndSettle();

    expect(
      container.read(creationConversationCacheProvider).readById('draft-1'),
      isNotNull,
    );
    final pending = container.read(pendingChatSessionsProvider);
    expect(pending, hasLength(1));
    expect(pending.single.draftId, 'draft-1');

    await tester.teardownScreen();
  });
}
