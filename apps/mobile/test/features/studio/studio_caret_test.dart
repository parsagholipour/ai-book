import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';
import 'package:tomeza/features/studio/presentation/studio_editor.dart';

import '../../support/screen_preview.dart';

/// Where the caret is drawn against the lines it is on.
///
/// The field puts the caret by a strut and a "standard line", and a blank line
/// (a paragraph break) is half height, so the arithmetic was wrong for it: the
/// caret sat low on text lines and above the line after a paragraph break.
/// These check the caret against the real layout, in the real font.

class CaretLines {
  CaretLines(this.tops, this.bottom);

  final List<double> tops;
  final double bottom;

  double top(int line) => tops[line];
  double end(int line) => line + 1 < tops.length ? tops[line + 1] : bottom;
}

class CaretField {
  CaretField(this.entry, this.render, this.lines);

  final StudioTextEntry entry;
  final RenderEditable render;
  final CaretLines lines;

  Rect caretAt(int offset) =>
      render.getLocalRectForCaret(TextPosition(offset: offset));
}

Future<CaretField> pump(
  WidgetTester tester,
  String text, {
  double textScale = 1,
  String? hint,
}) async {
  await tester.runAsync(loadPreviewFonts);
  final entry = StudioTextEntry(text);
  await tester.pumpWidget(
    previewApp(
      Scaffold(
        body: Builder(
          builder: (context) => Padding(
            padding: const EdgeInsets.all(22),
            child: StudioTextField(
              entry: entry,
              style: studioBodyStyle(context),
              hint: hint,
            ),
          ),
        ),
      ),
      textScale: textScale,
    ),
  );
  entry.focusNode.requestFocus();
  await tester.pump();
  final state = tester.state<EditableTextState>(find.byType(EditableText));
  final render = state.renderEditable;
  final painter = TextPainter(
    text: entry.controller.buildTextSpan(
      context: tester.element(find.byType(EditableText)),
      style: state.widget.style,
      withComposing: false,
    ),
    textDirection: TextDirection.ltr,
    textScaler: TextScaler.linear(textScale),
    strutStyle: state.widget.strutStyle,
  )..layout(maxWidth: render.size.width);
  final tops = <double>[];
  var y = 0.0;
  for (final line in painter.computeLineMetrics()) {
    tops.add(y);
    y += line.height;
  }
  return CaretField(entry, render, CaretLines(tops, y));
}

Future<void> caretTo(WidgetTester tester, CaretField field, int offset) async {
  field.entry.controller.selection = TextSelection.collapsed(offset: offset);
  await tester.pump();
}

const _text =
    'First line here.\n\nSecond **bold** and *soft* line.\n\nThird.\n\n';

void main() {
  for (final scale in [1.0, 1.5]) {
    group('at text scale $scale', () {
      testWidgets('on a line of text the caret is centred on the line', (
        tester,
      ) async {
        final field = await pump(tester, _text, textScale: scale);
        final starts = <int>[0];
        for (var i = 0; i < _text.length; i++) {
          if (_text[i] == '\n') starts.add(i + 1);
        }
        for (final line in [0, 2, 4]) {
          // Start, middle, and end of the line, on both sides of hidden marks.
          final end = _text.indexOf('\n', starts[line]);
          for (final offset in {starts[line], (starts[line] + end) ~/ 2, end}) {
            await caretTo(tester, field, offset);
            final caret = field.caretAt(offset);
            final top = field.lines.top(line);
            final bottom = field.lines.end(line);
            expect(
              caret.center.dy,
              closeTo((top + bottom) / 2, 1),
              reason: 'line $line offset $offset',
            );
            expect(caret.top, greaterThanOrEqualTo(top - 0.5));
            expect(caret.bottom, lessThanOrEqualTo(bottom + 0.5));
          }
        }
      });

      testWidgets('on a blank line it fits the line', (tester) async {
        final field = await pump(tester, _text, textScale: scale);
        for (final (line, offset) in [(1, 17), (3, 51)]) {
          await caretTo(tester, field, offset);
          final caret = field.caretAt(offset);
          expect(caret.top, greaterThanOrEqualTo(field.lines.top(line) - 0.5));
          expect(caret.bottom, lessThanOrEqualTo(field.lines.end(line) + 0.5));
        }
      });

      testWidgets('after a paragraph break it is on the new line, not above', (
        tester,
      ) async {
        final field = await pump(tester, _text, textScale: scale);
        final last = field.lines.tops.length - 1;
        await caretTo(tester, field, _text.length);
        final caret = field.caretAt(_text.length);
        // The new line, and not the paragraph before it (which was the bug).
        expect(caret.top, greaterThanOrEqualTo(field.lines.top(last) - 0.5));
        expect(caret.center.dy, greaterThan(field.lines.top(last)));
        expect(caret.bottom, lessThanOrEqualTo(field.lines.end(last) + 0.5));
        // Below the paragraph's text, whose line ends where the gap begins.
        expect(caret.top, greaterThan(field.lines.end(4) - 1));
      });

      testWidgets('in an empty chapter it is centred on the first line', (
        tester,
      ) async {
        final field = await pump(
          tester,
          '',
          textScale: scale,
          hint: 'Start writing…',
        );
        final caret = field.caretAt(0);
        // The field is as tall as its hint; the editable inside it is shorter
        // and sits in it, so compare where things are on screen.
        final box = tester.getRect(find.byType(TextField));
        final top = field.render.localToGlobal(caret.topLeft).dy;
        final bottom = field.render.localToGlobal(caret.bottomLeft).dy;
        expect((top + bottom) / 2, closeTo(box.center.dy, 1.5));
        expect(top, greaterThanOrEqualTo(box.top - 0.5));
        expect(bottom, lessThanOrEqualTo(box.bottom + 0.5));
      });
    });
  }

  testWidgets('the caret is short on a blank line and full on a text line', (
    tester,
  ) async {
    final field = await pump(tester, _text);
    await caretTo(tester, field, 5);
    final onText = field.caretAt(5).height;
    await caretTo(tester, field, 17);
    final onBlank = field.caretAt(17).height;
    expect(onBlank, lessThan(onText * 0.7));
    // Back on text, full height again.
    await caretTo(tester, field, 5);
    expect(field.caretAt(5).height, onText);
  });

  testWidgets('a hidden mark does not move the caret sideways or up or down', (
    tester,
  ) async {
    final field = await pump(tester, 'Say **bold** now.');
    // Before the marks, inside them and after them: offsets 4 (before `**`),
    // 6 (after it) and 10 (before the closing `**`), all on one line.
    final tops = <double>{};
    for (final offset in [3, 4, 6, 8, 10, 12, 13]) {
      await caretTo(tester, field, offset);
      final caret = field.caretAt(offset);
      tops.add(caret.top);
      expect(caret.height, greaterThan(0));
    }
    expect(tops, hasLength(1));
  });
}
