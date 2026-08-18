import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'book_reader_test_support.dart';

/// What the reader opens against.
///
/// The book's state is not the reader's to assume: it is shared with the screen
/// that pushed it, and an edit changes it between the two. These cover that
/// handover — see [BookReaderScreen] for why a snapshot cannot be trusted.
void main() {
  test(
    'an exact older PDF cannot map actions to the current manuscript',
    () async {
      final repository = FakeReaderRepository()..answerWithRevision = 4;
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      await loader.load(pdfExport(revision: 5));

      expect(loader.exactRevisionForProject('project-1'), 4);
      expect(
        loader.mappingRevisionFor(
          expectedProjectId: 'project-1',
          offeredRevision: 5,
        ),
        isNull,
        reason: 'only the current manuscript can be fetched for page mapping',
      );
    },
  );

  test(
    'an exact newer PDF cannot map actions through a stale descriptor',
    () async {
      final repository = FakeReaderRepository()..answerWithRevision = 6;
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);

      await loader.load(pdfExport(revision: 5));

      expect(loader.exactRevisionForProject('project-1'), 6);
      expect(
        loader.mappingRevisionFor(
          expectedProjectId: 'project-1',
          offeredRevision: 5,
        ),
        isNull,
        reason: 'the page locator cannot validate a stale descriptor',
      );
    },
  );

  test('an exact PDF cannot authorize actions for another project', () async {
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-2',
    );
    addTearDown(loader.dispose);

    await loader.load(pdfExport(revision: 3));

    expect(loader.exactRevisionForProject('project-1'), isNull);
    expect(
      loader.mappingRevisionFor(
        expectedProjectId: 'project-1',
        offeredRevision: 3,
      ),
      isNull,
    );
  });

  test('unknown PDF provenance authorizes neither marks nor mapping', () async {
    final repository = FakeReaderRepository()..exactProvenance = false;
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await loader.load(pdfExport(revision: 3));

    expect(loader.exactRevisionForProject('project-1'), isNull);
    expect(
      loader.mappingRevisionFor(
        expectedProjectId: 'project-1',
        offeredRevision: 3,
      ),
      isNull,
    );
  });

  test('a same-revision repair withdraws the physical sheet, not the '
      'mapping', () async {
    // The repair republished revision 3 over different bytes and stamped its
    // new map with the same revision, so `mappingRevisionFor` keeps agreeing —
    // and should: the manuscript at revision 3 is what the locator resolves
    // model pages against, and that has not moved. What has stopped being true
    // is that sheet N of the open file is sheet N of the file the server's map
    // describes, which is the only thing `readerContext.pdfPage` ever says.
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await loader.load(pdfExport(revision: 3));

    expect(
      loader.mappingRevisionFor(
        expectedProjectId: 'project-1',
        offeredRevision: 3,
      ),
      3,
    );
    expect(
      loader.mappedPdfDigestFor(
        expectedProjectId: 'project-1',
        pageNumbering: const MobilePdfPageNumbering(
          hasCoverPage: true,
          contentRevision: 3,
          pdfDigest: 'pdf-digest-3',
        ),
      ),
      'pdf-digest-3',
    );
    expect(
      loader.mappedPdfDigestFor(
        expectedProjectId: 'project-1',
        pageNumbering: const MobilePdfPageNumbering(
          hasCoverPage: true,
          contentRevision: 3,
          pdfDigest: 'repaired-pdf',
        ),
      ),
      isNull,
      reason: 'the map in force was measured from a file that is not this one',
    );
    expect(
      loader.mappedPdfDigestFor(
        expectedProjectId: 'project-1',
        pageNumbering: null,
      ),
      isNull,
      reason: 'a map that identifies no PDF describes no PDF',
    );
    expect(
      loader.mappedPdfDigestFor(
        expectedProjectId: 'project-2',
        pageNumbering: const MobilePdfPageNumbering(
          hasCoverPage: true,
          contentRevision: 3,
          pdfDigest: 'pdf-digest-3',
        ),
      ),
      isNull,
      reason: 'another book\'s open file authorizes nothing here',
    );
  });

  test(
    'same-revision digest changes are stale but older descriptors are not',
    () async {
      final repository = FakeReaderRepository();
      final loader = ReaderDocumentLoader(
        repository: repository,
        projectId: 'project-1',
      );
      addTearDown(loader.dispose);
      final current = pdfExport(revision: 3);
      await loader.load(
        current,
        pageNumbering: const MobilePdfPageNumbering(
          hasCoverPage: true,
          contentRevision: 3,
          pdfDigest: 'pdf-digest-3',
        ),
      );

      expect(
        loader.isStale(
          current,
          pageNumbering: const MobilePdfPageNumbering(
            hasCoverPage: true,
            contentRevision: 3,
            pdfDigest: 'repaired-pdf',
          ),
        ),
        isTrue,
        reason: 'a repair may replace bytes without changing revision or size',
      );
      expect(
        loader.isStale(
          pdfExport(revision: 2),
          pageNumbering: const MobilePdfPageNumbering(
            hasCoverPage: true,
            contentRevision: 2,
            pdfDigest: 'older-pdf',
          ),
        ),
        isFalse,
        reason: 'a cached compile newer than a stale descriptor remains a hit',
      );
    },
  );

  testWidgets('a missing reader export keeps a manual status retry', (
    tester,
  ) async {
    var subscriptions = 0;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(FakeReaderRepository()),
          readerViewerBuilderProvider.overrideWithValue(stubViewer),
          projectStatusProvider.overrideWith((ref, id) {
            subscriptions += 1;
            return Stream.value(statusWith(pdfExport(available: false)));
          }),
        ],
        child: const MaterialApp(
          home: BookReaderScreen(projectId: 'project-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Still being written'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    final beforeRetry = subscriptions;

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(subscriptions, greaterThan(beforeRetry));
  });

  testWidgets('asks for the book\'s current state instead of reusing a '
      'snapshot taken before it opened', (tester) async {
    // The status stream ends when the book stops working and the provider keeps
    // that last value. After an edit the book text changes first and the PDF is
    // recompiled after, so a reader opened against the earlier snapshot has the
    // old export revision: the cached file still matches it, and the reader
    // shows the text the user just changed with nothing to say otherwise.
    final repository = FakeReaderRepository();
    var subscriptions = 0;
    var revision = 1;
    // Deliberately not `Stream.value`: the re-check has to be slower than the
    // frame that follows it, or the test never sees the window this is about.
    // The provider still has the chat as a listener, so invalidating it is a
    // refresh — Riverpod keeps the previous value and `AsyncValue.when` serves
    // it while the fresh one is in flight.
    var pending = <StreamController<MobileProjectStatus>>[];
    addTearDown(() {
      for (final controller in pending) {
        controller.close();
      }
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(stubViewer),
          projectStatusProvider.overrideWith((ref, id) {
            subscriptions += 1;
            final controller = StreamController<MobileProjectStatus>();
            pending.add(controller);
            return controller.stream;
          }),
        ],
        child: MaterialApp(
          home: Consumer(
            builder: (context, ref, child) {
              // Stands in for the chat, which holds the status alive while the
              // reader is pushed on top of it.
              ref.watch(projectStatusProvider('project-1'));
              return Scaffold(
                body: TextButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          const BookReaderScreen(projectId: 'project-1'),
                    ),
                  ),
                  child: const Text('Open book'),
                ),
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(subscriptions, 1);

    // The chat settles on the book as it was before the edit.
    pending.single.add(statusWith(pdfExport(revision: revision)));
    await tester.pumpAndSettle();

    // The edit lands and the book is recompiled while the chat sits on that
    // finished snapshot.
    revision = 2;

    await tester.tap(find.text('Open book'));
    // Not pumpAndSettle: the reader is waiting, and its spinner animates for as
    // long as it does.
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(subscriptions, 2, reason: 'the reader has to ask again on open');
    expect(
      repository.downloadedRevisions,
      isEmpty,
      reason: 'nothing may be fetched against the pre-edit snapshot',
    );
    expect(find.text('Opening your book'), findsOneWidget);

    // The re-check answers with the recompiled book.
    pending.last.add(statusWith(pdfExport(revision: revision)));
    await tester.pumpAndSettle();

    expect(
      repository.downloadedRevisions,
      [2],
      reason: 'the recompiled book, not the one cached before the edit',
    );
  });

  testWidgets('a retry fetches the compile that replaced the one that failed', (
    tester,
  ) async {
    // `EXPORT_NOT_READY` says a compile is landing, so the descriptor that
    // failed is precisely the one least likely to still describe what is behind
    // that URL. Retrying under it downloads the *new* book and files it as the
    // old revision: the cache would then serve it as current, no update banner
    // would ever appear, and markup would be re-anchored and stamped against a
    // compile it was never placed against.
    final repository = FakeReaderRepository(failDownload: true)
      ..downloadError = const ApiException(
        code: 'EXPORT_NOT_READY',
        message: 'This export is not ready yet.',
        statusCode: 404,
      );
    var revision = 1;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(stubViewer),
          projectStatusProvider.overrideWith(
            (ref, id) =>
                Stream.value(statusWith(pdfExport(revision: revision))),
          ),
        ],
        child: const MaterialApp(
          home: BookReaderScreen(projectId: 'project-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Still preparing this book'), findsOneWidget);
    expect(repository.downloadedRevisions, isEmpty);

    // The rebuild lands while the reader is looking at the retry.
    revision = 2;
    repository.failDownload = false;

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(
      repository.downloadedRevisions,
      [2],
      reason: 'the retry has to re-read what is being offered before fetching',
    );
    expect(find.text(pdfAt(1, revision: 2)), findsOneWidget);
  });

  testWidgets('a retry that cannot re-read the book still fetches', (
    tester,
  ) async {
    // The download is the real test and reports its own reason. A status
    // re-check that refuses must not turn a retry into a second kind of error,
    // or a reader whose book is sitting there ready never gets to it.
    final repository = FakeReaderRepository(failDownload: true)
      ..downloadError = const ApiException(
        code: 'EXPORT_NOT_READY',
        message: 'This export is not ready yet.',
        statusCode: 404,
      );
    var settled = false;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(stubViewer),
          projectStatusProvider.overrideWith((ref, id) {
            if (settled) {
              return Stream<MobileProjectStatus>.error(
                const ApiException(code: 'NETWORK_ERROR', message: 'offline'),
              );
            }
            return Stream.value(statusWith(pdfExport()));
          }),
        ],
        child: const MaterialApp(
          home: BookReaderScreen(projectId: 'project-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Still preparing this book'), findsOneWidget);
    settled = true;
    repository.failDownload = false;

    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(
      repository.downloadedRevisions,
      [1],
      reason:
          'the descriptor already held stands in for one that cannot be read',
    );
  });

  testWidgets('a book edited while open does not blank the page being read', (
    tester,
  ) async {
    // The wait for a fresh status is only for opening. Once the reader is up,
    // the book going live is an edit in progress, and the reader keeps showing
    // what it has rather than dropping back to a spinner.
    final repository = FakeReaderRepository();
    final controllers = <StreamController<MobileProjectStatus>>[];
    addTearDown(() {
      for (final controller in controllers) {
        controller.close();
      }
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(stubViewer),
          projectStatusProvider.overrideWith((ref, id) {
            final controller = StreamController<MobileProjectStatus>();
            controllers.add(controller);
            return controller.stream;
          }),
        ],
        child: const MaterialApp(
          home: BookReaderScreen(projectId: 'project-1'),
        ),
      ),
    );
    // The reader waits behind its spinner, which never settles.
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    // The last subscription is the reader's own re-check on open.
    controllers.last.add(statusWith(pdfExport()));
    await tester.pumpAndSettle();
    expect(find.text(pdfAt(1)), findsOneWidget);

    // Something else refreshes the status while the reader is open.
    final scope = tester.element(find.byType(BookReaderScreen));
    ProviderScope.containerOf(
      scope,
      listen: false,
    ).invalidate(projectStatusProvider('project-1'));
    await tester.pumpAndSettle();

    expect(find.text('Opening your book'), findsNothing);
    expect(find.text(pdfAt(1)), findsOneWidget);
  });
}
