import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/offline_library_store.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/export_cache.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/data/reader_storage.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_actions.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_menu.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'book_reader_test_support.dart';

// A book downloaded to the phone could not be opened with no connection: the
// reader needed the server's status to know what to open, and the status lived
// only in memory. It now opens against the last status kept on the phone, and
// a download that cannot reach the server falls back to the file on disk.

const _offline = ApiException(
  code: 'NETWORK_ERROR',
  message: 'Check your connection and try again.',
);

/// The file on this phone: an older compile than the kept status names.
CachedExport _storedRevision1() => CachedExport(
  path: '/tmp/book.pdf',
  revision: 1,
  revisionIsExact: true,
  digest: 'pdf-digest-1',
  byteSize: 100,
  downloadedAt: DateTime.utc(2026, 7, 25),
);

Widget _reader({
  required FakeReaderRepository repository,
  required MemoryOfflineLibraryStore store,
  Stream<MobileProjectStatus> Function()? status,
}) {
  return ProviderScope(
    retry: (_, _) => null,
    overrides: [
      readerRepositoryProvider.overrideWithValue(repository),
      readerViewerBuilderProvider.overrideWithValue(stubViewer),
      offlineLibraryStoreProvider.overrideWithValue(store),
      projectStatusProvider.overrideWith(
        (ref, id) => status?.call() ?? Stream.error(_offline),
      ),
    ],
    child: const MaterialApp(home: BookReaderScreen(projectId: 'project-1')),
  );
}

class _FakeApiClient implements ApiClient {
  @override
  Future<DownloadedFile> downloadFile(
    String path,
    String savePath, {
    ProgressCallback? onReceiveProgress,
    CancelToken? cancelToken,
  }) async {
    await File(savePath).writeAsString('%PDF-1.7 the book');
    return const DownloadedFile(
      headers: {
        'x-export-provenance': 'exact',
        'x-export-content-digest': 'pdf-digest-1',
        'x-export-content-revision': '1',
      },
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('offline, a downloaded book opens from the copy on this phone', (
    tester,
  ) async {
    final store = MemoryOfflineLibraryStore()
      ..statuses['project-1'] = OfflineBookStatus(
        status: statusWith(pdfExport(revision: 2)),
        savedAt: DateTime.utc(2026, 10, 12),
      );
    final repository = FakeReaderRepository(
      failDownload: true,
      downloadError: _offline,
    )..stored = _storedRevision1();

    await tester.pumpWidget(_reader(repository: repository, store: store));
    await tester.pumpAndSettle();

    expect(find.text('Could not open this book'), findsNothing);
    // Filed under its own revision, not the newer one the status names.
    expect(find.text(pdfAt(1)), findsOneWidget);
    expect(
      find.text("You're offline — reading the copy on this phone"),
      findsOneWidget,
    );
    // Nothing offers a reload no download could answer.
    expect(find.text('Your edits are in. Reload to see them.'), findsNothing);
  });

  testWidgets('back online, the same reader stays open and stops saying '
      'offline', (tester) async {
    final statuses = StreamController<MobileProjectStatus>.broadcast();
    addTearDown(statuses.close);
    final store = MemoryOfflineLibraryStore()
      ..statuses['project-1'] = OfflineBookStatus(
        status: statusWith(pdfExport()),
        savedAt: DateTime.utc(2026, 10, 12),
      );
    final repository = FakeReaderRepository(
      failDownload: true,
      downloadError: _offline,
    )..stored = _storedRevision1();

    await tester.pumpWidget(
      _reader(
        repository: repository,
        store: store,
        status: () => statuses.stream,
      ),
    );
    await tester.pump();
    statuses.addError(_offline);
    await tester.pumpAndSettle();
    expect(
      find.text("You're offline — reading the copy on this phone"),
      findsOneWidget,
    );
    expect(find.text(pdfAt(1)), findsOneWidget);

    statuses.add(statusWith(pdfExport()));
    await tester.pumpAndSettle();

    expect(
      find.text("You're offline — reading the copy on this phone"),
      findsNothing,
    );
    // The book on screen is the compile on offer: nothing to reload, and
    // nothing downloaded again.
    expect(find.text(pdfAt(1)), findsOneWidget);
    expect(find.text('Your edits are in. Reload to see them.'), findsNothing);
    expect(repository.downloadedRevisions, isEmpty);
  });

  testWidgets('offline with no status kept, the reader says the book is not '
      'on this phone', (tester) async {
    await tester.pumpWidget(
      _reader(
        repository: FakeReaderRepository(),
        store: MemoryOfflineLibraryStore(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('reader-offline-unsaved')), findsOneWidget);
    expect(find.text('Not on this phone yet'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('a book never downloaded says so rather than that a download '
      'broke', (tester) async {
    await tester.pumpWidget(
      _reader(
        repository: FakeReaderRepository(
          failDownload: true,
          downloadError: _offline,
        ),
        store: MemoryOfflineLibraryStore(),
        status: () => Stream.value(statusWith(pdfExport())),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('reader-not-downloaded')), findsOneWidget);
    expect(find.text('Could not download this book'), findsNothing);
  });

  test('only an unreachable server falls back to the file on disk', () async {
    final repository = FakeReaderRepository(
      failDownload: true,
      downloadError: const ApiException(
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong.',
        statusCode: 500,
      ),
    )..stored = _storedRevision1();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await loader.load(pdfExport(revision: 2));

    expect(loader.stage, ReaderLoadStage.failed);
    expect(repository.storedLookups, 0);

    repository.downloadError = _offline;
    await loader.load(pdfExport(revision: 2));

    expect(loader.stage, ReaderLoadStage.ready);
    expect(loader.document?.revision, 1);
  });

  testWidgets('offline, the selection offers nothing that needs the server', (
    tester,
  ) async {
    final taps = <ReaderSelectionAction>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ReaderSelectionMenu(
            selection: const ReaderSelection(
              text: 'A line',
              pdfPageNumber: 3,
              bookPageIndex: 2,
            ),
            editingEnabled: false,
            offline: true,
            onAction: taps.add,
          ),
        ),
      ),
    );

    expect(find.text('Offline — these need a connection'), findsOneWidget);
    for (final label in ['Ask', 'Rewrite', 'Replace', 'Edit page']) {
      await tester.tap(find.text(label));
    }
    expect(taps, isEmpty);
  });

  group('ExportCache.stored', () {
    late Directory root;
    late ExportCache cache;

    setUp(() async {
      root = await Directory.systemTemp.createTemp('export_cache_stored');
      cache = ExportCache(
        apiClient: _FakeApiClient(),
        storage: ReaderStorage(root: root),
      );
    });

    tearDown(() async {
      await root.delete(recursive: true);
    });

    test('hands back the file on disk whatever compile the descriptor '
        'names, under its own revision', () async {
      await cache.ensure(
        projectId: 'p1',
        export: pdfExport(revision: 1, byteSize: 17),
      );

      final stored = await cache.stored(
        projectId: 'p1',
        export: pdfExport(revision: 4, byteSize: 900),
      );

      expect(stored, isNotNull);
      expect(stored!.revision, 1);
      expect(stored.digest, 'pdf-digest-1');
      expect(stored.revisionIsExact, isTrue);
    });

    test('offers nothing for a file it cannot vouch for', () async {
      expect(await cache.stored(projectId: 'p1', export: pdfExport()), isNull);

      await cache.ensure(
        projectId: 'p1',
        export: pdfExport(revision: 1, byteSize: 17),
      );
      // Cut short after it was filed: the manifest's size no longer agrees.
      final directory = await ReaderStorage(root: root).projectDirectory('p1');
      await File('${directory.path}/book.pdf').writeAsString('%PDF-');

      expect(await cache.stored(projectId: 'p1', export: pdfExport()), isNull);
    });
  });
}
