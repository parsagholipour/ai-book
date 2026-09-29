import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/assist_models.dart';
import 'package:tomeza/features/studio/domain/assist_text.dart';

void main() {
  group('the window a request carries', () {
    test('selection, with the text before and after it in the segment', () {
      final window = assistWindowFor(
        text: 'One two. Three four. Five.',
        selection: const TextSelection(baseOffset: 9, extentOffset: 20),
      );
      expect(window.before, 'One two. ');
      expect(window.selection, 'Three four.');
      expect(window.after, ' Five.');
      expect((window.start, window.end), (9, 20));
    });

    test('a cursor carries no selection', () {
      final window = assistWindowFor(
        text: 'Hello world',
        selection: const TextSelection.collapsed(offset: 5),
      );
      expect(window.selection, isNull);
      expect(window.hasSelection, isFalse);
      expect(window.before, 'Hello');
      expect(window.after, ' world');
    });

    test('a short segment reaches back and on through the chapter as '
        'paragraphs of their own', () {
      final window = assistWindowFor(
        text: 'After the picture.',
        selection: const TextSelection.collapsed(offset: 0),
        textBefore: ['First part.', '', 'Second part.'],
        textAfter: ['Later part.'],
      );
      // Ends in a paragraph break: the cursor starts a paragraph.
      expect(window.before, 'First part.\n\nSecond part.\n\n');
      // The next segment is a paragraph away, never a word at the cursor.
      expect(window.after, 'After the picture.\n\nLater part.');
    });

    test('before keeps its last 4000 characters, after its first 1500', () {
      final long = 'a' * 5000;
      final window = assistWindowFor(
        text: '$long|$long',
        selection: const TextSelection.collapsed(offset: 5000),
      );
      expect(window.before.length, assistBeforeChars);
      expect(window.after.length, assistAfterChars);
      expect(window.after, startsWith('|'));
    });

    test('clipping never splits a surrogate pair', () {
      const emoji = '😀';
      expect(clipHead('ab$emoji', 3), 'ab');
      expect(clipTail('${emoji}ab', 3), 'ab');
      expect(clipHead('ab', 5), 'ab');
    });
  });

  group('a rewrite accepted', () {
    const value = TextEditingValue(text: 'One two. Three four. Five.');

    test('replaces the selection verbatim, keeping its whitespace', () {
      final next = replaceSelection(
        value,
        start: 8,
        expected: ' Three four.',
        replacement: ' Three, then four. ',
      );
      expect(next!.text, 'One two. Three, then four.  Five.');
      expect(
        next.selection,
        const TextSelection(baseOffset: 8, extentOffset: 27),
      );
    });

    test('follows the passage when the text around it moved', () {
      final next = replaceSelection(
        const TextEditingValue(text: 'Intro. One two. Three four. Five.'),
        start: 9,
        expected: 'Three four.',
        replacement: 'Three.',
      );
      expect(next!.text, 'Intro. One two. Three. Five.');
    });

    test('refuses when the passage is gone or appears twice', () {
      expect(
        replaceSelection(value, start: 9, expected: 'Six.', replacement: 'x'),
        isNull,
      );
      expect(
        replaceSelection(
          const TextEditingValue(text: 'Go. Go.'),
          start: 1,
          expected: 'Go.',
          replacement: 'Stop.',
        ),
        isNull,
      );
    });
  });

  group('a continuation accepted', () {
    test('goes in at the cursor verbatim, with its own separator', () {
      const text = 'The lamp was cold.\n\nBelow.';
      final next = insertContinuation(
        const TextEditingValue(text: text),
        offset: 18,
        textAtRequest: text,
        insertion: ' The wind rose.',
      );
      expect(next!.text, 'The lamp was cold. The wind rose.\n\nBelow.');
      expect(next.selection, const TextSelection.collapsed(offset: 33));

      final paragraph = insertContinuation(
        const TextEditingValue(text: text),
        offset: 18,
        textAtRequest: text,
        insertion: '\n\nMorning came.',
      );
      expect(paragraph!.text, 'The lamp was cold.\n\nMorning came.\n\nBelow.');
    });

    test('follows the words before the cursor if the text changed', () {
      final next = insertContinuation(
        const TextEditingValue(text: 'New start. The lamp was cold. End.'),
        offset: 18,
        textAtRequest: 'The lamp was cold. End.',
        insertion: ' It hissed.',
      );
      expect(next!.text, 'New start. The lamp was cold. It hissed. End.');
    });
  });

  group('proofreading accepted', () {
    const text = 'Keep this. Mara clmbed teh stairs. Keep that.';
    const selection = 'Mara clmbed teh stairs.';

    test('applies every fix right to left, lengths changing as it goes', () {
      final next = applyCorrections(
        const TextEditingValue(text: text),
        start: 11,
        expected: selection,
        corrections: const [
          AssistCorrection(find: 'clmbed', replace: 'climbed', reason: ''),
          AssistCorrection(find: 'teh', replace: 'the', reason: ''),
          AssistCorrection(find: 'stairs.', replace: 'stairs!', reason: ''),
        ],
      );
      expect(next!.text, 'Keep this. Mara climbed the stairs! Keep that.');
      expect(
        next.selection,
        const TextSelection(baseOffset: 11, extentOffset: 35),
      );
    });

    test('skips a fix whose find is missing, repeated or overlapping', () {
      final placed = placeCorrections('the cat and the hat', const [
        AssistCorrection(find: 'the', replace: 'a', reason: ''),
        AssistCorrection(find: 'dog', replace: 'cat', reason: ''),
        AssistCorrection(find: 'cat and', replace: 'cat, and', reason: ''),
        AssistCorrection(find: 'and the', replace: 'or the', reason: ''),
        AssistCorrection(find: '', replace: 'x', reason: ''),
      ]);
      expect([for (final p in placed) p.correction.find], ['cat and']);
    });

    test('refuses when the selection itself is gone', () {
      expect(
        applyCorrections(
          const TextEditingValue(text: 'Something else entirely.'),
          start: 0,
          expected: selection,
          corrections: const [],
        ),
        isNull,
      );
    });
  });

  group('where a picture goes', () {
    const text = 'First paragraph.\nStill first.\n\nSecond one.\n\nThird.';

    test('after the paragraph the offset is in', () {
      expect(paragraphEndAt(text, 3), 29);
      expect(paragraphEndAt(text, 31), 42);
      expect(paragraphEndAt(text, 45), text.length);
    });

    test('the paragraph at an offset', () {
      expect(paragraphAt(text, 3), 'First paragraph.\nStill first.');
      expect(paragraphAt(text, 35), 'Second one.');
      expect(paragraphAt(text, text.length), 'Third.');
    });

    test('a description starts as the passage in plain words', () {
      expect(
        illustratePromptFrom('## The Harbour\n\n**Mara** saw *the boats*.'),
        'The Harbour Mara saw the boats.',
      );
      final long = List.filled(400, 'harbour').join(' ');
      final prompt = illustratePromptFrom(long);
      expect(prompt.length, lessThanOrEqualTo(illustratePromptChars));
      expect(prompt.endsWith('harbour'), isTrue);
      expect(illustratePassageFrom('x' * 5000).length, illustratePassageChars);
    });
  });
}
