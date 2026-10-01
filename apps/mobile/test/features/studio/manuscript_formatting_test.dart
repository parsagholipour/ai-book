import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/manuscript_formatting.dart';

/// Writes a value as text with `|` for a collapsed cursor, or `[` `]` around
/// a selection, so each case reads as before → after.
TextEditingValue v(String marked) {
  final caret = marked.indexOf('|');
  if (caret >= 0) {
    return TextEditingValue(
      text: marked.replaceFirst('|', ''),
      selection: TextSelection.collapsed(offset: caret),
    );
  }
  final start = marked.indexOf('[');
  final end = marked.indexOf(']') - 1;
  return TextEditingValue(
    text: marked.replaceFirst('[', '').replaceFirst(']', ''),
    selection: TextSelection(baseOffset: start, extentOffset: end),
  );
}

String show(TextEditingValue value) {
  final s = value.selection;
  if (s.isCollapsed) {
    return value.text.replaceRange(s.start, s.start, '|');
  }
  return value.text
      .replaceRange(s.end, s.end, ']')
      .replaceRange(s.start, s.start, '[');
}

void main() {
  group('bold', () {
    test('wraps a selection', () {
      expect(show(toggleBold(v('The [old] house'))), 'The **[old]** house');
    });
    test('unwraps a selection inside markers', () {
      expect(show(toggleBold(v('The **[old]** house'))), 'The [old] house');
    });
    test('unwraps a selection that includes its markers', () {
      expect(show(toggleBold(v('The [**old**] house'))), 'The [old] house');
    });
    test('keeps spaces outside the markers', () {
      expect(show(toggleBold(v('The[ old ]house'))), 'The **[old]** house');
    });
    test('applies to the word under the cursor', () {
      expect(show(toggleBold(v('The ol|d house'))), 'The **ol|d** house');
    });
    test('removes from the word under the cursor', () {
      expect(show(toggleBold(v('The **ol|d** house'))), 'The ol|d house');
    });
    test('inserts an empty pair between words, and takes it back', () {
      final opened = toggleBold(v('The | house'));
      expect(show(opened), 'The **|** house');
      expect(show(toggleBold(opened)), 'The | house');
    });
    test('leaves italic alone', () {
      expect(show(toggleBold(v('*[word]*'))), '***[word]***');
      expect(show(toggleBold(v('***[word]***'))), '*[word]*');
    });
    test('works on Persian words', () {
      expect(show(toggleBold(v('خانه‌ی [قدیمی]'))), 'خانه‌ی **[قدیمی]**');
    });
  });

  group('italic', () {
    test('wraps and unwraps', () {
      final on = toggleItalic(v('A [quiet] night'));
      expect(show(on), 'A *[quiet]* night');
      expect(show(toggleItalic(on)), 'A [quiet] night');
    });
    test('does not mistake bold for italic', () {
      expect(show(toggleItalic(v('**[word]**'))), '***[word]***');
      expect(show(toggleItalic(v('***[word]***'))), '**[word]**');
    });
  });

  group('heading', () {
    test('cycles none → ## → ### → none', () {
      final h2 = cycleHeading(v('The Harbour|'));
      expect(show(h2), '## The Harbour|');
      final h3 = cycleHeading(h2);
      expect(show(h3), '### The Harbour|');
      expect(show(cycleHeading(h3)), 'The Harbour|');
    });
    test('acts on the cursor line only', () {
      expect(
        show(cycleHeading(v('First\n\nSec|ond\n\nThird'))),
        'First\n\n## Sec|ond\n\nThird',
      );
    });
    test('a # heading moves on to ##', () {
      expect(show(cycleHeading(v('# Ti|tle'))), '## Ti|tle');
    });
  });

  group('quote and list', () {
    test('quote toggles the selected lines', () {
      final quoted = toggleQuote(v('[one\ntwo]'));
      expect(quoted.text, '> one\n> two');
      expect(toggleQuote(quoted).text, 'one\ntwo');
    });
    test('quote at a cursor quotes its line', () {
      expect(show(toggleQuote(v('a\n\nsay |this'))), 'a\n\n> say |this');
    });
    test('list toggles, and removes numbered markers too', () {
      final listed = toggleList(v('[apples\npears]'));
      expect(listed.text, '- apples\n- pears');
      expect(toggleList(listed).text, 'apples\npears');
      expect(toggleList(v('1. on|e')).text, 'one');
    });
    test('mixed lines are all brought into the list', () {
      expect(toggleList(v('[- a\nb]')).text, '- a\n- b');
    });
  });

  group('scene break', () {
    test('mid-paragraph it becomes a paragraph of its own', () {
      expect(
        show(insertSceneBreak(v('End of scene.|Next scene.'))),
        'End of scene.\n\n***\n\n|Next scene.',
      );
    });
    test('at the end it leaves the cursor on a fresh paragraph', () {
      expect(show(insertSceneBreak(v('The end.|'))), 'The end.\n\n***\n\n|');
    });
    test('between paragraphs it adds no extra blank lines', () {
      expect(
        show(insertSceneBreak(v('One.\n\n|\n\nTwo.'))),
        'One.\n\n***\n\n|Two.',
      );
    });
    test('on an empty field it is just the break', () {
      expect(show(insertSceneBreak(v('|'))), '***\n\n|');
    });
  });

  group('Enter', () {
    const formatter = ManuscriptEnterFormatter();
    TextEditingValue type(String marked) {
      final old = v(marked);
      final at = old.selection.start;
      final typed = TextEditingValue(
        text: old.text.replaceRange(at, at, '\n'),
        selection: TextSelection.collapsed(offset: at + 1),
      );
      return formatter.formatEditUpdate(old, typed);
    }

    test('starts a new paragraph', () {
      expect(show(type('A sentence.|')), 'A sentence.\n\n|');
      expect(show(type('Split| here')), 'Split\n\n| here');
    });
    test('on a blank line it is a plain newline', () {
      expect(show(type('A.\n\n|')), 'A.\n\n\n|');
    });
    test('continues a list, and an empty item ends it', () {
      expect(show(type('- milk|')), '- milk\n- |');
      expect(show(type('1. first|')), '1. first\n2. |');
      // A blank line after the list, or the next line continues the item.
      expect(show(type('- milk\n- |')), '- milk\n\n|');
      expect(show(type('- |')), '|');
    });
    test('inside a code fence it is a plain newline', () {
      expect(show(type('```\ncode|\n```')), '```\ncode\n|\n```');
    });
    test('leaves pastes and composition alone', () {
      final old = v('Hello|');
      final pasted = const TextEditingValue(
        text: 'Hello\nworld',
        selection: TextSelection.collapsed(offset: 11),
      );
      expect(formatter.formatEditUpdate(old, pasted), pasted);
    });
  });
}
