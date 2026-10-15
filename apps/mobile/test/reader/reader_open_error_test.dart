import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';

import 'book_reader_test_support.dart';

// A file pdfrx cannot open used to show pdfrx's developer screen: a stack
// trace and "set PdfViewerParams.errorBannerBuilder".
void main() {
  testWidgets('a book that will not open says so and offers a fresh download', (
    tester,
  ) async {
    var opens = true;
    Widget viewer(
      BuildContext context,
      PdfDocumentRef documentRef,
      PdfViewerController controller,
      PdfViewerParams params,
      int initialPageNumber,
    ) {
      if (!opens) {
        // What PdfViewer does with a document it failed to load.
        return params.errorBannerBuilder!(
          context,
          const FormatException('Failed to load PDF document'),
          StackTrace.empty,
          documentRef,
        );
      }
      return Center(child: Text('book open: ${viewerIdentity(documentRef)}'));
    }

    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);
    opens = false;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(viewer),
        ],
        child: MaterialApp(
          home: ReaderView(
            projectId: 'project-1',
            export: pdfExport(),
            loader: loader,
            status: statusWith(pdfExport()),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("This book couldn't be opened"), findsOneWidget);
    expect(find.textContaining('errorBannerBuilder'), findsNothing);
    expect(find.textContaining('Failed to load'), findsNothing);
    expect(repository.downloadedRevisions, [1]);

    opens = true;
    await tester.tap(find.text('Download again'));
    await tester.pumpAndSettle();

    expect(
      repository.discardedFormats,
      ['pdf'],
      reason: 'the cached copy goes, or the download is a cache hit',
    );
    expect(repository.downloadedRevisions, [1, 1]);
    expect(find.text("This book couldn't be opened"), findsNothing);
    expect(find.textContaining('book open:'), findsOneWidget);
  });
}
