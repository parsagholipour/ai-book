import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_export_actions.dart';

/// Spending a book's export unlock is never a side effect of a tap that does
/// not say so. A Studio book or an import has no generation charge to include
/// the unlock, and every surface that opens or shares a file used to spend its
/// 150 credits the moment it was tapped.
void main() {
  testWidgets(
    'asks before opening a locked export, and spends nothing on Cancel',
    (tester) async {
      final repository = _RecordingProjectsRepository();
      await _pump(tester, repository, _export(unlocked: false));

      await tester.tap(find.text('Export'));
      await tester.pumpAndSettle();

      expect(find.text('Unlock exports for this book?'), findsOneWidget);
      expect(
        find.textContaining('Reading it here in the app stays free'),
        findsOneWidget,
      );
      expect(repository.openCalls, 0);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(repository.openCalls, 0);

      await tester.tap(find.text('Export'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Unlock for 150 credits'));
      await tester.pumpAndSettle();
      expect(repository.openCalls, 1);
    },
  );

  testWidgets('asks before sharing a locked export too', (tester) async {
    final repository = _RecordingProjectsRepository();
    await _pump(tester, repository, _export(unlocked: false), share: true);

    await tester.tap(find.text('Export'));
    await tester.pumpAndSettle();
    expect(find.text('Unlock exports for this book?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(repository.downloadCalls, 0);
  });

  testWidgets('an unlocked export opens without asking', (tester) async {
    final repository = _RecordingProjectsRepository();
    await _pump(tester, repository, _export(unlocked: true));

    await tester.tap(find.text('Export'));
    await tester.pumpAndSettle();

    expect(find.text('Unlock exports for this book?'), findsNothing);
    expect(repository.openCalls, 1);
  });
}

Future<void> _pump(
  WidgetTester tester,
  _RecordingProjectsRepository repository,
  MobileExportAvailability export, {
  bool share = false,
}) {
  return tester.pumpWidget(
    ProviderScope(
      overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
      child: MaterialApp(
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) => ElevatedButton(
              onPressed: () => share
                  ? downloadProjectExport(
                      context: context,
                      ref: ref,
                      projectId: 'project-1',
                      export: export,
                      isMounted: () => context.mounted,
                    )
                  : openProjectExport(
                      context: context,
                      ref: ref,
                      projectId: 'project-1',
                      export: export,
                      isMounted: () => context.mounted,
                    ),
              child: const Text('Export'),
            ),
          ),
        ),
      ),
    ),
  );
}

MobileExportAvailability _export({required bool unlocked}) {
  return MobileExportAvailability(
    format: 'pdf',
    available: true,
    unlocked: unlocked,
    creditsRequired: unlocked ? 0 : 150,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    readUrl: '/api/mobile/projects/project-1/read/pdf',
    filename: 'book.pdf',
    contentType: 'application/pdf',
  );
}

class _RecordingProjectsRepository implements ProjectsRepository {
  int openCalls = 0;
  int downloadCalls = 0;

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    openCalls += 1;
    return ExportOpenOutcome.opened;
  }

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    downloadCalls += 1;
    throw StateError('A cancelled share must not download.');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
