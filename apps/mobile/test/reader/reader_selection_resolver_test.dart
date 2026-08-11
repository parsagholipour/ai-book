import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_resolver.dart';

/// A repository that only knows how to hand back a locator.
class LocatorOnlyRepository implements ReaderRepository {
  LocatorOnlyRepository(this.book, {this.fail = false});

  final MobileEditableBook book;
  final bool fail;
  int locatorCalls = 0;
  final locatorRevisions = <int>[];

  @override
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  }) async {
    locatorCalls++;
    locatorRevisions.add(revision);
    if (fail) throw Exception('the book could not be fetched');
    return ReaderPageLocator(book);
  }

  @override
  Future<CachedExport> ensureExport({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) => throw UnimplementedError();

  @override
  Future<ReaderState> loadState(String projectId) async => const ReaderState();

  @override
  Future<void> saveState(String projectId, ReaderState state) async {}

  @override
  Future<List<ReaderAnnotation>> loadAnnotations(String projectId) async =>
      const [];

  @override
  Future<void> saveAnnotations(String p, List<ReaderAnnotation> a) async {}

  @override
  Future<ReaderSettings> loadSettings() async => const ReaderSettings();

  @override
  Future<void> saveSettings(ReaderSettings settings) async {}

  @override
  Future<void> clearProject(String projectId) async {}
}

MobileEditableBookPage page(int index, String markdown) {
  return MobileEditableBookPage(
    id: 'page-$index',
    index: index,
    title: 'Chapter $index',
    markdown: markdown,
    revision: 1,
  );
}

/// A selection over one rendered page's text.
List<PdfPageTextRange> selectionOf(
  String pageText,
  String selected, {
  int pageNumber = 1,
}) {
  final start = pageText.indexOf(selected);
  final text = PdfPageText(
    pageNumber: pageNumber,
    fullText: pageText,
    charRects: const [],
    fragments: const [],
  );
  return [
    PdfPageTextRange(
      pageText: text,
      start: start,
      end: start + selected.length,
    ),
  ];
}

Future<ReaderResolvedSelection> place(
  LocatorOnlyRepository repository,
  List<PdfPageTextRange> ranges, {
  int? revision = 1,
}) async {
  final preview = previewReaderSelection(ranges, null)!;
  return placeReaderSelection(
    preview: preview,
    ranges: ranges,
    repository: repository,
    projectId: 'project-1',
    revision: revision,
  );
}

void main() {
  group('preview', () {
    test('collapses the selection the moment it is made', () {
      final preview = previewReaderSelection(
        selectionOf(
          'The rabbit  stretched\nin the grass.',
          'rabbit  stretched',
        ),
        null,
      )!;

      expect(preview.selection.text, 'rabbit stretched');
      expect(preview.selection.pdfPageNumber, 1);
      expect(
        preview.selection.placed,
        isFalse,
        reason: 'the page has not been looked for yet',
      );
      expect(
        preview.selection.placementLabel,
        'Finding page…',
        reason: 'a null page before placing means "still looking"',
      );
    });

    test('an empty selection is not a selection', () {
      expect(previewReaderSelection(const [], null), isNull);
      expect(
        previewReaderSelection(selectionOf('   spaces   ', '   '), null),
        isNull,
      );
    });
  });

  group('placing', () {
    test(
      'does not load the current manuscript without an exact PDF revision',
      () async {
        final repository = LocatorOnlyRepository(
          const MobileEditableBook(
            projectId: 'project-1',
            title: 'The Race',
            pages: [],
          ).copyWithPages([page(1, 'The tortoise kept walking.')]),
        );

        final placed = await place(
          repository,
          selectionOf('The tortoise kept walking.', 'tortoise kept walking'),
          revision: null,
        );

        expect(placed.selection.placed, isTrue);
        expect(placed.selection.bookPageIndex, isNull);
        expect(repository.locatorCalls, 0);
      },
    );

    test('loads the locator under the displayed exact revision', () async {
      final repository = LocatorOnlyRepository(
        const MobileEditableBook(
          projectId: 'project-1',
          title: 'The Race',
          pages: [],
        ).copyWithPages([page(1, 'The tortoise kept walking.')]),
      );

      await place(
        repository,
        selectionOf('The tortoise kept walking.', 'tortoise kept walking'),
        revision: 7,
      );

      expect(repository.locatorRevisions, [7]);
    });

    test('names the book page a passage came from', () async {
      final repository = LocatorOnlyRepository(
        const MobileEditableBook(
          projectId: 'project-1',
          title: 'The Race',
          pages: [],
        ).copyWithPages([
          page(1, 'The hare set off at a sprint and was soon out of sight.'),
          page(2, 'The tortoise kept walking through the afternoon heat.'),
        ]),
      );

      final placed = await place(
        repository,
        selectionOf(
          'The tortoise kept walking through the afternoon heat.',
          'kept walking through the afternoon',
        ),
      );

      expect(placed.selection.bookPageIndex, 2);
      expect(placed.selection.placed, isTrue);
      expect(placed.selection.placementLabel, 'Page 2');
    });

    test('resolves a recurring passage to the copy on screen', () async {
      // The whole reason the rendered page is placed before the passage is: a
      // refrain matched on its own resolves to the first copy in the book,
      // which is the wrong page whenever the reader is past it.
      const refrain = 'Slow and steady wins the race.';
      final repository = LocatorOnlyRepository(
        const MobileEditableBook(
          projectId: 'project-1',
          title: 'The Race',
          pages: [],
        ).copyWithPages([
          page(1, 'The hare laughed. $refrain He was not listening.'),
          page(2, 'A long stretch of road with nothing much on it at all.'),
          page(3, 'The tortoise crossed the line. $refrain Nobody argued.'),
        ]),
      );

      final onLaterPage =
          'The tortoise crossed the line. $refrain Nobody argued.';
      final placed = await place(
        repository,
        selectionOf(onLaterPage, refrain, pageNumber: 3),
      );

      expect(placed.selection.bookPageIndex, 3);
    });

    test(
      'a passage that is nowhere carries no page, and still works',
      () async {
        final repository = LocatorOnlyRepository(
          const MobileEditableBook(
            projectId: 'project-1',
            title: 'The Race',
            pages: [],
          ).copyWithPages([page(1, 'Nothing here resembles the selection.')]),
        );

        final placed = await place(
          repository,
          selectionOf(
            'An entirely different sentence about something else.',
            'entirely different sentence about something',
          ),
        );

        expect(placed.selection.bookPageIndex, isNull);
        expect(
          placed.selection.placed,
          isTrue,
          reason: 'the search finished; it just found nothing',
        );
        expect(placed.selection.placementLabel, 'Page not identified');
      },
    );

    test('a book that cannot be fetched is not a dead end', () async {
      final repository = LocatorOnlyRepository(
        const MobileEditableBook(
          projectId: 'project-1',
          title: 'The Race',
          pages: [],
        ),
        fail: true,
      );

      final placed = await place(
        repository,
        selectionOf('The tortoise kept walking.', 'tortoise kept walking'),
      );

      // Every action still works; the ones that name a page simply do not, and
      // the server can often find the quote anyway.
      expect(placed.selection.bookPageIndex, isNull);
      expect(placed.selection.placed, isTrue);
    });

    test('places a single word using the text around it', () async {
      final repository = LocatorOnlyRepository(
        const MobileEditableBook(
          projectId: 'project-1',
          title: 'The Race',
          pages: [],
        ).copyWithPages([
          page(1, 'The hare set off at a sprint and was soon out of sight.'),
          page(2, 'The tortoise kept walking through the afternoon heat.'),
        ]),
      );

      // "heat" on its own is far too short to place; the surrounding page text
      // is what makes it findable.
      final placed = await place(
        repository,
        selectionOf(
          'The tortoise kept walking through the afternoon heat.',
          'heat',
        ),
      );

      expect(placed.selection.bookPageIndex, 2);
    });
  });
}

extension on MobileEditableBook {
  MobileEditableBook copyWithPages(List<MobileEditableBookPage> pages) {
    return MobileEditableBook(projectId: projectId, title: title, pages: pages);
  }
}
