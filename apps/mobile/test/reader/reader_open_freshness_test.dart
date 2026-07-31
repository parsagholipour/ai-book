import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';

import 'book_reader_screen_test.dart'
    show FakeReaderRepository, pdfExport, statusWith, stubViewer;

/// What the reader opens against.
///
/// The book's state is not the reader's to assume: it is shared with the screen
/// that pushed it, and an edit changes it between the two. These cover that
/// handover — see [BookReaderScreen] for why a snapshot cannot be trusted.
void main() {
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
    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);

    // Something else refreshes the status while the reader is open.
    final scope = tester.element(find.byType(BookReaderScreen));
    ProviderScope.containerOf(
      scope,
      listen: false,
    ).invalidate(projectStatusProvider('project-1'));
    await tester.pumpAndSettle();

    expect(find.text('Opening your book'), findsNothing);
    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);
  });
}
