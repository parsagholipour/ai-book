import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/presentation/studio_editor.dart';
import '../../support/screen_preview.dart';

/// A throwaway controller that hides every `*` by size.
class _Hide extends TextEditingController {
  _Hide(this.size, {super.text});
  final double size;
  @override
  TextSpan buildTextSpan({required BuildContext context, TextStyle? style, required bool withComposing}) {
    final spans = <TextSpan>[];
    final buf = StringBuffer();
    void flush() {
      if (buf.isEmpty) return;
      spans.add(TextSpan(text: buf.toString(), style: style));
      buf.clear();
    }
    var bold = false;
    for (var i = 0; i < text.length; i++) {
      final c = text[i];
      if (c == '*') {
        flush();
        spans.add(TextSpan(text: c, style: style!.copyWith(fontSize: size, letterSpacing: 0, height: 1)));
        bold = !bold;
      } else {
        buf.write(c);
      }
    }
    flush();
    return TextSpan(style: style, children: spans);
  }
}

void main() {
  for (final size in [0.0, 0.01]) {
    testWidgets('hide by size $size', (tester) async {
      await tester.runAsync(loadPreviewFonts);
      final controller = _Hide(size, text: 'Say **bold** now.');
      final focus = FocusNode();
      late TextStyle body;
      await tester.pumpWidget(previewApp(Scaffold(body: Builder(builder: (context) {
        body = studioBodyStyle(context);
        return Padding(padding: const EdgeInsets.all(22), child: TextField(controller: controller, focusNode: focus, style: body, maxLines: null, decoration: const InputDecoration.collapsed(hintText: null)));
      }))));
      focus.requestFocus();
      await tester.pump();
      final render = tester.state<EditableTextState>(find.byType(EditableText)).renderEditable;
      for (var i = 0; i <= controller.text.length; i++) {
        final r = render.getLocalRectForCaret(TextPosition(offset: i));
        // ignore: avoid_print
        print('size $size off $i "${i < controller.text.length ? controller.text[i] : "EOT"}" caret x ${r.left.toStringAsFixed(2)} y ${r.top.toStringAsFixed(1)}..${r.bottom.toStringAsFixed(1)}');
      }
    });
  }
}
