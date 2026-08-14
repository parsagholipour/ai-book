import 'package:flutter_test/flutter_test.dart';
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
      final quoted = RegExp(r'"([^"]+)"')
          .allMatches(message)
          .map((match) => match.group(1))
          .toList();
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
      final quoted = RegExp(r'"([^"]+)"')
          .allMatches(message)
          .map((match) => match.group(1))
          .toList();
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
      final selection = ReaderSelection(
        text: 'word ' * 200,
        pdfPageNumber: 2,
      );

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
  });
}
