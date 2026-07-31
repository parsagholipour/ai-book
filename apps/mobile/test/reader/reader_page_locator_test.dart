import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';

MobileEditableBook bookWith(List<String> markdown) {
  return MobileEditableBook(
    projectId: 'project-1',
    title: 'The Book',
    pages: [
      for (var index = 0; index < markdown.length; index++)
        MobileEditableBookPage(
          id: 'page-${index + 1}',
          index: index + 1,
          title: 'Page ${index + 1}',
          markdown: markdown[index],
          revision: 1,
        ),
    ],
  );
}

/// A book long enough to have somewhere wrong to land.
///
/// Every page carries its own prose so a probe taken anywhere lands on exactly
/// one of them — except for the refrain on pages 2 and 9, which is the whole
/// point: it is the passage a reader on page 9 can select and have attributed
/// to page 2.
const harbourPages = <String>[
  'The harbour stayed quiet long before dawn and the fishing boats rocked at their moorings while the gulls argued over yesterday.',
  'Marta counted the crates twice and found one of them missing, and the lantern swung twice against the mast as she wrote it down.',
  'The harbourmaster kept his ledger in a language nobody had bothered to learn, and he liked it that way for reasons of his own.',
  'Rain arrived from the north without warning and drummed on the tin roofs until the whole waterfront sounded like an argument.',
  'Kel untangled the nets alone that afternoon, humming something his mother used to hum, and pretended not to watch the doorway.',
  'The tide went out further than anyone remembered and left the mudflats glittering with things that should have stayed buried.',
  'They argued about the price of ice until the ice itself had settled the matter by melting quietly through the floorboards.',
  'A stranger paid in coins nobody recognised and asked directions to a street that had been renamed before the war ended.',
  'Nobody answered from the wheelhouse, and the lantern swung twice against the mast before the fog closed over the water entirely.',
  'By morning the boat was gone and so was the argument, and the harbour went back to pretending it had never noticed either.',
];

void main() {
  group('ReaderPageLocator', () {
    test('finds the page a passage was taken from', () {
      final locator = ReaderPageLocator(
        bookWith([
          'The rabbit stretched in the long grass and considered the day.',
          'The turtle had already started walking down the dusty road.',
          'They met again at the top of the hill, both out of breath.',
        ]),
      );

      expect(locator.locate('already started walking'), 2);
      expect(locator.locate('both out of breath'), 3);
    });

    test('ignores line wrapping introduced by the PDF renderer', () {
      final locator = ReaderPageLocator(
        bookWith(['The turtle had already started walking down the road.']),
      );

      // PDF text extraction breaks lines wherever the layout did.
      expect(locator.locate('already\n   started\nwalking down'), 1);
    });

    test('reunites a word hyphenated across a line break', () {
      final locator = ReaderPageLocator(
        bookWith(['The turtle considered the situation carefully.']),
      );

      expect(locator.locate('considered the situ-\nation carefully'), 1);
    });

    test('matches a genuine compound whether or not it wrapped', () {
      final locator = ReaderPageLocator(
        bookWith(['It was a well-known shortcut through the woods.']),
      );

      expect(locator.locate('a well-known shortcut'), 1);
      expect(locator.locate('a well-\nknown shortcut'), 1);
    });

    test('folds typographic punctuation back to the Markdown source', () {
      final locator = ReaderPageLocator(
        bookWith(["The rabbit said \"I'll rest here\" — and slept."]),
      );

      expect(locator.locate('said “I’ll rest here” — and slept'), 1);
    });

    test('sees through Markdown emphasis that never reaches the page', () {
      final locator = ReaderPageLocator(
        bookWith(['The rabbit was **absolutely certain** of victory.']),
      );

      expect(locator.locate('was absolutely certain of victory'), 1);
    });

    test('matches a page heading as well as its body', () {
      final locator = ReaderPageLocator(
        MobileEditableBook(
          projectId: 'project-1',
          title: 'The Book',
          pages: const [
            MobileEditableBookPage(
              id: 'page-1',
              index: 1,
              title: 'The Morning of the Race',
              markdown: 'Body text that says nothing useful.',
              revision: 1,
            ),
          ],
        ),
      );

      expect(locator.locate('The Morning of the Race'), 1);
    });

    test('falls back to the start of a passage spanning a page break', () {
      final locator = ReaderPageLocator(
        bookWith([
          'The rabbit stretched in the long grass and considered the day ahead of him.',
          'Meanwhile the turtle was already a mile down the dusty road.',
        ]),
      );

      // A drag across the page boundary picks up text from both pages; the
      // action should land on the page the selection started in.
      final page = locator.locate(
        'considered the day ahead of him. Meanwhile the turtle was already',
      );
      expect(page, 1);
    });

    test('returns null for a passage that is not in the book', () {
      final locator = ReaderPageLocator(
        bookWith(['The rabbit stretched in the long grass.']),
      );

      expect(locator.locate('a completely different sentence entirely'), isNull);
    });

    test('refuses to guess from a passage too short to be distinctive', () {
      final locator = ReaderPageLocator(
        bookWith(['The rabbit ran.', 'The turtle walked.']),
      );

      expect(locator.locate('the'), isNull);
      expect(locator.locate(''), isNull);
    });
  });

  group('contextWindow', () {
    test('widens a one-word selection into a placeable passage', () {
      const pageText =
          'The rabbit stretched in the long grass and considered the day. '
          'The turtle had already started walking down the dusty road.';
      final start = pageText.indexOf('turtle');

      final window = ReaderPageLocator.contextWindow(
        pageText,
        start,
        start + 'turtle'.length,
        radius: 40,
      );

      expect(window, contains('turtle'));
      expect(window.length, greaterThan('turtle'.length));
      expect(pageText, contains(window));
    });

    test('places a single highlighted word using its surroundings', () {
      // The point of the widening: "turtle" alone appears on both pages, but
      // the text around it does not.
      final locator = ReaderPageLocator(
        bookWith([
          'The turtle waited at the start line, blinking slowly at the crowd.',
          'The turtle crossed the finish line to a silence nobody expected.',
        ]),
      );
      const pageText =
          'The turtle crossed the finish line to a silence nobody expected.';
      final start = pageText.indexOf('turtle');

      expect(locator.locate('turtle'), isNull, reason: 'too short alone');
      expect(
        locator.locate(
          ReaderPageLocator.contextWindow(pageText, start, start + 6),
        ),
        2,
      );
    });

    test('copes with a selection at the very edge of the page', () {
      const pageText = 'Short page.';

      expect(
        ReaderPageLocator.contextWindow(pageText, 0, pageText.length),
        pageText,
      );
      expect(ReaderPageLocator.contextWindow('', 0, 0), '');
    });
  });

  group('ReaderPageLocator page spans', () {
    test('places a rendered page on the book pages it covers', () {
      final locator = ReaderPageLocator(bookWith(harbourPages));

      final span = locator.spanForPageText(
        '${harbourPages[3]} ${harbourPages[4]}',
      );

      expect(span, isNotNull);
      expect(span!.contains(4), isTrue);
      expect(span.contains(5), isTrue);
    });

    test('resolves a recurring passage to the copy the reader is looking at', () {
      // The regression this whole mechanism exists for. The refrain is on
      // pages 2 and 9; scanning the book in order always answers 2, which
      // sends the edit to the front of the book while the reader is at the
      // back of it.
      final locator = ReaderPageLocator(bookWith(harbourPages));
      const refrain = 'the lantern swung twice against the mast';

      expect(locator.locate(refrain), 2);

      final span = locator.spanForPageText(
        '${harbourPages[7]} ${harbourPages[8]}',
      );
      expect(locator.locate(refrain, within: span), 9);
    });

    test('leaves an unconstrained lookup exactly as it was', () {
      final locator = ReaderPageLocator(bookWith(harbourPages));

      expect(
        locator.locate('counted the crates twice', within: null),
        locator.locate('counted the crates twice'),
      );
    });

    test('declines to place a page with no prose to match', () {
      final locator = ReaderPageLocator(bookWith(harbourPages));

      expect(locator.spanForPageText(''), isNull);
      expect(locator.spanForPageText('Contents'), isNull);
      // A contents page: long enough to probe, but none of it is in the book.
      expect(
        locator.spanForPageText(
          'Contents 1 The Harbour 3 2 The Crates 11 3 The Fog 19 4 The Return 27',
        ),
        isNull,
      );
    });

    test('declines to place a page whose probes contradict each other', () {
      // Text that cannot have come from one rendered page. Trusting the spread
      // would narrow the search to a window the passage is not in, which is
      // worse than not narrowing at all.
      final locator = ReaderPageLocator(bookWith(harbourPages));

      expect(
        locator.spanForPageText('${harbourPages[0]} ${harbourPages[9]}'),
        isNull,
      );
    });

    test('reuses the span it already worked out for a PDF page', () {
      final locator = ReaderPageLocator(bookWith(harbourPages));

      final first = locator.spanForPage(
        pdfPageNumber: 3,
        pageText: '${harbourPages[3]} ${harbourPages[4]}',
      );
      final again = locator.spanForPage(
        pdfPageNumber: 3,
        pageText: harbourPages[0],
      );

      expect(again, first);
      expect(
        locator.spanForPage(pdfPageNumber: 4, pageText: harbourPages[0]),
        isNot(first),
      );
    });
  });

  group('normalizeForMatch', () {
    test('collapses whitespace and lowercases', () {
      expect(
        ReaderPageLocator.normalizeForMatch('  The\t Rabbit\n\n Ran  '),
        'the rabbit ran',
      );
    });

    test('drops soft hyphens and zero-width characters', () {
      expect(
        ReaderPageLocator.normalizeForMatch('rab­bit​ran'),
        'rabbitran',
      );
    });

    test('expands ligatures the renderer emits', () {
      expect(ReaderPageLocator.normalizeForMatch('ﬁnal ﬂight'), 'final flight');
    });

    test('keeps a dash that stands between words', () {
      expect(
        ReaderPageLocator.normalizeForMatch('the rabbit — the turtle'),
        'the rabbit - the turtle',
      );
    });
  });
}
