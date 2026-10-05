import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/shared/ui/app_components.dart';

import 'creation_chat_fakes.dart';
import 'creation_chat_harness.dart';

void main() {
  testWidgets(
    'restoring book details shows a skeleton without claiming to plan',
    (tester) async {
      final gate = Completer<void>();
      final projects = _DelayedProjectsRepository()..detailGate = gate.future;
      final creation = ScriptedCreationRepository(
        sessions: [
          chatSession(
            draftId: 'draft-a',
            title: 'Book A',
            status: 'COMPLETED',
            createdProjectId: 'project-1',
          ),
        ],
      );
      addTearDown(tester.teardownScreen);

      await tester.pumpWidget(
        app(creation: creation, projects: projects, draftId: 'draft-a'),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(find.text('Building your book plan…'), findsNothing);
      expect(find.text('Creating your book plan'), findsNothing);
      expect(find.byType(AppSkeletonGroup), findsWidgets);
      expect(find.bySemanticsLabel('Loading book details'), findsOneWidget);
      expect(find.bySemanticsLabel('Loading book actions'), findsOneWidget);

      gate.complete();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Generating your book'), findsOneWidget);
    },
  );

  testWidgets('switching books restores cached progress while refreshing', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final projects = _DelayedProjectsRepository();
    final creation = ScriptedCreationRepository(
      sessions: [
        for (final id in ['1', '2'])
          chatSession(
            draftId: 'draft-$id',
            title: 'Book $id',
            status: 'COMPLETED',
            createdProjectId: 'project-$id',
          ),
      ],
    );
    addTearDown(tester.teardownScreen);

    Future<void> open(String id) async {
      await tester.pumpWidget(
        app(creation: creation, projects: projects, draftId: 'draft-$id'),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump();
    }

    await open('1');
    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing book project-1'), findsOneWidget);
    expect(find.text('38%'), findsOneWidget);
    expect(find.text('Transcript for project-1'), findsOneWidget);
    await open('2');
    expect(find.text('Writing book project-2'), findsOneWidget);

    final gate = Completer<void>();
    projects.detailGate = gate.future;
    projects.statusGate = gate.future;
    projects.chatGate = gate.future;
    final callsBeforeReturn = projects.detailCalls;
    projects.progressPercent = 62;
    await open('1');

    expect(projects.detailCalls, greaterThan(callsBeforeReturn));
    expect(find.text('Building your book plan…'), findsNothing);
    expect(find.text('Creating your book plan'), findsNothing);
    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('Writing book project-1'), findsOneWidget);
    expect(find.text('38%'), findsOneWidget);
    expect(find.text('62%'), findsNothing);
    expect(find.text('Writing book project-2'), findsNothing);
    expect(find.text('Transcript for project-1'), findsOneWidget);
    expect(find.text('Transcript for project-2'), findsNothing);
    expect(find.byType(AppSkeletonGroup), findsNothing);

    gate.complete();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Generating your book'), findsOneWidget);
    expect(find.text('62%'), findsOneWidget);
  });
}

class _DelayedProjectsRepository extends PlanProjectsRepository {
  _DelayedProjectsRepository()
    : super(
        project: plannedProject(
          status: 'generating',
          currentAction: 'Writing your book.',
          plan: copyPlan(plannedProject().plan!, status: 'approved'),
        ),
      );

  Future<void>? detailGate;
  Future<void>? statusGate;
  Future<void>? chatGate;
  int detailCalls = 0;
  int progressPercent = 38;
  @override
  Future<MobileProjectDetail> getProject(String id) async {
    detailCalls++;
    await detailGate;
    return plannedProject(
      id: id,
      status: 'generating',
      currentAction: 'Writing book $id',
      plan: copyPlan(plannedProject(id: id).plan!, status: 'approved'),
    );
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    await statusGate;
    return projectStatus(
      projectId: id,
      currentAction: 'Writing book $id',
      progressPercent: progressPercent,
    );
  }

  @override
  Future<MobileProjectChat> getProjectChat(
    String id, {
    String? beforeMessageId,
    int limit = 150,
  }) async {
    await chatGate;
    return MobileProjectChat(
      messages: [
        MobileProjectChatMessage(
          id: 'reply-$id',
          projectId: id,
          role: 'assistant',
          content: 'Transcript for $id',
          metadata: const {},
          createdAt: DateTime.utc(2026, 6, 15),
        ),
      ],
      plans: [plan(projectId: id, status: 'approved')],
      operations: const [],
    );
  }
}
