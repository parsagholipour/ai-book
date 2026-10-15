import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_export_actions.dart';

/// A written book's files are the reader's: tapping one opens or shares it,
/// with no question, no price and no paywall. There used to be a per-book
/// export unlock, asked for on every surface that took a file out; an older
/// server still sends its fields, and the app reads none of them.
void main() {
  testWidgets('a file an older server still calls locked opens at once', (
    tester,
  ) async {
    final repository = _RecordingProjectsRepository();
    await _pump(tester, repository, _legacyLockedExport());

    await tester.tap(find.text('Export'));
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsNothing);
    expect(find.textContaining('Unlock'), findsNothing);
    expect(find.textContaining('credits'), findsNothing);
    expect(repository.openCalls, 1);
  });

  testWidgets('sharing a file downloads it at once', (tester) async {
    final repository = _RecordingProjectsRepository();
    await _pump(tester, repository, _legacyLockedExport(), share: true);

    await tester.tap(find.text('Export'));
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsNothing);
    expect(repository.downloadCalls, 1);
  });

  test('the old unlock fields parse, and draw neither a lock nor a price', () {
    final export = _legacyLockedExport();
    expect(export.available, isTrue);
    expect(projectExportDownloadLabel(export), 'Open PDF');
    expect(projectExportStateText(export), 'Ready to open or download.');
    expect(projectExportLockedBySubscription(export, null), isFalse);
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

/// What a server from before the unlock's removal sends for a free reader's
/// book: locked, priced, and offered to a plan.
MobileExportAvailability _legacyLockedExport() {
  return MobileExportAvailability.fromJson(const {
    'format': 'pdf',
    'available': true,
    'unlocked': false,
    'creditsRequired': 150,
    'planIncludesUnlock': true,
    'downloadUrl': '/api/mobile/projects/project-1/export/pdf',
    'readUrl': '/api/mobile/projects/project-1/read/pdf',
    'filename': 'book.pdf',
    'contentType': 'application/pdf',
  });
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
    // The system share sheet is a platform channel this test has no answer
    // for; failing here stops before it, after the download was asked for.
    throw StateError('No share sheet under test.');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}
