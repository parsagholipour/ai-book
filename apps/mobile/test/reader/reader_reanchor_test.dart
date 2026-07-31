import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_reanchor.dart';

/// A page of text with rectangles derived from character offsets, so a test can
/// assert that a passage was found *where* it is and not merely that it is on
/// the page somewhere.
class FakePage implements ReanchorPage {
  FakePage(this.fullText);

  @override
  final String fullText;

  @override
  List<NormRect> rectsForRange(int start, int end) {
    if (end <= start) return const [];
    return [
      NormRect(start / fullText.length, 0.5, (end - start) / fullText.length, 0.02),
    ];
  }
}

/// A loader over a book, recording which pages were actually read.
class FakeBook {
  FakeBook(this.pages);

  final Map<int, String> pages;
  final read = <int>[];

  int get pageCount => pages.keys.fold(0, (a, b) => a > b ? a : b);

  ReanchorPageLoader get loader => (pageNumber) async {
    read.add(pageNumber);
    final text = pages[pageNumber];
    return text == null ? null : FakePage(text);
  };
}

TextMarkupAnnotation markup({
  required int page,
  required String quote,
  int revision = 1,
}) {
  return TextMarkupAnnotation(
    id: 'a-$page',
    page: page,
    revision: revision,
    colorIndex: 0,
    createdAt: DateTime.utc(2026, 7, 20),
    updatedAt: DateTime.utc(2026, 7, 20),
    style: ReaderMarkupStyle.highlight,
    rects: const [NormRect(0.1, 0.2, 0.3, 0.02)],
    quote: quote,
  );
}

InkAnnotation ink({required int page, int revision = 1}) {
  return InkAnnotation(
    id: 'ink-$page',
    page: page,
    revision: revision,
    colorIndex: 4,
    createdAt: DateTime.utc(2026, 7, 20),
    updatedAt: DateTime.utc(2026, 7, 20),
    strokes: const [
      InkStroke(
        points: [NormPoint(0.1, 0.1), NormPoint(0.4, 0.4)],
        colorIndex: 4,
        width: 0.004,
      ),
    ],
  );
}

void main() {
  test('finds a passage that repagination pushed onto the next page', () async {
    final book = FakeBook({
      1: 'A long opening about nothing much at all.',
      2: 'Filler that used to hold the passage.',
      3: 'The rabbit stretched in the long grass and yawned.',
    });

    final result = await reanchorAnnotations(
      annotations: [
        markup(page: 2, quote: 'The rabbit stretched in the long grass'),
      ],
      pageCount: book.pageCount,
      revision: 2,
      loadPage: book.loader,
    );

    expect(result.moved, 1);
    expect(result.orphaned, 0);
    final moved = result.annotations.single;
    expect(moved.page, 3);
    expect(moved.revision, 2);
    expect(moved.orphaned, isFalse);
    expect((moved as TextMarkupAnnotation).rects, isNotEmpty);
  });

  test('searches outward from where the passage used to be', () async {
    // Repagination shifts a book by a page or two, not across it, so the near
    // pages have to be tried first or every open costs a full scan.
    final book = FakeBook(<int, String>{
      for (var page = 1; page <= 40; page++) page: 'Filler on page $page.',
      21: 'The rabbit stretched in the long grass and yawned.',
    });

    await reanchorAnnotations(
      annotations: [
        markup(page: 20, quote: 'The rabbit stretched in the long grass'),
      ],
      pageCount: 40,
      revision: 2,
      loadPage: book.loader,
    );

    expect(book.read.take(3), [20, 19, 21]);
    expect(
      book.read.length,
      lessThan(5),
      reason: 'a one-page shift must not read the whole book',
    );
  });

  test('keeps a passage that has been rewritten away, and says so', () async {
    final book = FakeBook({
      1: 'Nothing here resembles what was highlighted.',
      2: 'Nor here.',
    });

    final result = await reanchorAnnotations(
      annotations: [
        markup(page: 1, quote: 'The rabbit stretched in the long grass'),
      ],
      pageCount: 2,
      revision: 2,
      loadPage: book.loader,
    );

    expect(result.orphaned, 1);
    final lost = result.annotations.single;
    expect(lost.orphaned, isTrue);
    expect(lost.isDeleted, isFalse, reason: 'it is still the reader’s note');
    expect(lost.isPlaceable, isFalse, reason: 'but it has no place on a page');
    expect(
      lost.revision,
      2,
      reason: 'stamped anyway, so the next open does not rescan the book',
    );
  });

  test('ink keeps its position and is reported as carried over', () async {
    final book = FakeBook({1: 'Some text.', 2: 'More text.'});

    final result = await reanchorAnnotations(
      annotations: [ink(page: 2)],
      pageCount: 2,
      revision: 2,
      loadPage: book.loader,
    );

    expect(result.carried, 1);
    expect(result.orphaned, 0);
    final carried = result.annotations.single;
    expect(carried.page, 2, reason: 'a drawing has no text to follow');
    expect(carried.orphaned, isFalse);
    expect(book.read, isEmpty, reason: 'nothing to search for');
  });

  test('ink on a page the shorter book no longer has comes loose', () async {
    final book = FakeBook({1: 'Some text.'});

    final result = await reanchorAnnotations(
      annotations: [ink(page: 9)],
      pageCount: 1,
      revision: 2,
      loadPage: book.loader,
    );

    expect(result.orphaned, 1);
    expect(result.annotations.single.orphaned, isTrue);
  });

  test('markup already on the current revision is left entirely alone', () async {
    final book = FakeBook({1: 'The rabbit stretched in the long grass.'});
    final original = markup(page: 1, quote: 'The rabbit', revision: 2);

    final result = await reanchorAnnotations(
      annotations: [original],
      pageCount: 1,
      revision: 2,
      loadPage: book.loader,
    );

    expect(result.changed, isFalse);
    expect(identical(result.annotations.single, original), isTrue);
    expect(book.read, isEmpty);
  });

  test('matches through the wrapping the renderer introduces', () async {
    // The quote was captured from a selection; the new PDF wraps it somewhere
    // else entirely. Normalizing is what makes the two comparable.
    final book = FakeBook({
      1: 'the well-\nknown  rabbit\nstretched in the ﬁeld',
    });

    final result = await reanchorAnnotations(
      annotations: [markup(page: 1, quote: 'the well-known rabbit stretched')],
      pageCount: 1,
      revision: 2,
      loadPage: book.loader,
    );

    expect(result.moved, 1);
    expect(result.annotations.single.orphaned, isFalse);
  });

  test('the found rectangles cover the passage, not the whole page', () async {
    const text = 'Before. The rabbit stretched in the long grass. After.';
    final book = FakeBook({1: text});

    final result = await reanchorAnnotations(
      annotations: [markup(page: 1, quote: 'The rabbit stretched')],
      pageCount: 1,
      revision: 2,
      loadPage: book.loader,
    );

    final rect = (result.annotations.single as TextMarkupAnnotation).rects.single;
    final expectedStart = text.indexOf('The rabbit stretched') / text.length;
    expect(rect.left, closeTo(expectedStart, 1e-9));
    expect(rect.width, closeTo('The rabbit stretched'.length / text.length, 1e-9));
  });

  test('a quote too short to be distinctive is not guessed at', () async {
    final book = FakeBook({1: 'a the of', 2: 'the'});

    final result = await reanchorAnnotations(
      annotations: [markup(page: 1, quote: 'the')],
      pageCount: 2,
      revision: 2,
      loadPage: book.loader,
    );

    // Kept where it was and stamped, rather than moved to the first page that
    // happens to contain a three-letter word.
    expect(result.carried, 1);
    expect(book.read, isEmpty);
  });

  group('normalize index map', () {
    test('maps a match back onto the original offsets', () {
      const source = 'The well-\nknown rabbit stretched.';
      final normalized = ReaderPageLocator.normalize(source);

      final range = normalized.sourceRangeOf('wellknown rabbit')!;

      expect(source.substring(range.start, range.end), 'well-\nknown rabbit');
    });

    test('maps back across an expanded ligature', () {
      const source = 'in the ﬁeld beyond';
      final normalized = ReaderPageLocator.normalize(source);

      expect(normalized.text, 'in the field beyond');
      final range = normalized.sourceRangeOf('field')!;
      expect(source.substring(range.start, range.end), 'ﬁeld');
    });

    test('maps back across collapsed whitespace and dropped syntax', () {
      const source = 'the   **rabbit**\n  stretched';
      final normalized = ReaderPageLocator.normalize(source);

      expect(normalized.text, 'the rabbit stretched');
      final range = normalized.sourceRangeOf('rabbit')!;
      expect(source.substring(range.start, range.end), 'rabbit');
    });

    test('a passage that is not there has no range', () {
      final normalized = ReaderPageLocator.normalize('nothing to see');
      expect(normalized.sourceRangeOf('rabbit'), isNull);
      expect(normalized.sourceRangeOf(''), isNull);
    });

    test('every character of the result names where it came from', () {
      final normalized = ReaderPageLocator.normalize('Fluffy —  the ﬂ rabbit');
      expect(normalized.sourceStarts, hasLength(normalized.text.length));
      expect(normalized.sourceEnds, hasLength(normalized.text.length));
    });
  });
}
