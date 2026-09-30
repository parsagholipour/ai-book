import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/presentation/manuscript_editing_controller.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';
import 'package:tomeza/features/studio/presentation/studio_editor.dart';
import '../../support/screen_preview.dart';

const _text = 'First line here.\n\nSecond line.\n\nThird.\n\n';

void main() {
  testWidgets('caret vs lines', (tester) async {
    await tester.runAsync(loadPreviewFonts);
    final entry = StudioTextEntry(_text);
    late TextStyle body;
    await tester.pumpWidget(
      previewApp(
        Scaffold(
          body: Builder(
            builder: (context) {
              body = studioBodyStyle(context);
              return Padding(
                padding: const EdgeInsets.all(22),
                child: StudioTextField(entry: entry, style: body),
              );
            },
          ),
        ),
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
      strutStyle: state.widget.strutStyle,
    )..layout(maxWidth: render.size.width);
    final tops = <double>[];
    var y = 0.0;
    for (final m in painter.computeLineMetrics()) {
      tops.add(y);
      y += m.height;
    }
    final starts = <int>[0];
    for (var i = 0; i < _text.length; i++) {
      if (_text[i] == '\n') starts.add(i + 1);
    }
    for (var line = 0; line < starts.length; line++) {
      final off = starts[line];
      entry.controller.selection = TextSelection.collapsed(offset: off);
      await tester.pump();
      final r = render.getLocalRectForCaret(TextPosition(offset: off));
      final top = tops[line];
      final bottom = line + 1 < tops.length ? tops[line + 1] : y;
      // ignore: avoid_print
      print(
        'line $line box ${top.toStringAsFixed(1)}..${bottom.toStringAsFixed(1)} h ${(bottom - top).toStringAsFixed(1)}'
        '  caret ${r.top.toStringAsFixed(1)}..${r.bottom.toStringAsFixed(1)}'
        '  rel ${(r.top - top).toStringAsFixed(1)}..${(r.bottom - top).toStringAsFixed(1)}  empty=${caretOnEmptyLine(entry.controller.value)}',
      );
    }
    final caret = ManuscriptCaret.measure(body: Theme.of(tester.element(find.byType(EditableText))).textTheme.bodyLarge!.merge(body), scaler: TextScaler.noScaling, textDirection: TextDirection.ltr);
    // ignore: avoid_print
    print('caret height ${caret.height} shift ${caret.emptyLineShift} preferredLineHeight ${render.preferredLineHeight}');
  });
}
