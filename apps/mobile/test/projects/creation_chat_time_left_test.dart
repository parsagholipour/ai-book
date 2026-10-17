import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_generation_harness.dart';
import 'creation_chat_harness.dart';

// The creation chat says how long the plan and then the book have left, from
// the server's estimate, and counts it down between statuses.

const _planningSteps = [
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
];

const _writingSteps = [
  MobileProjectStatusStep(
    key: 'prepare',
    label: 'Preparing your chapters',
    status: 'done',
  ),
  MobileProjectStatusStep(
    key: 'write',
    label: 'Writing your chapters',
    status: 'active',
    detail: '2 of 6 chapters',
  ),
  MobileProjectStatusStep(
    key: 'finish',
    label: 'Building your book',
    status: 'pending',
  ),
];

Future<void> _pumpPlanningChat(WidgetTester tester, {int? secondsLeft}) async {
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
  creation.resumeAssistantMessages['draft-done'] = 'Original transcript';
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
      planningProgress: MobilePlanningProgress(
        percent: 55,
        estimatedSecondsLeft: secondsLeft,
        steps: _planningSteps,
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
}

MobileProjectStatus _writing({int? secondsLeft, String? failureMessage}) {
  return generationStatus(
    failureMessage: failureMessage,
    generationProgress: MobileGenerationProgress(
      percent: 46,
      detail: 'Writing chapter 3 of 6',
      estimatedSecondsLeft: secondsLeft,
      steps: _writingSteps,
    ),
  );
}

void main() {
  testWidgets('the plan footer says how long the plan has left', (
    tester,
  ) async {
    await _pumpPlanningChat(tester, secondsLeft: 90);

    expect(find.text('Creating your book plan'), findsOneWidget);
    expect(find.text('About 2 min left'), findsOneWidget);

    // No new status arrives: the footer counts down on its own.
    await tester.pump(const Duration(seconds: 40));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Less than a minute left'), findsOneWidget);
    await tester.pump(const Duration(seconds: 60));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Almost done'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets('the plan footer says nothing when the server has no estimate', (
    tester,
  ) async {
    await _pumpPlanningChat(tester);

    expect(find.text('Creating your book plan'), findsOneWidget);
    expect(find.byIcon(Icons.schedule_outlined), findsNothing);
    expect(find.textContaining('min left'), findsNothing);

    await tester.teardownScreen();
  });

  testWidgets('the writing bubble says how long the book has left', (
    tester,
  ) async {
    await pumpGenerationChat(tester, status: _writing(secondsLeft: 600));

    expect(find.text('Writing chapter 3 of 6'), findsOneWidget);
    expect(find.text('About 10 min left'), findsOneWidget);

    await tester.pump(const Duration(seconds: 70));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('About 9 min left'), findsOneWidget);

    await tester.teardownScreen();
  });

  testWidgets(
    'the writing bubble lands on "Almost done" when the count runs out',
    (tester) async {
      await pumpGenerationChat(tester, status: _writing(secondsLeft: 30));

      expect(find.text('Less than a minute left'), findsOneWidget);
      await tester.pump(const Duration(seconds: 30));
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Almost done'), findsOneWidget);
      expect(find.text('Writing chapter 3 of 6'), findsOneWidget);

      await tester.teardownScreen();
    },
  );

  testWidgets(
    'the writing bubble says nothing for a book that stopped or has no estimate',
    (tester) async {
      await pumpGenerationChat(
        tester,
        status: _writing(
          secondsLeft: 600,
          failureMessage: 'We hit a problem while writing a page.',
        ),
      );
      expect(find.text('Needs attention'), findsOneWidget);
      expect(find.textContaining('min left'), findsNothing);
      await tester.teardownScreen();

      await pumpGenerationChat(tester, status: _writing());
      expect(find.text('Writing chapter 3 of 6'), findsOneWidget);
      expect(find.byIcon(Icons.schedule_outlined), findsNothing);
      await tester.teardownScreen();
    },
  );
}
