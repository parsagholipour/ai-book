import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/generation_progress_screen.dart';

void main() {
  testWidgets('detail polling runs while generating and stops once the '
      'project settles', (tester) async {
    final statusController = StreamController<MobileProjectStatus>.broadcast();
    final repository = _CountingProjectsRepository(
      () => statusController.stream,
    );
    await tester.pumpWidget(_app(repository));
    await tester.pump();

    statusController.add(_status('generating'));
    await tester.pump();
    await tester.pump();
    final liveBaseline = repository.getProjectCalls;

    await tester.pump(const Duration(seconds: 9));
    expect(
      repository.getProjectCalls,
      greaterThan(liveBaseline),
      reason: 'previews should refresh on the poll timer while generating',
    );

    statusController.add(_status('complete'));
    await tester.pump();
    await tester.pump();
    final settledBaseline = repository.getProjectCalls;

    await tester.pump(const Duration(seconds: 13));
    expect(
      repository.getProjectCalls,
      settledBaseline,
      reason: 'the poll timer must stop once the project is complete',
    );

    await statusController.close();
  });

  testWidgets('the progress card prefers the live milestones and falls back '
      'to the pipeline steps', (tester) async {
    final withMilestones = _CountingProjectsRepository(
      () => Stream.value(
        _status(
          'generating',
          generationProgress: const MobileGenerationProgress(
            percent: 44,
            detail: 'Writing page 5 of 10',
            steps: [
              MobileProjectStatusStep(
                key: 'prepare',
                label: 'Preparing your chapters',
                status: 'done',
              ),
              MobileProjectStatusStep(
                key: 'write',
                label: 'Writing your pages',
                status: 'active',
                detail: '4 of 10 pages',
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpWidget(_app(withMilestones));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('Writing your pages'), findsOneWidget);
    expect(find.text('4 of 10 pages'), findsOneWidget);

    final withoutMilestones = _CountingProjectsRepository(
      () => Stream.value(
        _status(
          'generating',
          steps: const [
            MobileProjectStatusStep(
              key: 'write',
              label: 'Write',
              status: 'active',
              detail: '4/10 pages',
            ),
          ],
        ),
      ),
    );
    await tester.pumpWidget(_app(withoutMilestones));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('Write'), findsOneWidget);
    expect(find.text('Writing your pages'), findsNothing);
  });

  testWidgets('a project that is already settled never starts the poll timer', (
    tester,
  ) async {
    final repository = _CountingProjectsRepository(
      () => Stream.value(_status('complete')),
    );
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();
    final baseline = repository.getProjectCalls;

    await tester.pump(const Duration(seconds: 13));

    expect(repository.getProjectCalls, baseline);
  });
}

Widget _app(_CountingProjectsRepository repository) {
  return ProviderScope(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(repository),
      billingProvider.overrideWith(
        (ref) => Future<MobileBilling>.error(
          UnimplementedError('Billing is not used in this test.'),
        ),
      ),
    ],
    child: const MaterialApp(
      home: GenerationProgressScreen(projectId: 'project-1'),
    ),
  );
}

MobileProjectStatus _status(
  String status, {
  MobileGenerationProgress? generationProgress,
  List<MobileProjectStatusStep> steps = const [],
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: status == 'complete'
        ? 'Ready to export'
        : 'Generating your book',
    progressPercent: status == 'complete' ? 100 : 40,
    currentAction: 'Writing your book pages.',
    generationProgress: generationProgress,
    retryAvailable: false,
    steps: steps,
    pageProgress: const MobilePageProgress(completed: 4, target: 10),
    imageCount: 0,
    exports: _exports(),
    updatedAt: DateTime.utc(2026, 6, 15),
  );
}

MobileExportSet _exports() {
  return MobileExportSet(
    pdf: const MobileExportAvailability(
      format: 'pdf',
      available: false,
      unlocked: false,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/project-1/export/pdf',
      filename: 'book.pdf',
      contentType: 'application/pdf',
    ),
    epub: const MobileExportAvailability(
      format: 'epub',
      available: false,
      unlocked: false,
      creditsRequired: 150,
      downloadUrl: '/api/mobile/projects/project-1/export/epub',
      filename: 'book.epub',
      contentType: 'application/epub+zip',
    ),
  );
}

class _CountingProjectsRepository implements ProjectsRepository {
  _CountingProjectsRepository(this.statusStream);

  final Stream<MobileProjectStatus> Function() statusStream;
  int getProjectCalls = 0;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) => statusStream();

  @override
  Future<MobileProjectDetail> getProject(String id) async {
    getProjectCalls += 1;
    return MobileProjectDetail(
      id: 'project-1',
      title: 'Launch Course Workbook',
      bookType: 'workbook',
      lengthPreset: 'standard',
      qualityPreset: 'balanced',
      imagesEnabled: false,
      status: 'generating',
      statusLabel: 'Generating your book',
      progressPercent: 40,
      currentAction: 'Writing your book pages.',
      promptPreview: 'Create a workbook.',
      targetPages: 10,
      pageCount: 4,
      imageCount: 0,
      hasPlan: true,
      exports: _exports(),
      createdAt: DateTime.utc(2026, 6, 15),
      updatedAt: DateTime.utc(2026, 6, 15),
      prompt: 'Create a workbook.',
      language: 'en',
      pages: const [],
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
