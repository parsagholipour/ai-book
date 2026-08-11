import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/export_repair_watch.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/projects/presentation/project_export_actions.dart';
import 'package:tomeza/shared/api/api_error.dart';

/// A download refused with `EXPORT_NOT_READY` is the server saying it has
/// queued the repair — so the action has to put the app back on the status flow
/// that watches for it. Showing a snack bar and stopping left every surface on
/// the stale descriptor it already had: a button still offering a file that is
/// not there, and nothing that would ever notice it arrive.
void main() {
  testWidgets('an EPUB refused as not ready rejoins the shared watch', (
    tester,
  ) async {
    var refreshes = 0;
    final repository = _FakeProjectsRepository(
      streamed: [
        _status(pdfAvailable: true, epubAvailable: true),
        // The re-read the action asks for: the file really is gone.
        _status(pdfAvailable: true, epubAvailable: false),
      ],
      polled: _status(pdfAvailable: true, epubAvailable: true),
      failure: _notReady,
    );
    final budget = _RecordingBudget();
    final container = _container(repository, budget);

    await _pumpHarness(
      tester,
      container,
      format: 'epub',
      onRefresh: () => refreshes += 1,
    );
    await tester.tap(find.text('Export'));
    await tester.pump();

    expect(repository.openCalls, 1);
    expect(
      find.textContaining('Your EPUB is being rebuilt'),
      findsOneWidget,
      reason: 'the refusal is a rebuild in progress, not a broken download',
    );
    expect(refreshes, 1);
    expect(
      budget.requested,
      [ExportRepairFormat.epub],
      reason: 'the shared watch has to be told an EPUB is being waited for',
    );

    // The shared status flow was re-opened, saw the file missing, kept polling
    // on the shared budget — which it would not have done for an EPUB nobody
    // asked for — and picked the rebuilt file up on its own.
    await tester.pumpAndSettle();
    expect(repository.watchCalls, 2);
    expect(repository.pollCalls, 1);
    expect(find.text('epub:true'), findsOneWidget);
    expect(
      budget.isAwaitingEpub,
      isFalse,
      reason: 'the file landed, so the wait it was asked to keep is over',
    );
  });

  testWidgets('a share refused as not ready rejoins it too', (tester) async {
    // Open and share are the same route with a different destination, and both
    // are drawn from the same stale descriptor.
    final repository = _FakeProjectsRepository(
      streamed: [
        _status(pdfAvailable: true, epubAvailable: true),
        _status(pdfAvailable: true, epubAvailable: false),
      ],
      polled: _status(pdfAvailable: true, epubAvailable: true),
      failure: _notReady,
    );
    final budget = _RecordingBudget();
    final container = _container(repository, budget);

    await _pumpHarness(tester, container, format: 'epub', share: true);
    await tester.tap(find.text('Export'));
    await tester.pump();

    expect(repository.downloadCalls, 1);
    expect(find.textContaining('Your EPUB is being rebuilt'), findsOneWidget);
    expect(budget.requested, [ExportRepairFormat.epub]);

    await tester.pumpAndSettle();
    expect(repository.watchCalls, 2);
    expect(find.text('epub:true'), findsOneWidget);
  });

  testWidgets('a PDF refused as not ready re-reads without an EPUB wait', (
    tester,
  ) async {
    final repository = _FakeProjectsRepository(
      streamed: [
        _status(pdfAvailable: true, epubAvailable: true),
        _status(pdfAvailable: false, epubAvailable: true),
      ],
      polled: _status(pdfAvailable: true, epubAvailable: true),
      failure: _notReady,
    );
    final budget = _RecordingBudget();
    final container = _container(repository, budget);

    await _pumpHarness(tester, container, format: 'pdf');
    await tester.tap(find.text('Export'));
    await tester.pump();

    expect(find.textContaining('Your PDF is being rebuilt'), findsOneWidget);
    expect(budget.requested, [ExportRepairFormat.pdf]);
    expect(
      budget.isAwaitingEpub,
      isFalse,
      reason: 'a missing PDF is watched anyway; nothing asked for the EPUB',
    );

    await tester.pumpAndSettle();
    expect(repository.watchCalls, 2);
    expect(repository.pollCalls, 1);
    expect(find.text('pdf:true'), findsOneWidget);
  });

  testWidgets('any other failure reports itself and leaves the flow alone', (
    tester,
  ) async {
    // Only "the file is not there yet" is a wait. A refusal for credits, or a
    // dead network, says nothing about a compile and must not spend the
    // project's watch allowance re-reading a status that has not changed.
    final repository = _FakeProjectsRepository(
      streamed: [_status(pdfAvailable: true, epubAvailable: true)],
      polled: _status(pdfAvailable: true, epubAvailable: true),
      failure: const ApiException(
        code: 'INSUFFICIENT_CREDITS',
        message: 'You need more credits to unlock this download.',
        statusCode: 402,
      ),
    );
    final budget = _RecordingBudget();
    final container = _container(repository, budget);
    var refreshes = 0;

    await _pumpHarness(
      tester,
      container,
      format: 'epub',
      onRefresh: () => refreshes += 1,
    );
    await tester.tap(find.text('Export'));
    await tester.pump();

    expect(
      find.text('You need more credits to unlock this download.'),
      findsOneWidget,
    );
    expect(refreshes, 0);
    expect(repository.watchCalls, 1);
    expect(budget.requested, isEmpty);
  });
}

const _notReady = ApiException(
  code: 'EXPORT_NOT_READY',
  message: 'This export is not ready yet.',
  statusCode: 404,
);

ProviderContainer _container(
  _FakeProjectsRepository repository,
  ExportRepairWatchBudget budget,
) {
  final container = ProviderContainer(
    overrides: [
      projectsRepositoryProvider.overrideWithValue(repository),
      exportRepairWatchProvider.overrideWith((ref, id) => budget),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

Future<void> _pumpHarness(
  WidgetTester tester,
  ProviderContainer container, {
  required String format,
  bool share = false,
  VoidCallback? onRefresh,
}) async {
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: _ExportActionHarness(
          format: format,
          share: share,
          onRefresh: onRefresh,
        ),
      ),
    ),
  );
  // Let the first status arrive, so the button is drawn from a descriptor that
  // says the file is there — which is the only way this route is reachable.
  await tester.pump();
  expect(find.text('Export'), findsOneWidget);
}

/// Reports what the action asked the shared watch for, whatever the statuses
/// that follow do to it.
class _RecordingBudget extends ExportRepairWatchBudget {
  final requested = <ExportRepairFormat>[];

  @override
  void noteExportRequested(ExportRepairFormat format) {
    requested.add(format);
    super.noteExportRequested(format);
  }
}

/// The smallest surface that owns an export button: it watches the shared
/// status provider, like the book page, the actions menu and the saved-export
/// card, and hands the descriptor it drew to the shared action.
class _ExportActionHarness extends ConsumerWidget {
  const _ExportActionHarness({
    required this.format,
    required this.share,
    this.onRefresh,
  });

  final String format;
  final bool share;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final exports = ref
        .watch(projectStatusProvider('project-1'))
        .asData
        ?.value
        .exports;
    final export = exports == null
        ? null
        : (format == 'pdf' ? exports.pdf : exports.epub);
    return Scaffold(
      body: Column(
        children: [
          Text('pdf:${exports?.pdf.available}'),
          Text('epub:${exports?.epub.available}'),
          if (export != null)
            ElevatedButton(
              onPressed: () async {
                if (share) {
                  await downloadProjectExport(
                    context: context,
                    ref: ref,
                    projectId: 'project-1',
                    export: export,
                    isMounted: () => context.mounted,
                    onRefresh: onRefresh,
                  );
                } else {
                  await openProjectExport(
                    context: context,
                    ref: ref,
                    projectId: 'project-1',
                    export: export,
                    isMounted: () => context.mounted,
                    onRefresh: onRefresh,
                  );
                }
              },
              child: const Text('Export'),
            ),
        ],
      ),
    );
  }
}

class _FakeProjectsRepository implements ProjectsRepository {
  _FakeProjectsRepository({
    required this.streamed,
    required this.polled,
    required this.failure,
  });

  /// One status per subscription, so a re-read can answer differently from the
  /// snapshot the button was drawn from.
  final List<MobileProjectStatus> streamed;
  final MobileProjectStatus polled;
  final Object failure;
  int watchCalls = 0;
  int pollCalls = 0;
  int openCalls = 0;
  int downloadCalls = 0;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    final index = watchCalls++;
    yield streamed[index < streamed.length ? index : streamed.length - 1];
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    pollCalls += 1;
    return polled;
  }

  @override
  Future<ExportOpenOutcome> openExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    openCalls += 1;
    throw failure;
  }

  @override
  Future<ProjectExportFile> downloadExport({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    downloadCalls += 1;
    throw failure;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileProjectStatus _status({
  required bool pdfAvailable,
  required bool epubAvailable,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: 'complete',
    statusLabel: 'Complete',
    progressPercent: 100,
    currentAction: 'Your book is ready.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 10, target: 10),
    imageCount: 0,
    exports: MobileExportSet(
      pdf: _export('pdf', pdfAvailable),
      epub: _export('epub', epubAvailable),
    ),
    updatedAt: DateTime.utc(2026, 8, 10),
  );
}

MobileExportAvailability _export(String format, bool available) {
  return MobileExportAvailability(
    format: format,
    available: available,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/$format',
    filename: 'book.$format',
    contentType: format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
  );
}
