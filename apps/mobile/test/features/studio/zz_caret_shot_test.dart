import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';
import 'package:tomeza/features/studio/presentation/studio_editor.dart';
import '../../support/screen_preview.dart';

const _text = 'First line here, a little longer so it is real prose.\n\nSecond **bold** and *soft* line.\n\nThird.\n\n';

Future<void> shot(WidgetTester tester, String name, String text, int? offset) async {
  final entry = StudioTextEntry(text);
  await previewScreen(
    tester,
    name: name,
    size: const Size(390, 260),
    pixelRatio: 3,
    settle: false,
    app: previewApp(
      Scaffold(
        body: Builder(
          builder: (context) => Padding(
            padding: const EdgeInsets.all(22),
            child: StudioTextField(entry: entry, style: studioBodyStyle(context), hint: 'Start writing…'),
          ),
        ),
      ),
    ),
    beforeShot: () async {
      entry.focusNode.requestFocus();
      await tester.pump();
      entry.controller.selection = TextSelection.collapsed(offset: offset ?? text.length);
      await tester.pump(const Duration(milliseconds: 50));
    },
  );
}

void main() {
  testWidgets('a', (t) => shot(t, 'caret2_a_mid', _text, 20));
  testWidgets('b', (t) => shot(t, 'caret2_b_lineend', _text, 84));
  testWidgets('c', (t) => shot(t, 'caret2_c_eot', _text, null));
  testWidgets('d', (t) => shot(t, 'caret2_d_empty', '', null));
}
