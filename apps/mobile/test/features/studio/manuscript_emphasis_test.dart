import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/domain/manuscript_emphasis.dart';
import 'package:tomeza/features/studio/domain/manuscript_inline.dart';

/// `x **bo|ld**` is a text with a caret; `x **<bo>ld**` one with a selection.
TextEditingValue v(String dsl) {
  final caret = dsl.indexOf('|');
  if (caret >= 0) {
    return TextEditingValue(
      text: dsl.replaceFirst('|', ''),
      selection: TextSelection.collapsed(offset: caret),
    );
  }
  final start = dsl.indexOf('<');
  final end = dsl.indexOf('>');
  if (start >= 0 && end > start) {
    return TextEditingValue(
      text: dsl.replaceFirst('<', '').replaceFirst('>', ''),
      selection: TextSelection(baseOffset: start, extentOffset: end - 1),
    );
  }
  return TextEditingValue(text: dsl);
}

String show(TextEditingValue value) {
  final s = value.selection;
  final t = value.text;
  if (!s.isValid) return t;
  if (s.isCollapsed) {
    return '${t.substring(0, s.baseOffset)}|${t.substring(s.baseOffset)}';
  }
  return '${t.substring(0, s.start)}<${t.substring(s.start, s.end)}>${t.substring(s.end)}';
}

/// [after] is what a text field would hand the formatter: [before] with a key
/// press applied. The answer is what the field ends up holding.
String guarded(
  String before,
  String after, {
  Set<EmphasisKind> typing = const {},
}) => show(guardEdit(v(before), v(after), typingStyle: typing).value);

void main() {
  test('a 10,000-word chapter is guarded quickly after one keystroke', () {
    final paragraphs = <String>[];
    for (var p = 0; p < 200; p++) {
      paragraphs.add(
        [
          for (var w = 0; w < 50; w++)
            w == 7 ? '**bold$p**' : (w == 20 ? '*soft$p*' : 'word$w'),
        ].join(' '),
      );
    }
    var value = TextEditingValue(
      text: paragraphs.join('\n\n'),
      selection: TextSelection.collapsed(offset: 35000),
    );
    // Typing, one letter at a time: each value is the next one's old value, as
    // in the field, so the index of the text before is the one just built.
    final stopwatch = Stopwatch()..start();
    const keys = 40;
    for (var i = 0; i < keys; i++) {
      final at = value.selection.baseOffset;
      final typed = TextEditingValue(
        text: value.text.replaceRange(at, at, 'k'),
        selection: TextSelection.collapsed(offset: at + 1),
      );
      value = snapSelection(value, guardEdit(value, typed).value);
    }
    final perKey = stopwatch.elapsedMilliseconds / keys;
    // A key press has a frame (16ms) to be styled and guarded in.
    expect(perKey, lessThan(10), reason: '$perKey ms per key');
  });

  group('the index', () {
    test('finds bold and italic pairs and the runs of marks they make', () {
      final index = EmphasisIndex.of('a **bold** and *soft* b');
      expect(index.pairs, hasLength(2));
      expect(index.pairs[0].kind, EmphasisKind.bold);
      expect(index.pairs[0].open, const TextRange(start: 2, end: 4));
      expect(index.pairs[0].close, const TextRange(start: 8, end: 10));
      expect(index.pairs[1].kind, EmphasisKind.italic);
      expect(index.runs, hasLength(4));
    });

    test('marks that touch are one run', () {
      final index = EmphasisIndex.of('***both***');
      expect(index.runs, const [
        TextRange(start: 0, end: 3),
        TextRange(start: 7, end: 10),
      ]);
    });

    test('unbalanced marks, snake_case and code fences are not pairs', () {
      expect(EmphasisIndex.of('a **open and * lone').pairs, isEmpty);
      expect(EmphasisIndex.of('file_name_here').pairs, isEmpty);
      expect(EmphasisIndex.of('```\n**not bold**\n```').pairs, isEmpty);
      expect(EmphasisIndex.of('~~gone~~').pairs, isEmpty);
    });

    test('a pair on a later line has its offsets in the whole text', () {
      final index = EmphasisIndex.of('one\n\ntwo **b** end');
      expect(index.pairs.single.open, const TextRange(start: 9, end: 11));
    });

    test('a pair inside a heading, a quote and a list item counts', () {
      expect(EmphasisIndex.of('## A **b**').pairs, hasLength(1));
      expect(EmphasisIndex.of('> *b* c').pairs, hasLength(1));
      expect(EmphasisIndex.of('- **b** c').pairs, hasLength(1));
    });
  });

  group('the cursor', () {
    test('never rests inside a mark: a tap lands on its near edge', () {
      final next = snapSelection(v('x |x **bold** y'), v('x x *|*bold** y'));
      expect(show(next), 'x x |**bold** y');
      expect(
        EmphasisIndex.of(next.text).runAround(next.selection.baseOffset),
        isNull,
      );
    });

    test('a caret stepping right over an opening mark moves on a letter', () {
      // Before `**` to inside it: nothing would show. On, past the `b`.
      final next = snapSelection(v('a |**bold** c'), v('a *|*bold** c'));
      expect(show(next), 'a **b|old** c');
    });

    test('a caret stepping left over an opening mark moves on a letter', () {
      final next = snapSelection(v('a **|bold** c'), v('a *|*bold** c'));
      expect(show(next), 'a| **bold** c');
    });

    test('and the same over a closing mark', () {
      expect(
        show(snapSelection(v('a **bold|** c'), v('a **bold*|* c'))),
        'a **bold** |c',
      );
      expect(
        show(snapSelection(v('a **bold**| c'), v('a **bold*|* c'))),
        'a **bol|d** c',
      );
    });

    test('a single-star mark is stepped over too', () {
      expect(
        show(snapSelection(v('a |*soft* c'), v('a *|soft* c'))),
        'a *s|oft* c',
      );
    });

    test(
      'a jump from one edge of a mark to the other is a tap, not a step',
      () {
        // The caret was after the closing marks; a tap puts it before them.
        expect(
          show(snapSelection(v('**bold**|'), v('**bold|**'))),
          '**bold|**',
        );
        expect(
          show(snapSelection(v('|**bold**'), v('**|bold**'))),
          '**|bold**',
        );
      },
    );

    test('a caret that lands on an edge from far away stays there', () {
      expect(
        show(snapSelection(v('|a **bold** c'), v('a **|bold** c'))),
        'a **|bold** c',
      );
      expect(
        show(snapSelection(v('|a **bold** c'), v('a |**bold** c'))),
        'a |**bold** c',
      );
    });

    test('a selection end inside a mark goes to the edge it was moving to', () {
      final next = snapSelection(
        v('a <bo>ld c **bold**'),
        v('a <bold c *>*bold**'),
      );
      expect(next.selection.extentOffset, isNot(16));
      expect(
        EmphasisIndex.of(next.text).runAround(next.selection.extentOffset),
        isNull,
      );
    });

    test('text with no marks is left alone', () {
      final next = v('plain |text');
      expect(identical(snapSelection(v('plain| text'), next), next), isTrue);
    });
  });

  group('deleting', () {
    test('backspace after a bold word takes its last letter, not a star', () {
      expect(guarded('**bold**|', '**bold*|'), '**bol|**');
    });

    test('backspace just inside a bold word takes the letter before it', () {
      expect(guarded('a **|bold**', 'a *|bold**'), 'a|**bold**');
    });

    test('backspace with nothing but marks before it does nothing', () {
      expect(guarded('**|bold**', '*|bold**'), '**|bold**');
    });

    test('Delete before a bold word takes the letter after the marks', () {
      // The space after the closing marks is the letter Delete meant.
      expect(guarded('**bold|** x', '**bold|* x'), '**bold**|x');
    });

    test('Delete with nothing after the marks does nothing', () {
      expect(guarded('**bold|**', '**bold|*'), '**bold|**');
    });

    test('a letter deleted from a bold word keeps the word bold', () {
      expect(guarded('**bo|ld**', '**b|ld**'), '**b|ld**');
    });

    test('the last letter of a bold word takes the marks with it', () {
      expect(guarded('x **a|** y', 'x **|** y'), 'x | y');
      expect(guarded('x *a|* y', 'x *|* y'), 'x | y');
    });

    test('and so does the last letter of nested bold and italic', () {
      expect(guarded('x ***a|*** y', 'x ***|*** y'), 'x | y');
    });

    test(
      'selecting the letters of a bold word and deleting takes the marks',
      () {
        expect(
          guarded('x **<bold>** y', 'x **| y'.replaceFirst('**| y', '****| y')),
          'x | y',
        );
      },
    );

    test(
      'a range that starts before the word and ends inside it keeps the rest bold',
      () {
        expect(guarded('x <**bo>ld** y', 'x |ld** y'), 'x |**ld** y');
      },
    );

    test(
      'a range that starts inside the word and ends after it keeps the rest bold',
      () {
        expect(guarded('**bo<ld**> z', '**bo| z'), '**bo|** z');
      },
    );

    test('a range over the whole word takes both marks', () {
      expect(guarded('x <**bold**> y', 'x | y'), 'x | y');
    });

    test('typing over letters inside the word replaces them inside it', () {
      expect(guarded('**bo<ld>** z', '**boX|** z'), '**boX|** z');
    });

    test('typing over a range that started before the word keeps it bold', () {
      expect(guarded('x <**bo>ld** y', 'x Q|ld** y'), 'x Q|**ld** y');
    });

    test('a deletion cutting into a mark takes the whole mark, not half', () {
      // Whatever the platform deleted, the word is still one bold word.
      final result = guardEdit(v('x **bold**'), v('x *bold**')).value;
      expect(EmphasisIndex.of(result.text).pairs, hasLength(1));
    });

    test('text with no marks is left to the platform', () {
      final next = v('plain tex|');
      expect(identical(guardEdit(v('plain text|'), next).value, next), isTrue);
    });
  });

  group('typing', () {
    test('a letter at the end of a bold word goes on being bold', () {
      expect(guarded('**bold|**', '**boldx|**'), '**boldx|**');
    });

    test('a space at the end of a bold word goes after the word', () {
      expect(guarded('**bold|**', '**bold |**'), '**bold** |');
    });

    test('a space after the marks stays after them', () {
      expect(guarded('**bold**|', '**bold** |'), '**bold** |');
    });

    test('a space just inside the opening marks goes before them', () {
      expect(guarded('a **|bold**', 'a ** |bold**'), 'a  |**bold**');
    });

    test('a space at the end of nested marks goes after all of them', () {
      expect(guarded('***both|***', '***both |***'), '***both*** |');
    });

    test('Enter inside a bold word ends it and begins it again', () {
      expect(guarded('**bo|ld**', '**bo\n\n|ld**'), '**bo**\n\n**|ld**');
    });

    test('Enter at the end of a bold word leaves the bold behind', () {
      expect(guarded('**bold|**', '**bold\n\n|**'), '**bold**\n\n|');
    });

    test('Enter inside nested marks closes and reopens both', () {
      expect(
        guarded('***bo|th***', '***bo\n\n|th***'),
        '***bo***\n\n***|th***',
      );
    });

    test('a list continuation at the end of a bold item starts after it', () {
      expect(guarded('- **item|**', '- **item\n- |**'), '- **item**\n- |');
    });
  });

  group('typing style', () {
    const bold = {EmphasisKind.bold};
    const italic = {EmphasisKind.italic};

    test('the next thing typed is bold, and the cursor stays inside', () {
      expect(guarded('a |', 'a b|', typing: bold), 'a **b|**');
    });

    test('bold and italic together', () {
      expect(
        guarded('a |', 'a b|', typing: {...bold, ...italic}),
        'a ***b|***',
      );
    });

    test('italic on its own', () {
      expect(guarded('a |', 'a b|', typing: italic), 'a *b|*');
    });

    test('a space typed first goes before the marks', () {
      expect(
        guarded('a|', 'a b|', typing: bold),
        'a **b|**'.replaceFirst('a **', 'a **'),
      );
    });

    test('a bare space does not spend the style', () {
      final result = guardEdit(v('a|'), v('a |'), typingStyle: bold);
      expect(result.appliedTypingStyle, isFalse);
      expect(show(result.value), 'a |');
    });

    test('the style is reported spent when it was used', () {
      final result = guardEdit(v('a |'), v('a b|'), typingStyle: bold);
      expect(result.appliedTypingStyle, isTrue);
    });

    test('right after a bold word it goes on with that word', () {
      expect(guarded('**bold**|', '**bold**x|', typing: bold), '**boldx|**');
    });

    test('it does not go on with a word of the other kind', () {
      expect(guarded('*soft*|', '*soft*x|', typing: bold), '*soft***x|**');
    });

    test('a break is never made bold', () {
      final result = guardEdit(v('a|'), v('a\n\n|'), typingStyle: bold);
      expect(result.appliedTypingStyle, isFalse);
    });

    test('after spaces typed at the end of a bold word, it goes on with it', () {
      expect(guarded('**Your** |', '**Your** f|', typing: bold), '**Your f|**');
      expect(guarded('**a**  |', '**a**  b|', typing: bold), '**a  b|**');
    });

    test('a word typed with its own space goes in, and the space after it', () {
      expect(guarded('**a** |', '**a** b |', typing: bold), '**a b** |');
      expect(guarded('**a**|', '**a** b|', typing: bold), '**a b|**');
    });

    test('it does not go on with a word on the line before', () {
      expect(guarded('**a**\n|', '**a**\nb|', typing: bold), '**a**\n**b|**');
    });

    test('or across spaces with a word of the other kind', () {
      expect(guarded('*soft* |', '*soft* x|', typing: bold), '*soft* **x|**');
    });

    test('bold alone goes on with bold, closing italic inside it first', () {
      final result = guarded('**_a_** |', '**_a_** b|', typing: bold);
      expect(result, '**_a_ b|**');
    });

    test('the composing region moves back over the marks with the word', () {
      final next = v(
        '**a** b|',
      ).copyWith(composing: const TextRange(start: 6, end: 7));
      final result = guardEdit(v('**a** |'), next, typingStyle: bold).value;
      expect(show(result), '**a b|**');
      expect(result.composing, const TextRange(start: 4, end: 5));
    });

    test('the composing region of the IME moves with the letter', () {
      final next = v(
        'a b|',
      ).copyWith(composing: const TextRange(start: 2, end: 3));
      final result = guardEdit(v('a |'), next, typingStyle: bold).value;
      expect(result.text, 'a **b**');
      expect(result.composing, const TextRange(start: 4, end: 5));
    });
  });

  group('the style going on through spaces', () {
    const bold = {EmphasisKind.bold};
    Set<EmphasisKind> after(
      String before,
      String now, {
      Set<EmphasisKind> style = const {},
    }) => continuedTypingStyle(v(before), v(now), style);

    test('a space at the end of a bold word keeps bold on', () {
      expect(after('**Your|**', '**Your** |'), bold);
    });

    test('and so does a second one, while the style is on', () {
      expect(after('**a** |', '**a**  |', style: bold), bold);
    });

    test('nested bold and italic both go on', () {
      expect(after('***both|***', '***both*** |'), {
        EmphasisKind.bold,
        EmphasisKind.italic,
      });
    });

    test('a space after plain text, or after marks it was not in, does not', () {
      expect(after('a|', 'a |'), isEmpty);
      expect(after('**a** |', '**a**  |'), isEmpty);
    });

    test('Enter, a letter, a deletion and a move all end it', () {
      expect(after('**a** |', '**a** \n|', style: bold), isEmpty);
      expect(after('**a** |', '**a** b|', style: bold), isEmpty);
      expect(after('**a**  |', '**a** |', style: bold), isEmpty);
      expect(after('**a** |', '**a**| ', style: bold), isEmpty);
    });
  });

  group('typing a phrase in bold, a key at a time', () {
    /// Each character as its own key press, through the formatter's rule and
    /// the controller's, the way a keyboard (and adb) deliver them.
    ({TextEditingValue value, Set<EmphasisKind> style}) type(
      TextEditingValue value,
      String keys,
      Set<EmphasisKind> style,
    ) {
      for (final key in keys.split('')) {
        final at = value.selection.baseOffset;
        final raw = TextEditingValue(
          text: value.text.replaceRange(at, at, key),
          selection: TextSelection.collapsed(offset: at + key.length),
        );
        final next = guardEdit(value, raw, typingStyle: style).value;
        style = continuedTypingStyle(value, next, style);
        value = next;
      }
      return (value: value, style: style);
    }

    test('the whole phrase is one bold run', () {
      final typed = type(v('say |'), 'Your first cry', {EmphasisKind.bold});
      expect(show(typed.value), 'say **Your first cry|**');
      expect(EmphasisIndex.of(typed.value.text).pairs, hasLength(1));
    });

    test('a space nothing follows stays outside the marks', () {
      final typed = type(v('say |'), 'Your first ', {EmphasisKind.bold});
      expect(show(typed.value), 'say **Your first** |');
      expect(typed.style, {EmphasisKind.bold});
    });

    test('turned off after a space, the next word is plain', () {
      final typed = type(v('say |'), 'Your ', {EmphasisKind.bold});
      final plain = type(typed.value, 'first', const {});
      expect(show(plain.value), 'say **Your** first|');
    });

    test('Enter after a space leaves the space outside and ends the style', () {
      final typed = type(v('say |'), 'Your \nnext', {EmphasisKind.bold});
      expect(show(typed.value), 'say **Your** \nnext|');
      expect(typed.style, isEmpty);
    });

    test('italic phrases too', () {
      final typed = type(v('|'), 'very soft', {EmphasisKind.italic});
      expect(show(typed.value), '*very soft|*');
    });
  });

  group('a keyboard one edit behind', () {
    TextEditingValue composing(String dsl, int start, int end) =>
        v(dsl).copyWith(composing: TextRange(start: start, end: end));

    test('a letter typed on the text before the marks went in', () {
      final rebased = rebaseKeyboardEdit(
        sent: composing('S|', 0, 1),
        current: composing('**S|**', 2, 3),
        next: composing('Sh|', 0, 2),
      )!;
      expect(show(rebased), '**Sh|**');
      expect(rebased.composing, const TextRange(start: 2, end: 4));
    });

    test('a composing word finished on the text before the rewrite', () {
      final rebased = rebaseKeyboardEdit(
        sent: composing('x **a** b|', 8, 9),
        current: composing('x **a b|**', 6, 7),
        next: v('x **a** b|'),
      )!;
      expect(show(rebased), 'x **a b|**');
      expect(rebased.composing, TextRange.empty);
    });

    test('an edit already made on the current text is left alone', () {
      expect(
        rebaseKeyboardEdit(
          sent: v('S|'),
          current: v('**S|**'),
          next: v('**Sh|**'),
        ),
        isNull,
      );
    });

    test('an edit away from the caret is not moved', () {
      expect(
        rebaseKeyboardEdit(
          sent: v('ab S|'),
          current: v('ab **S|**'),
          next: v('xab S'),
        ),
        isNull,
      );
    });
  });

  group('Bold again at the end of a bold run', () {
    test('steps out of the run, leaving every letter bold', () {
      final left = leaveRunEnd(v('say **hi there|**'), EmphasisKind.bold)!;
      expect(show(left.value), 'say **hi there**|');
      expect(left.keep, isEmpty);
    });

    test('italic inside the bold stays on', () {
      final left = leaveRunEnd(v('***both|***'), EmphasisKind.bold);
      expect(left, isNotNull);
      expect(left!.keep, {EmphasisKind.italic});
      expect(left.value.selection.baseOffset, greaterThan(6));
    });

    test('not at the end of a run, it is not this rule', () {
      expect(leaveRunEnd(v('**bo|ld**'), EmphasisKind.bold), isNull);
      expect(leaveRunEnd(v('*soft|*'), EmphasisKind.bold), isNull);
      expect(leaveRunEnd(v('plain|'), EmphasisKind.bold), isNull);
    });
  });

  group('the Bold and Italic buttons', () {
    String bold(String dsl) => show(toggleEmphasis(v(dsl), EmphasisKind.bold));
    String italic(String dsl) =>
        show(toggleEmphasis(v(dsl), EmphasisKind.italic));

    test('a selection that took only one of the marks is the word', () {
      // Dragging over a bold word from before it to its end includes the
      // opening marks and not the closing ones.
      expect(bold('x <**bold>** y'), 'x <bold> y');
      expect(bold('x **<bold**> y'), 'x <bold> y');
    });

    test('part of a bold run loses bold and the rest keeps it', () {
      expect(bold('**hello <world>**'), '**hello** <world>');
      expect(bold('**<hello> world**'), '<hello> **world**');
      expect(bold('**a <b> c**'), '**a** <b> **c**');
    });

    test('the word under the cursor, inside a longer bold run', () {
      expect(bold('**hello wor|ld**'), '**hello** wor|ld');
    });

    test('a selection that is partly bold becomes all bold', () {
      expect(bold('<**a** b>'), '**<a b>**');
      expect(bold('**a** <b **c**>'), '**a** **<b c>**');
      expect(bold('<**a** b **c**>'), '**<a b c>**');
    });

    test('bold next to a bold word joins it', () {
      expect(bold('**a**<b>'), '**<ab>**');
    });

    test('italic in bold and back, marks staying paired', () {
      expect(italic('**<word>**'), '***<word>***');
      expect(bold('***<word>***'), '*<word>*');
      expect(italic('***<word>***'), '**<word>**');
    });

    test('a selection of nothing but marks does nothing', () {
      final value = v('x <**>bold**');
      expect(
        identical(toggleEmphasis(value, EmphasisKind.bold), value),
        isTrue,
      );
    });

    test(
      'with the cursor between words an empty pair goes in and comes out',
      () {
        final opened = toggleEmphasis(v('a | b'), EmphasisKind.bold);
        expect(show(opened), 'a **|** b');
        expect(show(toggleEmphasis(opened, EmphasisKind.bold)), 'a | b');
      },
    );

    test('the cursor keeps its place in the word', () {
      expect(bold('one tw|o three'), 'one **tw|o** three');
      expect(
        show(toggleEmphasis(v('one **tw|o** three'), EmphasisKind.bold)),
        'one tw|o three',
      );
    });
  });

  group('where the cursor is', () {
    test('inside bold text, at either inside edge, it is bold', () {
      expect(emphasisAt(v('**bo|ld**'), EmphasisKind.bold), isTrue);
      expect(emphasisAt(v('**bold|**'), EmphasisKind.bold), isTrue);
      expect(emphasisAt(v('**|bold**'), EmphasisKind.bold), isTrue);
    });

    test('outside its marks it is not, and bold is not italic', () {
      expect(emphasisAt(v('**bold**|'), EmphasisKind.bold), isFalse);
      expect(emphasisAt(v('|**bold**'), EmphasisKind.bold), isFalse);
      expect(emphasisAt(v('**bo|ld**'), EmphasisKind.italic), isFalse);
    });

    test('a selection is bold only when all of it is', () {
      expect(emphasisAt(v('**b<ol>d**'), EmphasisKind.bold), isTrue);
      expect(emphasisAt(v('a <b **bo>ld**'), EmphasisKind.bold), isFalse);
    });

    test('the cursor touches a word in it or against it', () {
      expect(cursorTouchesWord(v('one t|wo')), isTrue);
      expect(cursorTouchesWord(v('one| two')), isTrue);
      expect(cursorTouchesWord(v('one |two')), isTrue);
      expect(cursorTouchesWord(v('one | two')), isFalse);
      expect(cursorTouchesWord(v('|')), isFalse);
    });
  });
}
