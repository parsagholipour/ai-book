import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_status_models.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_screen.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

// The brief header's collapsed status line, badge, and expanded panel
// (quick actions, tappable chips, title ideas, shape, materials, estimate).
// New cases live here rather than in creation_chat_test.dart, which is
// already over its recorded size ceiling.

/// The collapsed tap row — headline, pitch and badge live here.
Finder _inHeader(Finder matching) => find.descendant(
  of: find.byKey(const ValueKey('creationBriefHeader')),
  matching: matching,
);

/// The expanded panel, a sibling of the tap row. Scoping matters: the
/// generation bubble renders some of the same strings in the transcript.
Finder _inDetails(Finder matching) => find.descendant(
  of: find.byKey(const ValueKey('creationBriefDetails')),
  matching: matching,
);

/// Quick reply → Build the plan → past the visuals prompt, with the bounded
/// pumps the build flow needs (a poll timer makes pumpAndSettle hang).
Future<void> _buildBook(WidgetTester tester) async {
  await tester.pumpAndSettle();
  await tester.tap(find.text('A kids book'));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(FilledButton, 'Build the plan'));
  await tester.continuePastVisualsPrompt();
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 50));
  await tester.pump(const Duration(milliseconds: 300));
}

Future<void> _expandHeader(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('creationBriefHeader')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  testWidgets('built header shows the live writing status and badge', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'generating',
        currentAction: 'Writing your book.',
        plan: approvedPlan(),
      ),
      status: projectStatus(),
    );
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await _buildBook(tester);

    expect(_inHeader(find.text('Generating your book · 38%')), findsOneWidget);
    expect(_inHeader(find.text('Writing')), findsOneWidget);
    // The readiness pill is a brief-stage concept and has retired.
    expect(_inHeader(find.text('80%')), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('planning header follows the planning progress percent', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'planning',
        currentAction: 'Creating your book plan.',
        withoutPlan: true,
      ),
      status: projectStatus(
        status: 'planning',
        // The whole-book scale sits flat on 10 for the entire planning
        // phase; the header must read the live planning percent instead.
        progressPercent: 10,
        currentAction: 'Shaping the chapters and flow',
        planningProgress: const MobilePlanningProgress(
          percent: 64,
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
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await _buildBook(tester);

    expect(
      _inHeader(find.text('Building your outline · 64%')),
      findsOneWidget,
    );
    expect(_inHeader(find.text('Planning')), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('the header takes the book title over the untitled snapshot', (
    tester,
  ) async {
    // The build response's output snapshot carries the pre-plan placeholder;
    // the polled project detail is where the plan's chosen title lands.
    final creation = ScriptedCreationRepository()
      ..buildOutputTitle = 'Untitled Book';
    final projects = PlanProjectsRepository();
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await _buildBook(tester);

    expect(_inHeader(find.text(planTitle)), findsOneWidget);
    expect(_inHeader(find.text('Untitled Book')), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('completed book offers read, listen and download when expanded', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'complete',
        currentAction: 'Your book is ready.',
        plan: approvedPlan(),
      ),
      status: projectStatus(
        status: 'complete',
        progressPercent: 100,
        completedPages: 28,
        exports: unlockedExports,
      ),
    );
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await _buildBook(tester);

    expect(_inHeader(find.text('Ready to read · 28 pages')), findsOneWidget);
    expect(_inHeader(find.text('Ready')), findsOneWidget);

    await _expandHeader(tester);

    expect(_inDetails(find.text('Read book')), findsOneWidget);
    expect(_inDetails(find.text('Listen')), findsOneWidget);
    expect(_inDetails(find.text('Open PDF')), findsOneWidget);
    expect(_inDetails(find.text('View progress')), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('failed book shows attention and only the progress shortcut', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository(
      project: plannedProject(
        status: 'failed',
        currentAction: 'Generation failed.',
        plan: approvedPlan(),
      ),
      status: projectStatus(
        status: 'failed',
        failureMessage: 'Generation failed.',
        retryAvailable: true,
      ),
    );
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await _buildBook(tester);

    expect(
      _inHeader(find.text('Something needs your attention')),
      findsOneWidget,
    );
    expect(_inHeader(find.text('Attention')), findsOneWidget);

    await _expandHeader(tester);

    expect(_inDetails(find.text('View progress')), findsOneWidget);
    expect(_inDetails(find.text('Read book')), findsNothing);
    expect(_inDetails(find.text('Listen')), findsNothing);
    expect(_inDetails(find.text('Open PDF')), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('preset chips open Advanced settings before the build', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();

    await _expandHeader(tester);
    await tester.ensureVisible(_inDetails(find.text('Type: Auto')));
    await tester.tap(_inDetails(find.text('Type: Auto')));
    await tester.pumpAndSettle();

    expect(find.text('Advanced settings'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('the pen chip in the expanded panel opens the title sheet', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository()
      ..replyTitleSuggestions = ['First Idea', 'Second Idea'];
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    // A suggestion nobody picked is not the book's name: the headline never
    // shows one, and the collapsed bar carries no pen of its own.
    expect(_inHeader(find.text('First Idea')), findsNothing);
    expect(find.text('Edit title'), findsNothing);

    await _expandHeader(tester);

    // Tapping a suggestion applies it immediately.
    await tester.ensureVisible(_inDetails(find.text('Edit title')));
    await tester.tap(_inDetails(find.text('Edit title')));
    await tester.pumpAndSettle();
    expect(find.text('Book title'), findsOneWidget);
    await tester.tap(find.text('Second Idea'));
    await tester.pumpAndSettle();
    expect(_inHeader(find.text('Second Idea')), findsOneWidget);

    // Typing a title of your own wins over the ideas.
    await tester.tap(_inDetails(find.text('Edit title')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Second Idea'),
      'My Own Title',
    );
    await tester.tap(find.text('Use this title'));
    await tester.pumpAndSettle();

    expect(_inHeader(find.text('My Own Title')), findsOneWidget);
    expect(find.text('Book title'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('the pen chip retires once the book is built', (tester) async {
    final creation = ScriptedCreationRepository();
    final projects = PlanProjectsRepository();
    await tester.pumpWidget(app(creation: creation, projects: projects));
    await _buildBook(tester);

    await _expandHeader(tester);

    expect(find.text('Edit title'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('expanded brief shows shape, materials and the build estimate', (
    tester,
  ) async {
    final creation = ScriptedCreationRepository();
    await tester.pumpWidget(app(creation: creation));
    await tester.pumpAndSettle();
    await tester.tap(find.text('A kids book'));
    await tester.pumpAndSettle();

    // Paste notes exactly as the attach sheet would hand them over.
    final container = ProviderScope.containerOf(
      tester.element(find.byType(CreationChatScreen)),
      listen: false,
    );
    container
        .read(creationChatControllerProvider.notifier)
        .setSourceNotes('Reference these facts.');
    await tester.pump();

    await _expandHeader(tester);

    expect(_inDetails(find.text('Shape')), findsOneWidget);
    expect(_inDetails(find.text('• Intro')), findsOneWidget);
    expect(_inDetails(find.text('Source notes attached')), findsOneWidget);
    expect(
      _inDetails(find.text('Estimated build cost · ~12 pages')),
      findsOneWidget,
    );
    // 350 base + 12·8 pages + 45 cover + 3·45 interiors + 150 unlock, from
    // the harness billing costs — the same figure the page-count sheet quotes.
    expect(_inDetails(find.text('776')), findsOneWidget);

    await tester.teardownScreen();
  });
}
