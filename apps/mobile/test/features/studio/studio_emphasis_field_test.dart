import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/studio/domain/manuscript_emphasis.dart';
import 'package:tomeza/features/studio/domain/manuscript_inline.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';
import 'package:tomeza/features/studio/presentation/studio_editor.dart';
import 'package:tomeza/features/studio/presentation/studio_toolbar.dart';

/// Bold and italic with their marks hidden, through a real text field: key
/// presses and IME updates go in the way the platform sends them, so the
/// formatter and the controller's cursor rules run where they run in the app.

Future<StudioTextEntry> pumpField(WidgetTester tester, String text) async {
  final entry = StudioTextEntry(text);
  await tester.pumpWidget(
    MaterialApp(
      theme: buildTomezaLightTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => Padding(
            padding: const EdgeInsets.all(20),
            child: StudioTextField(
              entry: entry,
              style: studioBodyStyle(context),
            ),
          ),
        ),
      ),
    ),
  );
  entry.focusNode.requestFocus();
  await tester.pump();
  return entry;
}

/// `x **bo|ld**` as a value.
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
  return TextEditingValue(
    text: dsl.replaceFirst('<', '').replaceFirst('>', ''),
    selection: TextSelection(baseOffset: start, extentOffset: end - 1),
  );
}

String show(TextEditingValue value) {
  final s = value.selection;
  final t = value.text;
  if (s.isCollapsed) return t.replaceRange(s.start, s.start, '|');
  return t.replaceRange(s.end, s.end, '>').replaceRange(s.start, s.start, '<');
}

/// The field holding [dsl]: text and cursor set the way a tap would.
Future<StudioTextEntry> holding(WidgetTester tester, String dsl) async {
  final value = v(dsl);
  final entry = await pumpField(tester, value.text);
  entry.controller.selection = value.selection;
  await tester.pump();
  return entry;
}

/// What the keyboard sends when [dsl] becomes [after].
Future<void> keyboard(WidgetTester tester, String after) async {
  tester.testTextInput.updateEditingValue(v(after));
  await tester.pump();
}

String now(StudioTextEntry entry) => show(entry.controller.value);

void main() {
  testWidgets('a space at the end of a bold word lands after it', (t) async {
    final entry = await holding(t, '**bold|**');
    await keyboard(t, '**bold |**');
    expect(now(entry), '**bold** |');
    expect(EmphasisIndex.of(entry.text).pairs, hasLength(1));
  });

  testWidgets('backspace after a bold word takes its last letter', (t) async {
    final entry = await holding(t, '**bold**|');
    await t.sendKeyEvent(LogicalKeyboardKey.backspace);
    await t.pump();
    expect(now(entry), '**bol|**');
  });

  testWidgets('backspace next to the opening marks takes the letter before', (
    t,
  ) async {
    final entry = await holding(t, 'a b **|bold**');
    await t.sendKeyEvent(LogicalKeyboardKey.backspace);
    await t.pump();
    expect(entry.text, 'a b**bold**');
  });

  testWidgets('backspacing a bold word away takes its marks with it', (
    t,
  ) async {
    final entry = await holding(t, 'x **ab|** y');
    await t.sendKeyEvent(LogicalKeyboardKey.backspace);
    await t.sendKeyEvent(LogicalKeyboardKey.backspace);
    await t.pump();
    expect(now(entry), 'x | y');
  });

  testWidgets('Delete over the marks takes the letter after them', (t) async {
    final entry = await holding(t, '**bold|**x');
    await t.sendKeyEvent(LogicalKeyboardKey.delete);
    await t.pump();
    expect(entry.text, '**bold**');
  });

  testWidgets('arrow keys never stop on a mark', (t) async {
    final entry = await holding(t, 'a |**bold** c');
    final seen = <int>[];
    for (var i = 0; i < 6; i++) {
      await t.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await t.pump();
      seen.add(entry.controller.selection.baseOffset);
    }
    final index = EmphasisIndex.of(entry.text);
    for (final offset in seen) {
      expect(index.runAround(offset), isNull, reason: 'stopped inside a mark');
    }
    // Every press moved the caret on by a letter you can see.
    final visible = [
      for (final offset in seen)
        offset -
            index.runs
                .where((run) => run.end <= offset)
                .fold<int>(0, (sum, run) => sum + run.end - run.start),
    ];
    for (var i = 1; i < visible.length; i++) {
      expect(visible[i], greaterThan(visible[i - 1]));
    }
  });

  testWidgets('arrow left steps back over a bold word as it came', (t) async {
    final entry = await holding(t, 'a **bold** c|');
    final seen = <int>[];
    for (var i = 0; i < 8; i++) {
      await t.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await t.pump();
      seen.add(entry.controller.selection.baseOffset);
    }
    final index = EmphasisIndex.of(entry.text);
    for (final offset in seen) {
      expect(index.runAround(offset), isNull);
    }
    expect(seen.toSet().length, seen.length, reason: 'a press did nothing');
  });

  testWidgets('a tap that lands between two hidden stars moves out', (t) async {
    final entry = await holding(t, 'one two three **bold** end|');
    entry.controller.selection = const TextSelection.collapsed(offset: 15);
    await t.pump();
    expect(
      EmphasisIndex.of(
        entry.text,
      ).runAround(entry.controller.selection.baseOffset),
      isNull,
    );
  });

  testWidgets('Enter inside a bold word ends the bold and starts it again', (
    t,
  ) async {
    final entry = await holding(t, '**bo|ld**');
    await keyboard(t, '**bo\n|ld**');
    expect(now(entry), '**bo**\n\n**|ld**');
    // Both halves are bold words.
    expect(EmphasisIndex.of(entry.text).pairs, hasLength(2));
  });

  testWidgets('Enter at the end of a bold word leaves the bold behind', (
    t,
  ) async {
    final entry = await holding(t, 'x **bold|**');
    await keyboard(t, 'x **bold\n|**');
    expect(now(entry), 'x **bold**\n\n|');
  });

  testWidgets(
    'bold with nothing selected: typed text is bold, a space ends it',
    (t) async {
      final entry = await holding(t, 'say |');
      entry.controller.toggleStyle(EmphasisKind.bold);
      // Nothing is written yet.
      expect(entry.text, 'say ');
      expect(entry.controller.isStyleOn(EmphasisKind.bold), isTrue);
      await keyboard(t, 'say h|');
      expect(now(entry), 'say **h|**');
      await keyboard(t, 'say **hi|**');
      expect(now(entry), 'say **hi|**');
      await keyboard(t, 'say **hi |**');
      expect(now(entry), 'say **hi** |');
      await keyboard(t, 'say **hi** x|');
      expect(now(entry), 'say **hi** x|');
      expect(entry.controller.typingStyle, isEmpty);
    },
  );

  testWidgets('a typing style is let go of when the cursor moves away', (
    t,
  ) async {
    final entry = await holding(t, 'one two|');
    entry.controller.toggleStyle(EmphasisKind.bold);
    // `two` is a word: the button acts on it, nothing is pending.
    expect(entry.text, 'one **two**');
    final other = await holding(t, 'one |');
    other.controller.toggleStyle(EmphasisKind.italic);
    expect(other.controller.typingStyle, {EmphasisKind.italic});
    other.controller.selection = const TextSelection.collapsed(offset: 0);
    await t.pump();
    expect(other.controller.typingStyle, isEmpty);
    await keyboard(t, 'X|one ');
    expect(other.text.contains('*'), isFalse);
  });

  testWidgets('a typing style on the button already lit in bold does nothing', (
    t,
  ) async {
    final entry = await holding(t, '**a  b|**');
    entry.controller.selection = const TextSelection.collapsed(offset: 5);
    entry.controller.toggleStyle(EmphasisKind.bold);
    expect(entry.controller.typingStyle, isEmpty);
  });

  testWidgets('undo brings back what a typing style wrote, whole', (t) async {
    final entry = await holding(t, 'say |');
    entry.controller.toggleStyle(EmphasisKind.bold);
    await keyboard(t, 'say h|');
    await keyboard(t, 'say **hi|**');
    expect(entry.text, 'say **hi**');
    entry.undo.undo();
    await t.pump();
    // Whatever undo lands on, it is a text with no lone marks.
    final pairs = EmphasisIndex.of(entry.text).pairs;
    final stars = '*'.allMatches(entry.text).length;
    expect(stars, pairs.length * 4);
  });

  group('a keyboard that types a word as a composing region', () {
    /// What a keyboard sends: [dsl]'s text and cursor, with `_..._` around the
    /// composing word (marked with `{` `}` in [dsl]).
    Future<void> compose(WidgetTester tester, String dsl) async {
      // Take the markers out one at a time, noting where each stood.
      final marks = <String, int>{};
      final text = StringBuffer();
      for (final unit in dsl.split('')) {
        if ('{}|'.contains(unit)) {
          marks[unit] = text.length;
        } else {
          text.write(unit);
        }
      }
      tester.testTextInput.updateEditingValue(
        TextEditingValue(
          text: text.toString(),
          selection: TextSelection.collapsed(offset: marks['|']!),
          composing: TextRange(start: marks['{']!, end: marks['}']!),
        ),
      );
      await tester.pump();
    }

    testWidgets('a word typed at the end of bold text stays in it', (t) async {
      final entry = await holding(t, '**hel|**');
      await compose(t, '**{hell|}**');
      expect(now(entry), '**hell|**');
      await compose(t, '**{hello|}**');
      expect(now(entry), '**hello|**');
      // Committing the word with a space: the space goes after the bold.
      await keyboard(t, '**hello |**');
      expect(now(entry), '**hello** |');
    });

    testWidgets('a bold word typed from the typing style, letter by letter', (
      t,
    ) async {
      final entry = await holding(t, 'say |');
      entry.controller.toggleStyle(EmphasisKind.bold);
      await compose(t, 'say {h|}');
      expect(entry.text, 'say **h**');
      expect(
        entry.controller.value.composing,
        const TextRange(start: 6, end: 7),
      );
      // The keyboard now goes on from the text it was sent back.
      await compose(t, 'say **{he|}**');
      expect(now(entry), 'say **he|**');
      await compose(t, 'say **{hey|}**');
      expect(now(entry), 'say **hey|**');
      await keyboard(t, 'say **hey |**');
      expect(now(entry), 'say **hey** |');
      expect(EmphasisIndex.of(entry.text).pairs, hasLength(1));
    });

    testWidgets('deleting a composing letter inside bold text', (t) async {
      final entry = await holding(t, '**hel|**');
      await compose(t, '**{he|}**');
      expect(now(entry), '**he|**');
    });

    testWidgets('an autocorrect that replaces the word inside bold', (t) async {
      final entry = await holding(t, 'a **teh|** b');
      await compose(t, 'a **{the|}** b');
      expect(now(entry), 'a **the|** b');
      expect(EmphasisIndex.of(entry.text).pairs, hasLength(1));
    });

    testWidgets('composing next to the marks never leaves a lone star', (
      t,
    ) async {
      final entry = await holding(t, 'a **b**|');
      await compose(t, 'a **b**{c|}');
      expect(now(entry), 'a **b**c|');
      await compose(t, 'a **b**{cd|}');
      expect('*'.allMatches(entry.text).length, 4);
    });
  });

  group('the toolbar', () {
    Future<StudioTextEntry> pumpToolbar(WidgetTester tester, String dsl) async {
      final value = v(dsl);
      final entry = StudioTextEntry(value.text);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTomezaLightTheme(),
          home: Scaffold(
            body: Column(
              children: [
                Expanded(
                  child: Builder(
                    builder: (context) => StudioTextField(
                      entry: entry,
                      style: studioBodyStyle(context),
                    ),
                  ),
                ),
                StudioToolbar(entry: entry, onPicture: (_, _) {}),
              ],
            ),
          ),
        ),
      );
      entry.focusNode.requestFocus();
      await tester.pump();
      entry.controller.selection = value.selection;
      await tester.pump();
      return entry;
    }

    bool lit(WidgetTester tester, String tooltip) => tester
        .widget<IconButton>(
          find
              .ancestor(
                of: find.byTooltip(tooltip),
                matching: find.byType(IconButton),
              )
              .first,
        )
        .isSelected!;

    testWidgets('Bold on a selection makes it bold and lights the button', (
      tester,
    ) async {
      final entry = await pumpToolbar(tester, 'The <old> house');
      expect(lit(tester, 'Bold'), isFalse);
      await tester.tap(find.byTooltip('Bold'));
      await tester.pump();
      expect(now(entry), 'The **<old>** house');
      expect(lit(tester, 'Bold'), isTrue);
      expect(lit(tester, 'Italic'), isFalse);
      await tester.tap(find.byTooltip('Bold'));
      await tester.pump();
      expect(now(entry), 'The <old> house');
      expect(lit(tester, 'Bold'), isFalse);
    });

    testWidgets(
      'Bold with the cursor between words lights it and writes nothing',
      (tester) async {
        final entry = await pumpToolbar(tester, 'one | two');
        await tester.tap(find.byTooltip('Bold'));
        await tester.pump();
        expect(entry.text, 'one  two');
        expect(lit(tester, 'Bold'), isTrue);
        await tester.tap(find.byTooltip('Bold'));
        await tester.pump();
        expect(lit(tester, 'Bold'), isFalse);
      },
    );

    testWidgets(
      'the button is lit with the cursor in a bold word, not after it',
      (tester) async {
        final entry = await pumpToolbar(tester, 'a **bo|ld** b');
        expect(lit(tester, 'Bold'), isTrue);
        entry.controller.selection = const TextSelection.collapsed(offset: 10);
        await tester.pump();
        expect(lit(tester, 'Bold'), isFalse);
      },
    );
  });
}
