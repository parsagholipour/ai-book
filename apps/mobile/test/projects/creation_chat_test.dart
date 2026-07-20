import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_drawer.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';
import 'package:tomeza/features/projects/presentation/pending_chat_sessions.dart';
import 'package:tomeza/features/projects/presentation/project_detail_screen.dart';

const _greeting = 'Tell me about the book you want to make.';
const _reply = 'Great, that is enough for a solid first plan.';
const _planTitle = 'Launch Course Workbook';

void main() {
  testWidgets('greeting and quick replies render; build is gated until ready', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    expect(find.text('New book'), findsOneWidget);
    expect(find.text(_greeting), findsOneWidget);
    expect(find.text('A kids book'), findsOneWidget);
    expect(creation.startedMessages, isEmpty);

    final buildFinder = find.widgetWithText(FilledButton, 'Build the plan');
    expect(tester.widget<FilledButton>(buildFinder).onPressed, isNull);

    await tester.teardownScreen();
  });

  testWidgets('quick reply chips scroll; only an edge swipe opens the drawer', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository()
      ..greetingQuickReplies = const [
        'Bedtime story for 5 year olds',
        'Lead magnet about pricing',
        'Workbook for new coaches',
        'Short story about a garden mystery',
      ];
    await tester.pumpWidget(_app(creation: creation));
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
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    expect(creation.startedMessages, contains('A kids book'));
    expect(creation.sentMessages, contains('A kids book'));
    expect(find.text(_reply), findsOneWidget);

    final buildFinder = find.widgetWithText(FilledButton, 'Build the plan');
    expect(tester.widget<FilledButton>(buildFinder).onPressed, isNotNull);

    await tester.teardownScreen();
  });

  testWidgets('holding a message shows a copy option', (tester) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.longPress(find.text(_greeting));
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

    expect(copiedText, _greeting);
    expect(find.text('Message copied'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('editing a sent message forks a branch with arrows', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    // Long-press the sent user bubble and pick Edit. (The session title also
    // echoes the message, so scope the lookup to the transcript list.)
    await tester.longPress(_bubbleText('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();

    // The composer switches into edit mode with the original text loaded.
    expect(find.text('Editing message'), findsOneWidget);
    final composer = tester.widget<TextField>(find.byType(TextField).first);
    expect(composer.controller?.text, 'A kids book');

    await tester.enterText(find.byType(TextField).first, 'A space adventure');
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();

    // The edit was sent as a fork of the original message.
    expect(creation.editRequests, ['user-current']);
    expect(creation.sentMessages.last, 'A space adventure');
    expect(find.text('Editing message'), findsNothing);
    expect(_bubbleText('A space adventure'), findsOneWidget);
    expect(_bubbleText('A kids book'), findsNothing);
    expect(find.text('2/2'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('branch arrows switch back to the previous thread', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.longPress(_bubbleText('A kids book'));
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
    expect(_bubbleText('A kids book'), findsOneWidget);
    expect(_bubbleText('A space adventure'), findsNothing);
    expect(find.text('1/2'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('cancelling an edit restores the normal composer', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.longPress(_bubbleText('A kids book'));
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
      final creation = _ScriptedCreationRepository();
      await tester.pumpWidget(_app(creation: creation));
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
      final creation = _ScriptedCreationRepository();
      await tester.pumpWidget(_app(creation: creation));
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
        imagesEnabled: true,
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
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(creation.buildPresets?.targetPages, 14);
      expect(creation.buildPresets?.pageCountSource, 'settings');

      await tester.teardownScreen();
    },
  );

  testWidgets('build asks for pages when preflight requires a page count', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      preflightRequiresPageCount: true,
    );
    await tester.pumpWidget(
      _app(creation: creation, projects: _PlanProjectsRepository()),
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
      imagesEnabled: true,
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
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));

    expect(creation.buildPresets?.targetPages, 8);
    expect(creation.buildPresets?.pageCountSource, 'recommended');

    await tester.teardownScreen();
  });

  testWidgets('building shows the generated plan in-chat', (tester) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(
      _app(creation: creation, projects: _PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
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
    expect(find.text(_planTitle), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'answering plan questions keeps revision loading instead of restarting',
    (tester) async {
      final creation = _ScriptedCreationRepository();
      final projects = _PlanProjectsRepository(
        project: _plannedProject(plan: _questionPlan()),
      );
      await tester.pumpWidget(_app(creation: creation, projects: projects));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A kids book'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Question 1 of 2'), findsOneWidget);

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

  testWidgets(
    'failed plan revision clears spinner and keeps old plan visible',
    (tester) async {
      final creation = _ScriptedCreationRepository();
      final projects = _PlanProjectsRepository(
        project: _plannedProject(plan: _questionPlan()),
      );
      await tester.pumpWidget(_app(creation: creation, projects: projects));
      await tester.pumpAndSettle();

      await tester.tap(find.text('A kids book'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
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
        find.text(
          'Plan revision failed. Your previous plan is still available.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('Revising your book plan'), findsNothing);
      expect(find.text(_planTitle), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('changing draftId reloads the selected chat', (tester) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation, draftId: 'draft-a'));
    await tester.pumpAndSettle();

    expect(find.text('Title for draft-a'), findsOneWidget);
    expect(find.text('Selected chat draft-a'), findsOneWidget);

    await tester.pumpWidget(_app(creation: creation, draftId: 'draft-b'));
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
      final creation = _ScriptedCreationRepository();
      await tester.pumpWidget(_app(creation: creation, draftId: 'draft-a'));
      await tester.pumpAndSettle();

      expect(find.text('Selected chat draft-a'), findsOneWidget);

      await tester.pumpWidget(_app(creation: creation, draftId: 'draft-b'));
      await tester.pumpAndSettle();

      final refreshGate = Completer<void>();
      creation.resumeByIdGate = refreshGate.future;
      creation.resumeAssistantMessages['draft-a'] = 'Refreshed chat draft-a';

      await tester.pumpWidget(_app(creation: creation, draftId: 'draft-a'));
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
    final creation = _ScriptedCreationRepository(
      resumeByIdGate: resumeGate.future,
      sessions: [_chatSession(draftId: 'draft-a', title: 'Title for draft-a')],
    );
    await tester.pumpWidget(_app(creation: creation, draftId: 'draft-a'));
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
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(draftId: 'draft-a', title: 'Title for draft-a'),
        _chatSession(draftId: 'draft-b', title: 'Title for draft-b'),
      ],
    );
    await tester.pumpWidget(_app(creation: creation, draftId: 'draft-a'));
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

  testWidgets('completed drawer chat opens chat history with the plan', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(draftId: 'draft-a', title: 'Active idea'),
        _chatSession(
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
      _routerApp(
        creation: creation,
        projects: _PlanProjectsRepository(),
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
    expect(find.text(_planTitle), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsNothing);
    expect(find.text('Approve and start writing'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('resuming a completed chat loads its linked plan in-chat', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = _PlanProjectsRepository();

    await tester.pumpWidget(
      _app(creation: creation, projects: projects, draftId: 'draft-done'),
    );
    await tester.pumpAndSettle();

    expect(creation.resumedDraftIds, ['draft-done']);
    expect(projects.requestedProjectIds, ['project-1']);
    expect(find.text('Completed idea'), findsOneWidget);
    expect(find.text('Original completed chat transcript'), findsOneWidget);
    expect(find.text(_planTitle), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Build the plan'), findsNothing);
    expect(find.text('Approve and start writing'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('completed chat keeps composer for plan edits', (tester) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = _PlanProjectsRepository();

    await tester.pumpWidget(
      _app(creation: creation, projects: projects, draftId: 'draft-done'),
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
    final creation = _ScriptedCreationRepository();
    final projects = _PlanProjectsRepository();

    await tester.pumpWidget(_app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
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
    final creation = _ScriptedCreationRepository();
    final projects = _PlanProjectsRepository(
      project: _plannedProject(plan: _plan(title: 'Original launch plan')),
    );

    await tester.pumpWidget(_app(creation: creation, projects: projects));
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
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

  testWidgets('approved linked plan is compact and opens plan page', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = _PlanProjectsRepository(
      project: _plannedProject(
        status: 'generating',
        currentAction: 'Writing your book.',
        plan: _approvedPlan(),
      ),
    );

    await tester.pumpWidget(
      _routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Book plan approved'), findsOneWidget);
    expect(find.text('Tap to open plan page'), findsOneWidget);
    expect(find.text('Approve and start writing'), findsNothing);
    expect(find.text('Premise'), findsNothing);

    await tester.tap(find.text('Tap to open plan page'));
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byType(AppBar),
        matching: find.text('Book plan'),
      ),
      findsOneWidget,
    );
    expect(find.text('Premise'), findsOneWidget);
    expect(find.text('Audience'), findsOneWidget);
    expect(find.text('Set the promise'), findsOneWidget);
    expect(find.text('This plan is approved.'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('approved generating plan shows compact progress in chat', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = _PlanProjectsRepository(
      project: _plannedProject(
        status: 'generating',
        currentAction: 'Writing your book.',
        plan: _approvedPlan(),
      ),
      status: _projectStatus(
        progressPercent: 38,
        currentAction: 'Writing your book pages.',
        completedPages: 3,
        targetPages: 28,
        imageCount: 1,
      ),
    );

    await tester.pumpWidget(
      _routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Book plan approved'), findsOneWidget);
    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing your book pages.'), findsOneWidget);
    expect(find.text('38%'), findsOneWidget);
    expect(find.text('3/28 pages'), findsOneWidget);
    expect(find.text('1 visual'), findsOneWidget);
    expect(find.text('View progress'), findsOneWidget);

    await tester.tap(find.text('View progress'));
    await tester.pumpAndSettle();

    expect(find.text('Progress route project-1'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('completed generation downloads an unlocked export in chat', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed idea',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] =
        'Original completed chat transcript';
    final projects = _PlanProjectsRepository(
      project: _plannedProject(
        status: 'complete',
        currentAction: 'Ready to download.',
        plan: _approvedPlan(),
      ),
      status: _projectStatus(
        status: 'complete',
        progressPercent: 100,
        currentAction: 'Ready to download.',
        completedPages: 28,
        targetPages: 28,
        imageCount: 1,
        exports: _unlockedExports,
      ),
    );

    await tester.pumpWidget(
      _routerApp(
        creation: creation,
        projects: projects,
        initialLocation: '/books/chat/draft-done',
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Ready to export'), findsOneWidget);
    expect(find.text('Get PDF'), findsOneWidget);
    expect(find.text('View progress'), findsOneWidget);

    await tester.tap(find.text('Get PDF'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(projects.openedFormats, ['pdf']);

    await tester.teardownScreen();
  });

  testWidgets(
    'failed generation keeps approved plan and shows attention copy',
    (tester) async {
      final creation = _ScriptedCreationRepository(
        sessions: [
          _chatSession(
            draftId: 'draft-done',
            title: 'Completed idea',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
          ),
        ],
      );
      creation.resumeAssistantMessages['draft-done'] =
          'Original completed chat transcript';
      final projects = _PlanProjectsRepository(
        project: _plannedProject(
          status: 'failed',
          currentAction: 'Needs attention.',
          plan: _approvedPlan(),
        ),
        status: _projectStatus(
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
        _routerApp(
          creation: creation,
          projects: projects,
          initialLocation: '/books/chat/draft-done',
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Book plan approved'), findsOneWidget);
      expect(find.text(_planTitle), findsOneWidget);
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
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = _PlanProjectsRepository(
      project: _plannedProject(status: 'complete', plan: _approvedPlan()),
    );

    await tester.pumpWidget(
      _app(creation: creation, projects: projects, draftId: 'draft-done'),
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

  testWidgets(
    'editing a brainstorm message after build forks a creation branch',
    (tester) async {
      final creation = _ScriptedCreationRepository(
        sessions: [
          _chatSession(
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
      final projects = _PlanProjectsRepository(
        project: _plannedProject(status: 'complete', plan: _approvedPlan()),
      );

      await tester.pumpWidget(
        _app(creation: creation, projects: projects, draftId: 'draft-done'),
      );
      await tester.pumpAndSettle();

      // The built plan renders below the brainstorm before the edit.
      expect(find.text(_planTitle), findsOneWidget);

      await tester.longPress(_bubbleText('Original brainstorm idea'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Edit'));
      await tester.pumpAndSettle();

      // The output-stage composer is reused for the brainstorm edit.
      expect(find.text('Editing message'), findsOneWidget);
      final composer = tester.widget<TextField>(find.byType(TextField).first);
      expect(composer.controller?.text, 'Original brainstorm idea');

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
      expect(_bubbleText('A better brainstorm'), findsOneWidget);
      expect(find.text('2/2'), findsOneWidget);
      // The old branch's plan left the view and the chat is back in the
      // pre-build stage, ready to build a new output from the fork.
      expect(find.text(_planTitle), findsNothing);
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
      final creation = _ScriptedCreationRepository(replyWithBuildRequest: true);
      await tester.pumpWidget(
        _app(creation: creation, projects: _PlanProjectsRepository()),
      );
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).last, 'Ok, build it');
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(milliseconds: 50));

      expect(creation.buildCount, 1);
      expect(creation.buildDraftId, 'draft-1');
      expect(find.text(_planTitle), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets('assistant content cards render book content in the chat', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
          draftId: 'draft-done',
          title: 'Completed book',
          status: 'COMPLETED',
          createdProjectId: 'project-1',
        ),
      ],
    );
    creation.resumeAssistantMessages['draft-done'] = 'Book transcript';
    final projects = _PlanProjectsRepository(
      project: _plannedProject(status: 'complete', plan: _approvedPlan()),
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
      _app(creation: creation, projects: projects, draftId: 'draft-done'),
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
    final originalOutput = _creationOutput(
      projectId: 'project-1',
      title: 'Original book',
      sequence: 1,
    );
    final englishOutput = _creationOutput(
      projectId: 'project-2',
      title: 'English book',
      sequence: 2,
    );
    final creation = _ScriptedCreationRepository(
      sessions: [
        _chatSession(
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
    final projects = _PlanProjectsRepository(
      project: _plannedProject(status: 'complete', plan: _approvedPlan()),
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
      _app(creation: creation, projects: projects, draftId: 'draft-done'),
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
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(
      _app(creation: creation, projects: _PlanProjectsRepository()),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    await tester.tap(find.byTooltip('New output in this chat'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final chips = tester.widgetList<FilterChip>(find.byType(FilterChip));
    expect(creation.buildCount, 2);
    expect(chips, hasLength(2));
    expect(chips.last.selected, isTrue);
    expect(find.text(_planTitle), findsWidgets);

    await tester.teardownScreen();
  });

  testWidgets('fresh new chat is saved only after the first message', (
    tester,
  ) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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
    expect(find.text(_reply), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'composer hint only mentions answering when a question is active',
    (tester) async {
      final creation = _ScriptedCreationRepository(replyWithQuestion: true);
      await tester.pumpWidget(_app(creation: creation, startFresh: true));
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

  testWidgets(
    'typing with a question active keeps the composer above the keyboard '
    'and collapses the options',
    (tester) async {
      final creation = _ScriptedCreationRepository(replyWithQuestion: true);
      await tester.pumpWidget(_app(creation: creation, startFresh: true));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byType(TextField).last,
        'A practical guide for new managers',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('Send'));
      await tester.pumpAndSettle();
      expect(find.text('Who is this book for?'), findsOneWidget);

      // Focus the composer and simulate the keyboard taking the bottom half
      // of the screen. Any footer overflow would fail the test here.
      await tester.showKeyboard(find.byType(TextField).last);
      tester.view.viewInsets = FakeViewPadding(
        bottom: tester.view.physicalSize.height / 2,
      );
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();

      // The prompt stays readable, the option chips collapse, and the
      // composer sits above the keyboard instead of being pushed off screen.
      expect(find.text('Who is this book for?'), findsOneWidget);
      expect(find.byType(ActionChip), findsNothing);
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
        tester.getRect(find.byType(TextField).last).bottom,
        lessThanOrEqualTo(keyboardTop),
      );

      await tester.teardownScreen();
    },
  );

  testWidgets('attaching a document shows a ready chip and sends it with the '
      'message', (tester) async {
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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
    final creation = _ScriptedCreationRepository();
    // The transcript photo falls back to the server copy, which needs asset
    // headers; the scripted projects repository keeps that request offline.
    await tester.pumpWidget(
      _app(
        creation: creation,
        projects: _PlanProjectsRepository(),
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
    final creation = _ScriptedCreationRepository()
      ..uploadError = Exception('network down');
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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
    final creation = _ScriptedCreationRepository()
      ..sendError = Exception('offline');
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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

    expect(find.text(_reply), findsOneWidget);
    expect(find.text('Retry'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('server warnings render above the transcript', (tester) async {
    final creation = _ScriptedCreationRepository()
      ..replyWarnings = const ['Keep the tone gentle for young readers.'];
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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
    final creation = _ScriptedCreationRepository();
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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
    final creation = _ScriptedCreationRepository()..sendGate = sendGate.future;
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    // Switch to another chat while the first send is still running.
    await tester.pumpWidget(_app(creation: creation, draftId: 'draft-b'));
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
    expect(find.text(_reply), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('drawer shows an in-progress tile for a chat being created', (
    tester,
  ) async {
    final sendGate = Completer<void>();
    final creation = _ScriptedCreationRepository(
      sessions: <MobileChatSession>[],
    )..sendGate = sendGate.future;
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
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
      _chatSession(draftId: 'draft-1', title: 'My new book idea'),
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
    final creation = _ScriptedCreationRepository()..sendGate = sendGate.future;
    await tester.pumpWidget(_app(creation: creation, startFresh: true));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'My new book idea');
    await tester.pump();
    await tester.tap(find.byTooltip('Send'));
    await tester.pump();

    await tester.pumpWidget(_app(creation: creation, draftId: 'draft-b'));
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
    final creation = _ScriptedCreationRepository()..sendGate = sendGate.future;

    Widget shell(Widget home) => ProviderScope(
      overrides: [
        creationRepositoryProvider.overrideWithValue(creation),
        billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
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

extension on WidgetTester {
  /// Tears down the screen so its polling timer and tickers are cancelled.
  Future<void> teardownScreen() async {
    await pumpWidget(const SizedBox());
    await pump();
  }
}

/// Text inside the transcript list (excludes app bar title and footer chips).
Finder _bubbleText(String text) =>
    find.descendant(of: find.byType(ListView), matching: find.text(text));

Widget _app({
  required _ScriptedCreationRepository creation,
  ProjectsRepository? projects,
  String? draftId,
  bool startFresh = false,
}) {
  return ProviderScope(
    overrides: [
      creationRepositoryProvider.overrideWithValue(creation),
      if (projects != null)
        projectsRepositoryProvider.overrideWithValue(projects),
      billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
    ],
    child: MaterialApp(
      theme: buildTomezaLightTheme(),
      home: CreationChatScreen(draftId: draftId, startFresh: startFresh),
    ),
  );
}

Widget _routerApp({
  required _ScriptedCreationRepository creation,
  required ProjectsRepository projects,
  required String initialLocation,
}) {
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/books/new',
        builder: (context, state) =>
            const Scaffold(body: Text('New book route')),
      ),
      GoRoute(
        path: '/books/chat/:draftId',
        builder: (context, state) =>
            CreationChatScreen(draftId: state.pathParameters['draftId']),
      ),
      GoRoute(
        path: '/projects/:id/handoff',
        builder: (context, state) => Scaffold(
          body: Text('Progress route ${state.pathParameters['id']}'),
        ),
      ),
      GoRoute(
        path: '/projects/:id',
        builder: (context, state) =>
            ProjectDetailScreen(projectId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/account',
        builder: (context, state) => const Scaffold(body: Text('Account')),
      ),
    ],
  );

  return ProviderScope(
    overrides: [
      creationRepositoryProvider.overrideWithValue(creation),
      projectsRepositoryProvider.overrideWithValue(projects),
      billingRepositoryProvider.overrideWithValue(_FakeBillingRepository()),
    ],
    child: MaterialApp.router(
      theme: buildTomezaLightTheme(),
      routerConfig: router,
    ),
  );
}

Map<String, dynamic> _turnJson({
  required String assistantMessage,
  required bool canBuild,
  List<String> quickReplies = const [],
  Map<String, dynamic>? question,
  int? targetPages,
  bool buildRequested = false,
  List<String> warnings = const [],
}) {
  return {
    'assistantMessage': assistantMessage,
    'brief': {'lane': 'auto'},
    'presets': {
      'bookType': 'lead_magnet',
      'bookTypeChoice': 'auto',
      'lengthPreset': 'short',
      'qualityPreset': 'balanced',
      'imagesEnabled': true,
      'pageCountMode': targetPages == null ? 'auto' : 'custom',
      'targetPages': ?targetPages,
      'pageCountSource': ?(targetPages == null ? null : 'chat'),
    },
    'detectedLane': 'auto',
    'quickReplies': quickReplies,
    'question': question,
    'readiness': {
      'score': canBuild ? 80 : 10,
      'canBuild': canBuild,
      'missing': <dynamic>[],
    },
    'titleSuggestions': <dynamic>[],
    'shapePreview': ['Intro'],
    'warnings': warnings,
    'buildRequested': buildRequested,
  };
}

MobileChatSession _chatSession({
  required String draftId,
  required String title,
  String status = 'ACTIVE',
  String? createdProjectId,
  String? activeProjectId,
  List<MobileCreationOutput> outputs = const [],
}) {
  final now = DateTime.utc(2026, 6, 15);
  return MobileChatSession(
    draftId: draftId,
    title: title,
    preview: 'Latest message',
    messageCount: 2,
    status: status,
    createdProjectId: createdProjectId,
    activeProjectId: activeProjectId ?? createdProjectId,
    outputs: outputs,
    createdAt: now,
    updatedAt: now,
  );
}

MobileCreationOutput _creationOutput({
  required String projectId,
  required String title,
  required int sequence,
}) {
  final now = DateTime.utc(2026, 6, 15, 12, sequence);
  return MobileCreationOutput(
    id: 'output-$sequence',
    draftId: 'draft-done',
    projectId: projectId,
    title: title,
    sequence: sequence,
    createdAt: now,
    updatedAt: now,
  );
}

class _ScriptedCreationRepository implements CreationRepository {
  _ScriptedCreationRepository({
    this.replyWithQuestion = false,
    this.replyWithBuildRequest = false,
    this.preflightRequiresPageCount = false,
    this.resumeByIdGate,
    List<MobileChatSession>? sessions,
  }) : sessions = sessions ?? const <MobileChatSession>[];

  final bool replyWithQuestion;
  final bool replyWithBuildRequest;
  final bool preflightRequiresPageCount;
  final List<MobilePageCountRecommendation> preflightRecommendations = const [
    MobilePageCountRecommendation(
      targetPages: 8,
      label: '8 pages',
      description: 'Recommended for a compact book.',
    ),
    MobilePageCountRecommendation(
      targetPages: 12,
      label: '12 pages',
      description: 'More room for detail.',
    ),
  ];
  Future<void>? resumeByIdGate;

  /// When set, message sends (including the one starting a new chat) wait on
  /// this before responding; completing it with an error fails the send.
  Future<void>? sendGate;
  int listSessionsCalls = 0;
  final List<MobileChatSession> sessions;
  final sentMessages = <String>[];
  final sentAttachmentIds = <List<String>>[];
  final startedMessages = <String>[];
  final editRequests = <String>[];
  final branchSwitches = <({String messageId, String direction})>[];
  final uploadedAttachments = <String, MobileCreationAttachment>{};
  final deletedAttachmentIds = <String>[];
  Object? uploadError;
  Object? sendError;
  List<String> replyWarnings = const [];
  List<String> greetingQuickReplies = const ['A kids book', 'A workbook'];
  int uploadCount = 0;
  final resumedDraftIds = <String>[];
  final resumeAssistantMessages = <String, String>{};
  final resumeMessages = <String, List<Map<String, dynamic>>>{};
  final resumeSyncedOutputs = <String, List<MobileCreationOutput>>{};
  MobileCreationPresets? buildPresets;
  String? buildDraftId;
  int buildCount = 0;

  @override
  Future<List<MobileChatSession>> listSessions() async {
    listSessionsCalls++;
    return List.of(sessions);
  }

  @override
  Future<void> renameSession({
    required String draftId,
    required String title,
    int? expectedRevision,
  }) async {}

  @override
  Future<void> deleteSession(String draftId) async {}

  @override
  Future<MobileCreationConversationResponse> resumeConversation() async {
    return MobileCreationConversationResponse.fromJson({
      'turn': _turnJson(
        assistantMessage: _greeting,
        canBuild: false,
        quickReplies: greetingQuickReplies,
      ),
    });
  }

  @override
  Future<MobileCreationConversationResponse> resumeConversationById(
    String draftId,
  ) async {
    resumedDraftIds.add(draftId);
    await resumeByIdGate;
    final session = _sessionFor(draftId);
    final resumeCount = resumedDraftIds.where((id) => id == draftId).length;
    final sessionOutputs = session?.outputs ?? const <MobileCreationOutput>[];
    final outputs = resumeCount > 1
        ? resumeSyncedOutputs[draftId] ?? sessionOutputs
        : sessionOutputs;
    final assistantMessage =
        resumeAssistantMessages[draftId] ?? 'Selected chat $draftId';
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': draftId,
        'title': session?.title ?? 'Title for $draftId',
        'status': session?.status ?? 'ACTIVE',
        'messages':
            resumeMessages[draftId] ??
            [
              {'role': 'assistant', 'content': assistantMessage},
            ],
        'createdProjectId': session?.createdProjectId,
        'activeProjectId': session?.activeProjectId,
        'outputs': [
          for (final output in outputs)
            {
              'id': output.id,
              'draftId': output.draftId,
              'projectId': output.projectId,
              'title': output.title,
              'sequence': output.sequence,
              'createdAt': output.createdAt.toIso8601String(),
              'updatedAt': output.updatedAt.toIso8601String(),
            },
        ],
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson(
        assistantMessage: assistantMessage,
        canBuild: false,
        quickReplies: const [],
      ),
    });
  }

  MobileChatSession? _sessionFor(String draftId) {
    for (final session in sessions) {
      if (session.draftId == draftId) {
        return session;
      }
    }
    return null;
  }

  @override
  Future<MobileCreationConversationResponse> startConversation({
    String? message,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? requestId,
  }) async {
    if (message != null) {
      startedMessages.add(message);
      return sendConversationMessage(draftId: 'draft-1', message: message);
    }
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': 'New book',
        'status': 'ACTIVE',
        'messages': [
          {'role': 'assistant', 'content': _greeting},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson(
        assistantMessage: _greeting,
        canBuild: false,
        quickReplies: greetingQuickReplies,
      ),
    });
  }

  @override
  Future<MobileCreationConversationResponse> sendConversationMessage({
    required String draftId,
    required String message,
    List<String>? attachmentIds,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? editMessageId,
    String? requestId,
    int? expectedRevision,
  }) async {
    await sendGate;
    final error = sendError;
    if (error != null) {
      throw error;
    }
    if (editMessageId != null) {
      // An edit forks a branch: remember the replaced text for switch-back.
      editRequests.add(editMessageId);
      _originalUserContent ??= sentMessages.isEmpty ? null : sentMessages.last;
    }
    sentMessages.add(message);
    sentAttachmentIds.add(attachmentIds ?? const <String>[]);
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': message,
        'status': 'ACTIVE',
        'messages': [
          {
            'id': 'assistant-greeting',
            'role': 'assistant',
            'content': _greeting,
          },
          {
            'id': 'user-current',
            'role': 'user',
            'content': message,
            if (editMessageId != null)
              'branch': {
                'index': 2,
                'total': 2,
                'canGoPrevious': true,
                'canGoNext': false,
              },
            if (attachmentIds != null && attachmentIds.isNotEmpty)
              'attachments': [
                for (final id in attachmentIds)
                  {
                    'id': id,
                    'kind': uploadedAttachments[id]?.kind ?? 'document',
                    'name': uploadedAttachments[id]?.name ?? 'file',
                  },
              ],
          },
          {'id': 'assistant-reply', 'role': 'assistant', 'content': _reply},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson(
        assistantMessage: _reply,
        canBuild: !replyWithQuestion,
        quickReplies: replyWithQuestion ? const [] : const ['Make it shorter'],
        question: replyWithQuestion
            ? const {
                'prompt': 'Who is this book for?',
                'options': ['New managers', 'Team leads'],
                'allowCustom': true,
              }
            : null,
        buildRequested: replyWithBuildRequest,
        warnings: replyWarnings,
      ),
    });
  }

  /// Text of the user turn that was replaced by the most recent edit.
  String? _originalUserContent;

  @override
  Future<MobileCreationConversationResponse> switchConversationBranch({
    required String draftId,
    required String messageId,
    required String direction,
    int? expectedRevision,
  }) async {
    branchSwitches.add((messageId: messageId, direction: direction));
    final showOriginal = direction == 'previous';
    final content = showOriginal
        ? (_originalUserContent ?? 'Original message')
        : (sentMessages.isEmpty ? 'Edited message' : sentMessages.last);
    return MobileCreationConversationResponse.fromJson({
      'session': {
        'draftId': 'draft-1',
        'title': content,
        'status': 'ACTIVE',
        'messages': [
          {
            'id': 'assistant-greeting',
            'role': 'assistant',
            'content': _greeting,
          },
          {
            'id': 'user-current',
            'role': 'user',
            'content': content,
            'branch': {
              'index': showOriginal ? 1 : 2,
              'total': 2,
              'canGoPrevious': !showOriginal,
              'canGoNext': showOriginal,
            },
          },
          {'id': 'assistant-reply', 'role': 'assistant', 'content': _reply},
        ],
        'createdProjectId': null,
        'updatedAt': '2026-06-15T00:00:00.000Z',
      },
      'turn': _turnJson(
        assistantMessage: '',
        canBuild: true,
        quickReplies: const [],
      ),
    });
  }

  @override
  Future<MobileCreationFinalizeResponse> buildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
    String? requestId,
    int? expectedRevision,
  }) async {
    buildDraftId = draftId;
    buildPresets = presets;
    buildCount += 1;
    final projectId = 'project-$buildCount';
    final project = _plannedProject(id: projectId);
    return MobileCreationFinalizeResponse(
      project: project,
      output: MobileCreationOutput(
        id: 'output-$buildCount',
        draftId: draftId,
        projectId: projectId,
        title: project.title,
        sequence: buildCount,
        createdAt: DateTime.utc(2026, 6, 15, 12, buildCount),
        updatedAt: DateTime.utc(2026, 6, 15, 12, buildCount),
      ),
      operation: MobilePlanOperation(
        projectId: projectId,
        planId: 'plan-1',
        status: 'planning_queued',
        currentAction: 'Building your plan.',
        job: const MobileQueuedJob(
          id: 'job-1',
          status: 'queued',
          currentAction: 'Building your plan.',
        ),
      ),
    );
  }

  @override
  Future<MobileCreationBuildPreflight> preflightBuildConversation({
    required String draftId,
    MobileCreationPresets? presets,
    String? sourceNotes,
    MobileCreationOptionalDetails? optionalDetails,
    String? language,
  }) async {
    return MobileCreationBuildPreflight(
      requiresPageCount: preflightRequiresPageCount,
      recommendations: preflightRecommendations,
      detectedPageCount: preflightRequiresPageCount
          ? null
          : const MobileDetectedPageCount(targetPages: 8, source: 'chat'),
    );
  }

  @override
  Future<MobileCreationDraft?> getActiveDraft() async => null;

  @override
  Future<MobileCreationDraft> createDraft(MobileCreationDraftPayload payload) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationDraft> updateDraft({
    required String id,
    required MobileCreationDraftPayload payload,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<MobileBookAdvisorResponse> adviseBook(
    MobileCreationDraftPayload payload,
  ) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationFinalizeResponse> finalizeDraft(String id) {
    throw UnimplementedError();
  }

  @override
  Future<MobileCreationAttachment> uploadAttachment({
    required String draftId,
    required List<int> bytes,
    required String filename,
    String? mimeType,
    void Function(int sent, int total)? onProgress,
    int? expectedRevision,
  }) async {
    final error = uploadError;
    if (error != null) {
      uploadError = null;
      throw error;
    }
    uploadCount += 1;
    final attachment = MobileCreationAttachment(
      id: 'att-$uploadCount',
      kind: (mimeType ?? '').startsWith('image/') ? 'photo' : 'document',
      name: filename,
      sizeBytes: bytes.length,
      summary: 'Summary of $filename',
      url:
          '/api/mobile/creation-sessions/$draftId/attachments/att-$uploadCount/file',
    );
    uploadedAttachments[attachment.id] = attachment;
    return attachment;
  }

  @override
  Future<int?> deleteAttachment({
    required String draftId,
    required String attachmentId,
    int? expectedRevision,
  }) async {
    deletedAttachmentIds.add(attachmentId);
    return expectedRevision;
  }
}

class _PlanProjectsRepository implements ProjectsRepository {
  _PlanProjectsRepository({MobileProjectDetail? project, this.status})
    : project = project ?? _plannedProject() {
    final plan = this.project.plan;
    if (plan != null) {
      planSnapshots.add(plan);
    }
  }

  MobileProjectDetail project;
  MobileProjectStatus? status;
  final revisionMessages = <String>[];
  final requestedProjectIds = <String>[];
  final chatMessages = <MobileProjectChatMessage>[];
  final planSnapshots = <MobilePlan>[];
  final chatOperations = <MobileBookEditOperation>[];
  final downloadedFormats = <String>[];
  final openedFormats = <String>[];

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    requestedProjectIds.add(id);
    return project.id == id ? project : _plannedProject(id: id);
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    return status ??
        _projectStatusFromProject(
          project.id == id ? project : _plannedProject(id: id),
        );
  }

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    yield await getProjectStatus(id);
  }

  @override
  Future<MobilePlanOperation> approvePlan(
    String planId, {
    String? requestId,
  }) async {
    final plan = project.plan;
    MobilePlan? approvedPlan;
    if (plan != null) {
      approvedPlan = _copyPlan(plan, status: 'approved');
      final index = planSnapshots.indexWhere(
        (snapshot) => snapshot.id == plan.id,
      );
      if (index >= 0) {
        planSnapshots[index] = approvedPlan;
      } else {
        planSnapshots.add(approvedPlan);
      }
    }
    project = _plannedProject(
      status: 'generating',
      currentAction: 'Writing your book.',
      plan: approvedPlan,
    );
    status ??= _projectStatusFromProject(project);
    return MobilePlanOperation(
      projectId: project.id,
      planId: planId,
      status: 'generation_queued',
      currentAction: 'Writing your book.',
      job: const MobileQueuedJob(
        id: 'job-generate',
        status: 'queued',
        currentAction: 'Writing your book.',
      ),
    );
  }

  @override
  Future<MobilePlanOperation> revisePlan({
    required String planId,
    required String message,
    String? requestId,
  }) async {
    revisionMessages.add(message);
    project = _plannedProject(
      status: 'planning',
      currentAction: 'Revising your book plan.',
      plan: project.plan,
    );
    return MobilePlanOperation(
      projectId: project.id,
      planId: planId,
      status: 'revision_queued',
      currentAction: 'Revising your book plan.',
      job: const MobileQueuedJob(
        id: 'job-revise',
        status: 'queued',
        currentAction: 'Revising your book plan.',
      ),
    );
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    return MobileProjectChat(
      messages: List.unmodifiable(chatMessages),
      plans: List.unmodifiable(planSnapshots),
      operations: List.unmodifiable(chatOperations),
    );
  }

  void failLatestPlanRevision() {
    final index = chatOperations.lastIndexWhere(
      (operation) => operation.isPlanRevision,
    );
    if (index < 0) return;
    final operation = chatOperations[index];
    chatOperations[index] = MobileBookEditOperation(
      id: operation.id,
      projectId: operation.projectId,
      kind: operation.kind,
      status: 'failed',
      affectedPageIndexes: operation.affectedPageIndexes,
      creditsCharged: operation.creditsCharged,
      currentAction: 'Plan revision failed.',
      error: 'AI plan revision failed.',
      job: const MobileQueuedJob(
        id: 'job-revise',
        status: 'failed',
        currentAction: 'Plan revision failed.',
      ),
      createdAt: operation.createdAt,
      appliedAt: operation.appliedAt,
    );
    project = _plannedProject(
      status: 'plan_ready',
      currentAction: 'Ready for review.',
      plan: project.plan,
    );
  }

  void completeLatestPlanRevision({required String title}) {
    final current = project.plan;
    if (current == null) return;
    final completedAt = DateTime.utc(2026, 6, 15, 12, chatMessages.length + 2);
    final currentIndex = planSnapshots.indexWhere(
      (plan) => plan.id == current.id,
    );
    final superseded = _copyPlan(
      current,
      status: 'superseded',
      updatedAt: completedAt,
    );
    if (currentIndex >= 0) {
      planSnapshots[currentIndex] = superseded;
    }
    final revised = _copyPlan(
      current,
      id: 'plan-${current.version + 1}',
      version: current.version + 1,
      status: 'draft',
      title: title,
      questions: const [],
      createdAt: completedAt,
      updatedAt: completedAt,
    );
    planSnapshots.add(revised);
    project = _plannedProject(
      status: 'plan_ready',
      currentAction: 'Ready for review.',
      plan: revised,
    );
  }

  @override
  Future<MobileProjectChatSendResult> sendProjectChatMessage({
    required String projectId,
    required String message,
    String? requestId,
  }) async {
    revisionMessages.add(message);
    final isPlanQuestion =
        !(project.plan?.isApproved ?? false) && message.trim().endsWith('?');
    final userMessage = MobileProjectChatMessage(
      id: 'chat-user-${chatMessages.length + 1}',
      projectId: projectId,
      role: 'user',
      content: message,
      metadata: const {},
      createdAt: DateTime.utc(2026, 6, 15, 12, chatMessages.length),
    );
    final assistantMessage = MobileProjectChatMessage(
      id: 'chat-assistant-${chatMessages.length + 2}',
      projectId: projectId,
      role: 'assistant',
      content: isPlanQuestion
          ? 'Here’s the current plan.'
          : (project.plan?.isApproved ?? false)
          ? 'I can help edit this book.'
          : 'I’ll revise the plan now.',
      metadata: const {},
      createdAt: DateTime.utc(2026, 6, 15, 12, chatMessages.length + 1),
    );
    chatMessages.addAll([userMessage, assistantMessage]);
    MobileBookEditOperation? operation;
    if (!(project.plan?.isApproved ?? false) && !isPlanQuestion) {
      project = _plannedProject(
        status: 'planning',
        currentAction: 'Revising your book plan.',
        plan: project.plan,
      );
      operation = MobileBookEditOperation(
        id: 'operation-${chatOperations.length + 1}',
        projectId: projectId,
        kind: 'plan_revision',
        status: 'queued',
        affectedPageIndexes: const [],
        creditsCharged: 100,
        currentAction: 'Revising the plan.',
        createdAt: DateTime.utc(2026, 6, 15),
      );
      chatOperations.add(operation);
    }
    return MobileProjectChatSendResult(
      messages: List.unmodifiable(chatMessages),
      plans: List.unmodifiable(planSnapshots),
      operations: List.unmodifiable(chatOperations),
      reply: assistantMessage,
      operation: operation,
    );
  }

  @override
  Future<MobileProjectChatSendResult> editProjectChatMessage({
    required String projectId,
    required String messageId,
    required String message,
    String? requestId,
  }) {
    return sendProjectChatMessage(projectId: projectId, message: message);
  }

  @override
  Future<MobileProjectChat> switchProjectChatBranch({
    required String projectId,
    required String messageId,
    required String direction,
  }) {
    return getProjectChat(projectId);
  }

  @override
  Future<List<MobileProjectSummary>> listProjects() async => const [];

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    downloadedFormats.add(export.format);
    return ProjectExportFile(
      format: export.format,
      filename: export.filename,
      path: '/tmp/${export.filename}',
    );
  }

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    openedFormats.add(export.format);
    return ExportOpenOutcome.opened;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _FakeBillingRepository implements BillingRepository {
  @override
  Future<MobileBilling> getBilling() async => _billing();

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileProjectDetail _plannedProject({
  String id = 'project-1',
  String status = 'plan_ready',
  String currentAction = 'Ready for review.',
  MobilePlan? plan,
}) {
  return MobileProjectDetail(
    id: id,
    title: _planTitle,
    bookType: 'workbook',
    lengthPreset: 'standard',
    qualityPreset: 'balanced',
    imagesEnabled: true,
    status: status,
    statusLabel: 'Review your book plan',
    progressPercent: 20,
    currentAction: currentAction,
    promptPreview: 'Create a workbook for teachers launching a course.',
    targetPages: 28,
    pageCount: 0,
    imageCount: 0,
    hasPlan: true,
    exports: _exports,
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
    prompt: 'Create a workbook for teachers launching a course.',
    language: 'en',
    plan: plan ?? _plan(projectId: id),
    pages: const [],
  );
}

MobileProjectStatus _projectStatusFromProject(MobileProjectDetail project) {
  return _projectStatus(
    projectId: project.id,
    status: project.status,
    statusLabel: _statusLabelForProjectStatus(project.status),
    progressPercent: project.progressPercent,
    currentAction: project.currentAction,
    completedPages: project.pageCount,
    targetPages: project.targetPages,
    imageCount: project.imageCount,
    failureMessage: project.status == 'failed' ? 'Generation failed.' : null,
  );
}

MobileProjectStatus _projectStatus({
  String projectId = 'project-1',
  String status = 'generating',
  String? statusLabel,
  int progressPercent = 38,
  String currentAction = 'Writing your book pages.',
  String? failureMessage,
  bool retryAvailable = false,
  int completedPages = 3,
  int targetPages = 28,
  int imageCount = 1,
  MobileExportSet exports = _exports,
}) {
  final complete = status == 'complete';
  final failed = status == 'failed';
  return MobileProjectStatus(
    projectId: projectId,
    status: status,
    statusLabel: statusLabel ?? _statusLabelForProjectStatus(status),
    progressPercent: progressPercent,
    currentAction: currentAction,
    failureMessage: failureMessage,
    retryAvailable: retryAvailable,
    steps: [
      const MobileProjectStatusStep(key: 'plan', label: 'Plan', status: 'done'),
      MobileProjectStatusStep(
        key: 'write',
        label: 'Write',
        status: failed
            ? 'failed'
            : complete
            ? 'done'
            : 'active',
        detail: '$completedPages/$targetPages pages',
      ),
      MobileProjectStatusStep(
        key: 'visuals',
        label: 'Visuals',
        status: complete ? 'done' : 'pending',
        detail: imageCount == 1 ? '1 visual' : '$imageCount visuals',
      ),
      MobileProjectStatusStep(
        key: 'export',
        label: 'Export',
        status: complete ? 'done' : 'pending',
      ),
    ],
    pageProgress: MobilePageProgress(
      completed: completedPages,
      target: targetPages,
    ),
    imageCount: imageCount,
    exports: exports,
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

String _statusLabelForProjectStatus(String status) {
  return switch (status) {
    'generating' => 'Generating your book',
    'editing' => 'Editing your book',
    'complete' => 'Ready to export',
    'failed' => 'Needs attention',
    'planning' => 'Building your outline',
    _ => 'Review your book plan',
  };
}

MobilePlan _plan({
  String id = 'plan-1',
  String projectId = 'project-1',
  int version = 1,
  String status = 'draft',
  String title = _planTitle,
  List<MobilePlanQuestion> questions = const [],
}) {
  return MobilePlan(
    id: id,
    projectId: projectId,
    version: version,
    status: status,
    title: title,
    premise: 'A practical workbook for a simple paid launch.',
    audience: 'Independent teachers and coaches.',
    questions: questions,
    chapters: const [
      MobilePlanChapter(
        index: 1,
        title: 'Set the promise',
        summary: 'Define the result the student should get.',
        targetPages: 8,
      ),
    ],
    createdAt: DateTime.utc(2026, 6, 15),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobilePlan _copyPlan(
  MobilePlan plan, {
  String? id,
  int? version,
  String? status,
  String? title,
  List<MobilePlanQuestion>? questions,
  DateTime? createdAt,
  DateTime? updatedAt,
}) {
  return MobilePlan(
    id: id ?? plan.id,
    projectId: plan.projectId,
    version: version ?? plan.version,
    status: status ?? plan.status,
    title: title ?? plan.title,
    subtitle: plan.subtitle,
    premise: plan.premise,
    audience: plan.audience,
    questions: questions ?? plan.questions,
    chapters: plan.chapters,
    createdAt: createdAt ?? plan.createdAt,
    updatedAt: updatedAt ?? plan.updatedAt,
    approvedAt: plan.approvedAt,
  );
}

MobilePlan _approvedPlan() {
  return _plan(status: 'approved');
}

MobilePlan _questionPlan() {
  return _plan(
    questions: const [
      MobilePlanQuestion(
        prompt: 'Who is the primary reader?',
        options: ['Busy solo teachers', 'New coaches'],
        allowCustom: true,
      ),
      MobilePlanQuestion(
        prompt: 'Should examples focus on live classes or recorded lessons?',
        options: ['Live classes', 'Recorded lessons'],
        allowCustom: true,
      ),
    ],
  );
}

MobileBilling _billing() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 1200,
      reserved: 0,
      lifetimeGranted: 1200,
      lifetimeSpent: 0,
    ),
    entitlements: [],
    products: [],
    creditCosts: {
      'fullBookBase': 350,
      'fullBookPerPage': 8,
      'imageGeneration': 45,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}

const _exports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: false,
    unlocked: false,
    creditsRequired: 150,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);

const _unlockedExports = MobileExportSet(
  pdf: MobileExportAvailability(
    format: 'pdf',
    available: true,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  ),
  epub: MobileExportAvailability(
    format: 'epub',
    available: true,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/epub',
    filename: 'book.epub',
    contentType: 'application/epub+zip',
  ),
);
