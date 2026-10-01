/// The Studio toolbar's formatting, as pure functions of a text field's value.
///
/// Each takes the text and selection a field holds and returns the text and
/// selection it should hold next. None of them reads a widget, so the toolbar,
/// the keyboard shortcuts and the tests all go through the same code. The
/// markdown they write is the markdown the book already speaks: `**bold**`,
/// `*italic*`, `## ` headings, `> ` quotes, `- ` lists and a `***` scene break.
library;

import 'package:flutter/services.dart';

import 'manuscript_emphasis.dart';
import 'manuscript_inline.dart' show EmphasisKind;

/// Bold: wraps the selection (or the word under the cursor) in `**`, or
/// removes the `**` already around it. See [toggleEmphasis].
TextEditingValue toggleBold(TextEditingValue value) =>
    toggleEmphasis(value, EmphasisKind.bold);

/// Italic: wraps the selection (or the word under the cursor) in `*`, or
/// removes the `*` already around it. Leaves bold alone: `**word**` becomes
/// `***word***`, and `***word***` goes back to `**word**`.
TextEditingValue toggleItalic(TextEditingValue value) =>
    toggleEmphasis(value, EmphasisKind.italic);

/// Cycles the current line's heading: none → `## ` → `### ` → none. A `# `
/// line moves on to `## ` like a plain one.
TextEditingValue cycleHeading(TextEditingValue value) {
  final text = value.text;
  final selection = _validSelection(value);
  final lineStart = _lineStart(text, selection.start);
  final lineEnd = _lineEnd(text, lineStart);
  final line = text.substring(lineStart, lineEnd);
  final match = RegExp(r'^(#{1,6})[ \t]+').firstMatch(line);
  final level = match == null ? 0 : match.group(1)!.length;
  final oldPrefix = match?.group(0) ?? '';
  final newPrefix = switch (level) {
    0 || 1 => '## ',
    2 => '### ',
    _ => '',
  };
  return _replacePrefix(value, lineStart, oldPrefix.length, newPrefix);
}

/// Turns the selected lines into a quote (`> `), or back into prose when
/// every one of them already is.
TextEditingValue toggleQuote(TextEditingValue value) =>
    _toggleLinePrefix(value, RegExp(r'^[ \t]{0,3}>[ \t]?'), '> ');

/// Turns the selected lines into a bulleted list (`- `), or back into prose
/// when every one of them already is a list item (bulleted or numbered).
TextEditingValue toggleList(TextEditingValue value) =>
    _toggleLinePrefix(value, RegExp(r'^[ \t]*(?:[-*+]|\d+[.)])[ \t]+'), '- ');

/// Puts a scene break (`***`, a paragraph of its own) at the cursor, replacing
/// any selection, and leaves the cursor at the start of the next paragraph.
TextEditingValue insertSceneBreak(TextEditingValue value) {
  final text = value.text;
  final selection = _validSelection(value);
  final before = text.substring(0, selection.start);
  final after = text.substring(selection.end);
  final lead = before.trim().isEmpty
      ? ''
      : before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
      ? '\n'
      : '\n\n';
  final trail = after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
      ? '\n'
      : '\n\n';
  final head = '${before.trim().isEmpty ? '' : before}$lead***$trail';
  final cursor = after.startsWith('\n\n') ? head.length + 2 : head.length;
  return TextEditingValue(
    text: '$head$after',
    selection: TextSelection.collapsed(offset: cursor),
  );
}

TextEditingValue _toggleLinePrefix(
  TextEditingValue value,
  RegExp existing,
  String prefix,
) {
  final text = value.text;
  final selection = _validSelection(value);
  final firstStart = _lineStart(text, selection.start);
  // A selection that ends at the very start of a line does not include it.
  final lastAnchor =
      selection.end > selection.start &&
          selection.end > 0 &&
          text.codeUnitAt(selection.end - 1) == 0x0a
      ? selection.end - 1
      : selection.end;
  final lastStart = _lineStart(text, lastAnchor);

  final starts = <int>[];
  var cursor = firstStart;
  while (true) {
    starts.add(cursor);
    if (cursor >= lastStart) break;
    final next = text.indexOf('\n', cursor);
    if (next < 0) break;
    cursor = next + 1;
  }
  final lines = [
    for (final start in starts) text.substring(start, _lineEnd(text, start)),
  ];
  final contentful = [
    for (final line in lines)
      if (line.trim().isNotEmpty) line,
  ];
  final removing =
      contentful.isNotEmpty &&
      contentful.every((line) => existing.hasMatch(line));

  var newText = text;
  var baseOffset = selection.baseOffset;
  var extentOffset = selection.extentOffset;
  // From the last line up, so earlier offsets stay valid.
  for (var i = starts.length - 1; i >= 0; i--) {
    final start = starts[i];
    final line = lines[i];
    if (line.trim().isEmpty && lines.length > 1) continue;
    final old = existing.firstMatch(line)?.group(0) ?? '';
    final String replacement;
    final int removeLength;
    if (removing) {
      replacement = '';
      removeLength = old.length;
    } else if (old.isNotEmpty) {
      // Some lines already carry the prefix and some do not: the ones that
      // do are normalized rather than doubled.
      replacement = prefix;
      removeLength = old.length;
    } else {
      replacement = prefix;
      removeLength = 0;
    }
    newText = newText.replaceRange(start, start + removeLength, replacement);
    final delta = replacement.length - removeLength;
    int move(int offset) {
      if (offset < start) return offset;
      if (offset < start + removeLength) return start + replacement.length;
      return offset + delta;
    }

    baseOffset = move(baseOffset);
    extentOffset = move(extentOffset);
  }
  return TextEditingValue(
    text: newText,
    selection: TextSelection(
      baseOffset: baseOffset,
      extentOffset: extentOffset,
    ),
  );
}

TextEditingValue _replacePrefix(
  TextEditingValue value,
  int lineStart,
  int oldLength,
  String prefix,
) {
  final text = value.text.replaceRange(
    lineStart,
    lineStart + oldLength,
    prefix,
  );
  final delta = prefix.length - oldLength;
  final selection = _validSelection(value);
  int move(int offset) {
    if (offset < lineStart) return offset;
    if (offset < lineStart + oldLength) return lineStart + prefix.length;
    return offset + delta;
  }

  return TextEditingValue(
    text: text,
    selection: TextSelection(
      baseOffset: move(selection.baseOffset),
      extentOffset: move(selection.extentOffset),
    ),
  );
}

TextSelection _validSelection(TextEditingValue value) {
  final selection = value.selection;
  if (selection.isValid) {
    final length = value.text.length;
    return TextSelection(
      baseOffset: selection.baseOffset.clamp(0, length),
      extentOffset: selection.extentOffset.clamp(0, length),
    );
  }
  return TextSelection.collapsed(offset: value.text.length);
}

int _lineStart(String text, int offset) {
  if (offset <= 0) return 0;
  final previous = text.lastIndexOf('\n', offset - 1);
  return previous < 0 ? 0 : previous + 1;
}

int _lineEnd(String text, int lineStart) {
  final next = text.indexOf('\n', lineStart);
  return next < 0 ? text.length : next;
}

/// What pressing Enter means in a book.
///
/// The compile renders markdown with soft line breaks: two lines with no
/// blank line between them print as one paragraph. An author who presses
/// Enter once expects a new paragraph, so this turns a typed single newline
/// into a paragraph break — the editor draws the blank line as a short gap,
/// which is how a paragraph looks anyway. Inside a list the next item is
/// started instead (an empty item ends the list), and inside a code fence, on
/// a blank line, or at the very start, a newline stays a newline.
///
/// Only a single typed newline with a collapsed selection is touched; pastes,
/// IME composition and programmatic edits pass through unchanged.
class ManuscriptEnterFormatter extends TextInputFormatter {
  const ManuscriptEnterFormatter();

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final old = oldValue.selection;
    if (!old.isValid || !old.isCollapsed) return newValue;
    if (newValue.composing.isValid && !newValue.composing.isCollapsed) {
      return newValue;
    }
    if (newValue.text.length != oldValue.text.length + 1) return newValue;
    final at = old.start;
    if (at > oldValue.text.length ||
        newValue.text.codeUnitAt(at) != 0x0a ||
        newValue.text.substring(0, at) != oldValue.text.substring(0, at) ||
        newValue.text.substring(at + 1) != oldValue.text.substring(at)) {
      return newValue;
    }
    return paragraphBreakAt(oldValue.text, at) ?? newValue;
  }
}

final _listItem = RegExp(r'^([ \t]*)([-*+]|(\d+)([.)]))([ \t]+)(.*)$');

/// The value Enter at [offset] should produce, or null for a plain newline.
TextEditingValue? paragraphBreakAt(String text, int offset) {
  if (_insideFence(text, offset)) return null;
  final lineStart = _lineStart(text, offset);
  final lineEnd = _lineEnd(text, lineStart);
  final line = text.substring(lineStart, lineEnd);
  final item = _listItem.firstMatch(line);
  if (item != null &&
      offset >= lineStart + line.length - item.group(6)!.length) {
    if (item.group(6)!.trim().isEmpty) {
      // Enter on an empty item ends the list: the marker goes, and a blank
      // line goes between the list and what is written next. A line straight
      // under an item is that item's lazy continuation in markdown, so the
      // next paragraph printed as part of the last item.
      final afterList = lineStart >= 2 && text.codeUnitAt(lineStart - 2) != 0x0a
          ? '\n'
          : '';
      final cleared = text.replaceRange(lineStart, lineEnd, afterList);
      return TextEditingValue(
        text: cleared,
        selection: TextSelection.collapsed(
          offset: lineStart + afterList.length,
        ),
      );
    }
    final number = item.group(3);
    final marker = number == null
        ? item.group(2)!
        : '${int.parse(number) + 1}${item.group(4)}';
    final insert = '\n${item.group(1)}$marker${item.group(5)}';
    return TextEditingValue(
      text: text.replaceRange(offset, offset, insert),
      selection: TextSelection.collapsed(offset: offset + insert.length),
    );
  }
  if (offset == 0 || text.codeUnitAt(offset - 1) == 0x0a) return null;
  if (line.trim().isEmpty) return null;
  return TextEditingValue(
    text: text.replaceRange(offset, offset, '\n\n'),
    selection: TextSelection.collapsed(offset: offset + 2),
  );
}

final _fenceMarker = RegExp(r'^\s{0,3}(```|~~~)');

bool _insideFence(String text, int offset) {
  String? fence;
  var start = 0;
  while (start <= offset && start <= text.length) {
    final end = _lineEnd(text, start);
    if (end >= offset && start <= offset) {
      // The line being edited: a fence line itself counts as inside once
      // opened, so Enter after "```js" stays a plain newline.
      final match = _fenceMarker.firstMatch(text.substring(start, end));
      return fence != null || match != null;
    }
    final match = _fenceMarker.firstMatch(text.substring(start, end));
    if (match != null) {
      if (fence == null) {
        fence = match.group(1);
      } else if (match.group(1) == fence) {
        fence = null;
      }
    }
    start = end + 1;
  }
  return fence != null;
}
