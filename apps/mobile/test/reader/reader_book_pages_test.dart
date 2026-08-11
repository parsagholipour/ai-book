import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/presentation/reader_book_pages.dart';

class _EmptyDocument extends PdfDocument {
  _EmptyDocument() : super(sourceName: 'empty-test-document');

  @override
  List<PdfPage> get pages => const [];

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _LocatorRepository implements ReaderRepository {
  final revisions = <int>[];

  @override
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  }) async {
    revisions.add(revision);
    return ReaderPageLocator(
      const MobileEditableBook(
        projectId: 'project-1',
        title: 'The Book',
        pages: [],
      ),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test(
    'page mappings do not load a manuscript without exact provenance',
    () async {
      final repository = _LocatorRepository();
      final document = _EmptyDocument();

      expect(
        await readerPdfPageForBookPage(
          document: document,
          repository: repository,
          projectId: 'project-1',
          revision: null,
          bookPageIndex: 1,
        ),
        isNull,
      );
      expect(
        await readerBookPageForPdfPage(
          document: document,
          repository: repository,
          projectId: 'project-1',
          revision: null,
          pdfPageNumber: 1,
        ),
        isNull,
      );
      expect(repository.revisions, isEmpty);
    },
  );

  test(
    'page mappings pass the displayed exact revision to the locator',
    () async {
      final repository = _LocatorRepository();
      final document = _EmptyDocument();

      await readerPdfPageForBookPage(
        document: document,
        repository: repository,
        projectId: 'project-1',
        revision: 7,
        bookPageIndex: 1,
      );
      await readerBookPageForPdfPage(
        document: document,
        repository: repository,
        projectId: 'project-1',
        revision: 7,
        pdfPageNumber: 1,
      );

      expect(repository.revisions, [7, 7]);
    },
  );
}
