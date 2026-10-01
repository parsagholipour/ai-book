import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/theme/app_theme.dart';
import 'package:tomeza/features/studio/domain/manuscript_emphasis.dart';
import 'package:tomeza/features/studio/domain/manuscript_inline.dart';
import 'package:tomeza/features/studio/presentation/studio_document.dart';
import 'package:tomeza/features/studio/presentation/studio_editor.dart';

/// Bold phrases typed the way an Android keyboard delivers them.
///
/// The engine keeps its own copy of the text, which the keyboard edits:
/// `setComposingText` per letter of a word, `commitText` when a space ends it.
/// Each edit is sent to the framework, and the framework's answer — which the
/// formatters may have rewritten, moving hidden marks — reaches that copy only
/// later. `adb shell input text` types faster than that round trip, so the
/// next edit is made on the copy the rewrite has not reached yet. [syncEvery]
/// is how many edits go out before the copy catches up: 1 is a person typing,
/// 2 is adb, 3 a keyboard two edits behind.
class FakeAndroidKeyboard {
  FakeAndroidKeyboard(this.tester, this.entry, {this.syncEvery = 1})
    : editable = entry.controller.value;

  final WidgetTester tester;
  final StudioTextEntry entry;
  final int syncEvery;

  /// The engine's copy of the text.
  TextEditingValue editable;
  int _unsynced = 0;

  /// The framework's last answer reaches the engine's copy.
  void sync() {
    editable = entry.controller.value;
    _unsynced = 0;
  }

  Future<void> _send(TextEditingValue next) async {
    editable = next;
    tester.testTextInput.updateEditingValue(next);
    await tester.pump();

    if (++_unsynced >= syncEvery) sync();
  }

  TextRange get _target {
    final composing = editable.composing;
    if (composing.isValid && !composing.isCollapsed) return composing;
    final selection = editable.selection;
    return TextRange(start: selection.start, end: selection.end);
  }

  Future<void> _replace(String text, {required bool composing}) {
    final target = _target;
    return _send(
      TextEditingValue(
        text: editable.text.replaceRange(target.start, target.end, text),
        selection: TextSelection.collapsed(offset: target.start + text.length),
        composing: composing
            ? TextRange(start: target.start, end: target.start + text.length)
            : TextRange.empty,
      ),
    );
  }

  Future<void> setComposingText(String text) => _replace(text, composing: true);

  Future<void> commitText(String text) => _replace(text, composing: false);

  Future<void> finishComposingText() =>
      _send(editable.copyWith(composing: TextRange.empty));

  /// A word composed a letter at a time and committed with [then].
  Future<void> word(String word, {String then = ' '}) async {
    for (var i = 1; i <= word.length; i++) {
      await setComposingText(word.substring(0, i));
    }
    if (then.isNotEmpty) await commitText('$word$then');
  }
}

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
  entry.controller.selection = TextSelection.collapsed(offset: text.length);
  await tester.pump();
  return entry;
}

void main() {
  for (final (name, syncEvery) in [
    ('a person', 1),
    ('adb', 2),
    ('a keyboard two edits behind', 3),
  ]) {
    group('typed by $name', () {
      testWidgets('the phone sequence: a list, Enter twice, a bold phrase', (
        t,
      ) async {
        final entry = await pumpField(t, '- The market\n- **Your** first cry');
        final ime = FakeAndroidKeyboard(t, entry, syncEvery: syncEvery);
        await ime.commitText('\n');
        await ime.commitText('\n');
        ime.sync();
        entry.controller.toggleStyle(EmphasisKind.bold);
        await t.pump();
        ime.sync();
        await ime.word('She');
        await ime.word('smiled');
        // A one-letter word committed, then a new composing word after it.
        await ime.setComposingText('a');
        await ime.finishComposingText();
        await ime.word('t');
        await ime.word('everyone', then: '');
        ime.sync();
        entry.controller.toggleStyle(EmphasisKind.bold);
        await t.pump();
        ime.sync();
        await ime.commitText(' ');
        await ime.word('that');
        await ime.word('night', then: '.');
        expect(
          entry.text,
          '- The market\n- **Your** first cry\n\n'
          '**She smiled at everyone** that night.',
        );
      });

      testWidgets('a bold phrase of one-letter words', (t) async {
        final entry = await pumpField(t, 'Say ');
        final ime = FakeAndroidKeyboard(t, entry, syncEvery: syncEvery);
        entry.controller.toggleStyle(EmphasisKind.bold);
        await t.pump();
        ime.sync();
        for (final letter in ['I', 'a', 'm', 'a', 'cat']) {
          await ime.word(letter);
        }
        expect(entry.text, 'Say **I a m a cat** ');
        expect(EmphasisIndex.of(entry.text).pairs, hasLength(1));
      });

      testWidgets('letters sent as keys, one commit each', (t) async {
        final entry = await pumpField(t, 'Say ');
        final ime = FakeAndroidKeyboard(t, entry, syncEvery: syncEvery);
        entry.controller.toggleStyle(EmphasisKind.bold);
        await t.pump();
        ime.sync();
        for (final key in 'go on, then'.split('')) {
          await ime.commitText(key);
        }
        expect(entry.text, 'Say **go on, then**');
      });
    });
  }
}
