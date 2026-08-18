import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_actions.dart';

/// The API parses these strings — `pageIndexesFromMessage` reads the page from
/// `page N`, `quotedTexts` reads the passage from the double quotes, and
/// `replacementTermsFromMessage` reads a replacement from two quoted terms in
/// order. The shapes below are what make a selection in a continuously
/// rendered PDF land on the right book page.
void main() {
  group('readerRewriteMessage', () {
    test('names the page and quotes the passage', () {
      final message = readerRewriteMessage(
        pageNumber: 12,
        excerpt: 'The rabbit stretched in the long grass.',
        instruction: 'Make it warmer.',
      );

      expect(message, contains('page 12'));
      expect(message, contains('"The rabbit stretched in the long grass."'));
      expect(message, endsWith('Make it warmer.'));
    });

    test('stands alone when no instruction was given', () {
      final message = readerRewriteMessage(
        pageNumber: 3,
        excerpt: 'A short passage.',
        instruction: '   ',
      );

      expect(message, 'On page 3, rewrite this passage: "A short passage.".');
    });
  });

  group('readerReplaceMessage', () {
    test('puts the old and new terms in quotes, in order', () {
      final message = readerReplaceMessage(
        pageNumber: 7,
        from: 'Rabbit',
        to: 'Hare',
      );

      expect(message, 'On page 7, replace "Rabbit" with "Hare".');
      // The two quoted terms, in this order, are what makes the API treat it
      // as an exact replacement rather than a rewrite.
      final quoted = RegExp(
        r'"([^"]+)"',
      ).allMatches(message).map((match) => match.group(1)).toList();
      expect(quoted, ['Rabbit', 'Hare']);
    });

    test('trims stray whitespace from the terms', () {
      expect(
        readerReplaceMessage(pageNumber: 1, from: '  Rabbit ', to: ' Hare  '),
        'On page 1, replace "Rabbit" with "Hare".',
      );
    });
  });

  group('messages without a resolved page', () {
    test('rewrite still quotes the passage', () {
      final message = readerRewriteMessage(
        pageNumber: null,
        excerpt: 'The rabbit ran.',
        instruction: 'Make it slower.',
      );

      expect(message, startsWith('Rewrite this passage: "The rabbit ran."'));
      expect(message, endsWith('Make it slower.'));
      expect(message, isNot(contains('page null')));
    });

    test('replace keeps both quoted terms in order', () {
      final message = readerReplaceMessage(
        pageNumber: null,
        from: 'Rabbit',
        to: 'Hare',
      );

      expect(message, 'In the book, replace "Rabbit" with "Hare".');
      final quoted = RegExp(
        r'"([^"]+)"',
      ).allMatches(message).map((match) => match.group(1)).toList();
      expect(quoted, ['Rabbit', 'Hare']);
    });

    test('ask still prefills the excerpt', () {
      expect(
        readerAskDraft(pageNumber: null, excerpt: 'Why this scene?'),
        'About this passage: "Why this scene?" — ',
      );
    });
  });

  group('readerAskDraft', () {
    test('prefills the composer with the passage and leaves room to type', () {
      final draft = readerAskDraft(pageNumber: 5, excerpt: 'Why this scene?');

      expect(draft, 'About page 5: "Why this scene?" — ');
      expect(draft, endsWith(' '));
    });
  });

  group('ReaderSelection', () {
    test('truncates an excerpt to what the API will read as a quote', () {
      final selection = ReaderSelection(text: 'word ' * 200, pdfPageNumber: 2);

      expect(selection.excerpt.length, lessThanOrEqualTo(401));
      expect(selection.excerpt, endsWith('…'));
    });

    test('leaves a short passage untouched', () {
      const selection = ReaderSelection(
        text: 'The rabbit ran.',
        pdfPageNumber: 2,
      );

      expect(selection.excerpt, 'The rabbit ran.');
    });

    test('still carries the excerpt when it could not be placed', () {
      // A passage that cannot be tied to a page is not a dead end: the actions
      // stay available and the message goes without the page number.
      const unplaced = ReaderSelection(text: 'A passage.', pdfPageNumber: 2);

      expect(unplaced.bookPageIndex, isNull);
      expect(unplaced.excerpt, 'A passage.');
    });

    test('tells "still looking" apart from "could not be placed"', () {
      // The menu opens before the page is known. Reading a null index as a
      // failure would flash "not identified" over every selection for the beat
      // it takes to resolve one.
      const resolving = ReaderSelection(text: 'A passage.', pdfPageNumber: 2);
      const failed = ReaderSelection(
        text: 'A passage.',
        pdfPageNumber: 2,
        placed: true,
      );
      const found = ReaderSelection(
        text: 'A passage.',
        pdfPageNumber: 2,
        bookPageIndex: 14,
        placed: true,
      );

      expect(resolving.placementLabel, 'Finding page…');
      expect(failed.placementLabel, 'Page not identified');
      // The label shows the PDF page the reader can see, not the book index.
      expect(found.placementLabel, 'Page 2');
    });

    test('labels the cover instead of calling it page 1', () {
      const cover = ReaderSelection(
        text: 'A passage.',
        pdfPageNumber: 1,
        bookPageIndex: 1,
        placed: true,
        hasCoverPage: true,
      );
      const afterCover = ReaderSelection(
        text: 'A passage.',
        pdfPageNumber: 2,
        bookPageIndex: 1,
        placed: true,
        hasCoverPage: true,
        exportRevision: 7,
        pdfDigest: 'pdf-a',
      );
      expect(cover.placementLabel, 'Cover');
      expect(cover.displayPageNumber, isNull);
      expect(afterCover.placementLabel, 'Page 1');
      expect(afterCover.displayPageNumber, 1);
      expect(afterCover.chatReaderContext['pdfPage'], 2);
    });

    test('a physical sheet travels only with the file it is a sheet of', () {
      // The revision cannot authorize it. A repair republishes the same
      // revision over different bytes, and the server resolves a sheet through
      // whichever map is in force — so an unidentified file must send no sheet
      // at all rather than one that will be read against another PDF.
      const unidentified = ReaderSelection(
        text: 'A passage.',
        pdfPageNumber: 6,
        bookPageIndex: 3,
        placed: true,
        exportRevision: 7,
      );
      const identified = ReaderSelection(
        text: 'A passage.',
        pdfPageNumber: 6,
        bookPageIndex: 3,
        placed: true,
        exportRevision: 7,
        pdfDigest: 'pdf-a',
      );

      // The resolved book page is model-space and survives either way.
      expect(unidentified.chatReaderContext['pageIndex'], 3);
      expect(identified.chatReaderContext['pageIndex'], 3);
      expect(unidentified.chatReaderContext.containsKey('pdfPage'), isFalse);
      expect(identified.chatReaderContext['pdfPage'], 6);
      expect(identified.chatReaderContext['pdfDigest'], 'pdf-a');
    });
  });

  group('printedPageForPdfPage', () {
    test('skips the cover sheet', () {
      expect(printedPageForPdfPage(1, hasCoverPage: true), isNull);
      expect(printedPageForPdfPage(2, hasCoverPage: true), 1);
      expect(printedPageForPdfPage(1, hasCoverPage: false), 1);
      expect(printedPageCount(10, hasCoverPage: true), 9);
      expect(printedPageCount(10, hasCoverPage: false), 10);
      expect(printedPagePositionLabel(1, 10, hasCoverPage: true), 'Cover');
      expect(
        printedPagePositionLabel(2, 10, hasCoverPage: true),
        'Page 1 of 9',
      );
      expect(
        printedPagePositionLabel(1, 10, hasCoverPage: false),
        'Page 1 of 10',
      );
      expect(printedPageContentsLabel(1, hasCoverPage: true), 'Cover');
      expect(printedPageContentsLabel(3, hasCoverPage: true), '2');
      expect(printedPageContentsLabel(3, hasCoverPage: false), '3');
    });
  });

  group('displayedHasCoverPage', () {
    const map = MobilePdfPageNumbering(
      hasCoverPage: true,
      contentRevision: 7,
      pdfDigest: 'pdf-a',
    );

    test('skips the cover only when the open bytes match the map digest', () {
      expect(
        displayedHasCoverPage(
          renderedDigest: 'pdf-a',
          statusHasCoverPage: true,
          pageNumbering: map,
        ),
        isTrue,
      );
      expect(
        displayedHasCoverPage(
          renderedDigest: 'pdf-b',
          statusHasCoverPage: false,
          pageNumbering: map,
        ),
        isFalse,
      );
      expect(
        displayedHasCoverPage(
          renderedDigest: 'pdf-a',
          statusHasCoverPage: null,
          pageNumbering: map,
        ),
        isFalse,
      );
    });

    test(
      'ignores a newly published cover-skip while the old PDF is still open',
      () {
        // Version-1 footers number the cover. The new version-2 map reports
        // hasCoverPage; using it here would label sheet 2 "Page 1" while the
        // footer still says "Page 2".
        expect(
          displayedHasCoverPage(
            renderedDigest: 'pdf-old',
            statusHasCoverPage: true,
            pageNumbering: map,
          ),
          isFalse,
        );
        expect(
          displayedHasCoverPage(
            renderedDigest: null,
            statusHasCoverPage: true,
            pageNumbering: map,
          ),
          isFalse,
        );
      },
    );

    test('keeps an EDITING behind map only for its exact older bytes', () {
      expect(
        displayedHasCoverPage(
          renderedDigest: 'pdf-a',
          statusHasCoverPage: true,
          pageNumbering: map,
        ),
        isTrue,
      );
      expect(
        displayedHasCoverPage(
          renderedDigest: 'pdf-b',
          statusHasCoverPage: true,
          pageNumbering: map,
        ),
        isFalse,
      );
      expect(
        displayedHasCoverPage(
          renderedDigest: 'pdf-a',
          statusHasCoverPage: true,
          pageNumbering: const MobilePdfPageNumbering(
            hasCoverPage: true,
            contentRevision: 8,
            pdfDigest: 'pdf-new',
          ),
        ),
        isFalse,
      );
    });

    test('keys off the open file\'s stamp, not off revisions disagreeing', () {
      expect(
        displayedHasCoverPage(
          cachedHasCoverPage: true,
          renderedDigest: 'pdf-other',
          statusHasCoverPage: true,
          pageNumbering: map,
        ),
        isTrue,
        reason: 'a still-open version-2 PDF already skips the cover',
      );
      expect(
        displayedHasCoverPage(
          cachedHasCoverPage: false,
          renderedDigest: 'pdf-other',
          statusHasCoverPage: true,
          pageNumbering: map,
        ),
        isFalse,
        reason: 'a still-open version-1 PDF still numbers the cover',
      );
      expect(
        displayedHasCoverPage(
          cachedHasCoverPage: false,
          renderedDigest: 'pdf-a',
          statusHasCoverPage: true,
          pageNumbering: map,
        ),
        isFalse,
        reason: 'the file\'s own stamp outranks a matching status flag',
      );
    });
  });

  group('coverPageMapDescribes', () {
    const map = MobilePdfPageNumbering(
      hasCoverPage: true,
      contentRevision: 7,
      pdfDigest: 'pdf-a',
    );

    test('requires the exact byte digest', () {
      expect(
        coverPageMapDescribes(fileDigest: 'pdf-a', pageNumbering: map),
        isTrue,
      );
      expect(
        coverPageMapDescribes(fileDigest: 'pdf-b', pageNumbering: map),
        isFalse,
      );
      expect(
        coverPageMapDescribes(fileDigest: null, pageNumbering: map),
        isFalse,
        reason: 'legacy bytes with no identity are described by nothing',
      );
      expect(
        coverPageMapDescribes(fileDigest: 'pdf-a', pageNumbering: null),
        isFalse,
        reason: 'a legacy map with no identity is not a guess',
      );
    });

    test('revision does not substitute for artifact identity', () {
      expect(
        coverPageMapDescribes(fileDigest: 'pdf-a', pageNumbering: map),
        isTrue,
      );
      expect(
        coverPageMapDescribes(fileDigest: 'pdf-b', pageNumbering: map),
        isFalse,
      );
    });
  });
}
