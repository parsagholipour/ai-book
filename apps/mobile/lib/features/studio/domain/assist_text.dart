/// The writing assistant's text side: what a request carries from around the
/// author's selection or cursor, and how an accepted suggestion goes back into
/// the text.
///
/// Pure functions of strings and text-field values, so the sheet, the screen
/// and the tests all go through the same code. The insertion rules are the
/// server's (`.scratch/writing-studio/spec.md`, "As implemented"): a
/// continuation carries its own leading separator and is inserted verbatim; a
/// rewrite or a description keeps the selection's own surrounding whitespace
/// and replaces the selection verbatim; every proofread `find` occurs exactly
/// once in the selection and no two overlap. Nothing here adds a space of its
/// own.
library;

import 'package:flutter/services.dart';

import 'assist_models.dart';

/// Text before the selection or cursor that one request carries.
const assistBeforeChars = 4000;

/// Text after it.
const assistAfterChars = 1500;

/// The longest selection a tool works on.
const assistSelectionChars = 6000;

/// The longest description of a picture.
const illustratePromptChars = 1200;

/// The longest passage a picture illustrates.
const illustratePassageChars = 4000;

/// The text a request carries around the author's selection or cursor.
class AssistWindow {
  const AssistWindow({
    required this.before,
    required this.after,
    required this.start,
    required this.end,
    this.selection,
  });

  /// Up to [assistBeforeChars] of text before [start].
  final String before;

  /// Up to [assistAfterChars] of text after [end].
  final String after;

  /// The selected text, or null for a cursor.
  final String? selection;

  /// The selection (or cursor) in the text field's own offsets.
  final int start;
  final int end;

  bool get hasSelection => selection != null;
}

/// The window for [selection] in [text], one text segment of the chapter.
///
/// A segment is the text between two pictures, so the text right before the
/// cursor can be short; [textBefore] and [textAfter] are the chapter's other
/// segments, in order, and are joined in as paragraphs of their own until the
/// window is full. They are joined with a blank line on the far side of the
/// cursor, so the server never reads the next segment's first word as a word
/// the cursor sits in front of.
AssistWindow assistWindowFor({
  required String text,
  required TextSelection selection,
  List<String> textBefore = const [],
  List<String> textAfter = const [],
}) {
  final start = selection.isValid
      ? selection.start.clamp(0, text.length)
      : text.length;
  final end = selection.isValid
      ? selection.end.clamp(start, text.length)
      : start;
  var before = text.substring(0, start);
  if (before.length < assistBeforeChars) {
    final earlier = textBefore.where((part) => part.trim().isNotEmpty);
    if (earlier.isNotEmpty) before = '${earlier.join('\n\n')}\n\n$before';
  }
  var after = text.substring(end);
  if (after.length < assistAfterChars) {
    final later = textAfter.where((part) => part.trim().isNotEmpty);
    if (later.isNotEmpty) after = '$after\n\n${later.join('\n\n')}';
  }
  return AssistWindow(
    before: clipTail(before, assistBeforeChars),
    after: clipHead(after, assistAfterChars),
    selection: end > start ? text.substring(start, end) : null,
    start: start,
    end: end,
  );
}

/// The first [max] UTF-16 units of [text], never ending inside a surrogate
/// pair.
String clipHead(String text, int max) {
  if (text.length <= max) return text;
  var end = max;
  if (end > 0 && _isHighSurrogate(text.codeUnitAt(end - 1))) end--;
  return text.substring(0, end);
}

/// The last [max] UTF-16 units of [text], never starting inside a surrogate
/// pair.
String clipTail(String text, int max) {
  if (text.length <= max) return text;
  var start = text.length - max;
  if (_isLowSurrogate(text.codeUnitAt(start))) start++;
  return text.substring(start);
}

bool _isHighSurrogate(int unit) => unit >= 0xD800 && unit <= 0xDBFF;
bool _isLowSurrogate(int unit) => unit >= 0xDC00 && unit <= 0xDFFF;

/// Where [expected] is in [text] now: at [start] when it has not moved,
/// otherwise its one occurrence anywhere. Null when it is gone or ambiguous —
/// then nothing can be applied safely.
TextRange? _locate(String text, int start, String expected) {
  final end = start + expected.length;
  if (start >= 0 &&
      end <= text.length &&
      text.substring(start, end) == expected) {
    return TextRange(start: start, end: end);
  }
  if (expected.isEmpty) return null;
  final at = text.indexOf(expected);
  if (at < 0 || text.indexOf(expected, at + 1) >= 0) return null;
  return TextRange(start: at, end: at + expected.length);
}

/// A rewrite or description accepted: [replacement] takes the place of the
/// selection verbatim, and ends up selected so the author sees what changed.
/// Null when the selected text is no longer where it was (or anywhere, once).
TextEditingValue? replaceSelection(
  TextEditingValue value, {
  required int start,
  required String expected,
  required String replacement,
}) {
  final range = _locate(value.text, start, expected);
  if (range == null) return null;
  return TextEditingValue(
    text: value.text.replaceRange(range.start, range.end, replacement),
    selection: TextSelection(
      baseOffset: range.start,
      extentOffset: range.start + replacement.length,
    ),
  );
}

/// A continuation accepted: [insertion] goes in at [offset] verbatim — it
/// carries its own leading space or paragraph break — and the cursor lands
/// after it.
///
/// [textAtRequest] is the segment as it was asked about. When the text has
/// changed since, the insertion follows the words that were before the cursor
/// if they occur once; otherwise it is refused (null) rather than guessed.
TextEditingValue? insertContinuation(
  TextEditingValue value, {
  required int offset,
  required String textAtRequest,
  required String insertion,
}) {
  final text = value.text;
  var at = offset;
  if (text != textAtRequest) {
    final lead = clipTail(
      textAtRequest.substring(0, offset.clamp(0, textAtRequest.length)),
      80,
    );
    if (lead.isEmpty) return null;
    final found = text.indexOf(lead);
    if (found < 0 || text.indexOf(lead, found + 1) >= 0) return null;
    at = found + lead.length;
  }
  if (at < 0 || at > text.length) return null;
  final cursor = at + insertion.length;
  return TextEditingValue(
    text: text.replaceRange(at, at, insertion),
    selection: TextSelection.collapsed(offset: cursor),
  );
}

/// Proofreading accepted: each of [corrections] is applied to its one
/// occurrence inside the selection, right to left so every earlier offset
/// stays valid. A correction whose `find` is missing or not unique in the
/// selection, or that overlaps one already placed, is skipped. The corrected
/// passage ends up selected. Null when the selection itself is gone.
TextEditingValue? applyCorrections(
  TextEditingValue value, {
  required int start,
  required String expected,
  required List<AssistCorrection> corrections,
}) {
  final range = _locate(value.text, start, expected);
  if (range == null) return null;
  final placed = placeCorrections(expected, corrections);
  var text = value.text;
  var end = range.end;
  for (final placement in placed.reversed) {
    final from = range.start + placement.start;
    final to = from + placement.correction.find.length;
    text = text.replaceRange(from, to, placement.correction.replace);
    end += placement.correction.replace.length - (to - from);
  }
  return TextEditingValue(
    text: text,
    selection: TextSelection(baseOffset: range.start, extentOffset: end),
  );
}

/// One correction and where its `find` starts inside the selection.
class CorrectionPlacement {
  const CorrectionPlacement(this.correction, this.start);

  final AssistCorrection correction;
  final int start;

  int get end => start + correction.find.length;
}

/// Where each correction applies in [selection], in text order. A `find`
/// that is empty, missing, occurs more than once, or overlaps an earlier
/// placement is left out.
List<CorrectionPlacement> placeCorrections(
  String selection,
  List<AssistCorrection> corrections,
) {
  final found = <CorrectionPlacement>[];
  for (final correction in corrections) {
    final find = correction.find;
    if (find.isEmpty) continue;
    final at = selection.indexOf(find);
    if (at < 0 || selection.indexOf(find, at + 1) >= 0) continue;
    found.add(CorrectionPlacement(correction, at));
  }
  found.sort((a, b) => a.start.compareTo(b.start));
  final kept = <CorrectionPlacement>[];
  for (final placement in found) {
    if (kept.isNotEmpty && placement.start < kept.last.end) continue;
    kept.add(placement);
  }
  return kept;
}

final _blankLine = RegExp(r'\n[ \t]*\n');

/// Where a picture goes to follow the paragraph holding [offset]: the start
/// of the blank line that ends that paragraph, or the end of the text.
int paragraphEndAt(String text, int offset) {
  final from = offset.clamp(0, text.length);
  final match = _blankLine.firstMatch(text.substring(from));
  return match == null ? text.length : from + match.start;
}

/// The paragraph holding [offset], trimmed.
String paragraphAt(String text, int offset) {
  final at = offset.clamp(0, text.length);
  var start = 0;
  for (final match in _blankLine.allMatches(text)) {
    if (match.end > at) break;
    start = match.end;
  }
  return text.substring(start, paragraphEndAt(text, at)).trim();
}

final _imageMarkdown = RegExp(r'!\[[^\]]*\]\([^)]*\)');
final _lineMarks = RegExp(
  r'^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)',
  multiLine: true,
);
final _emphasis = RegExp(r'(\*{1,3}|_{1,3})(?=\S)(.+?)(?<=\S)\1');

/// Markdown made readable as a sentence: pictures dropped, heading, quote and
/// list marks and emphasis stars taken off, runs of whitespace closed up.
String plainAssistText(String markdown) => markdown
    .replaceAll(_imageMarkdown, '')
    .replaceAll(_lineMarks, '')
    .replaceAllMapped(_emphasis, (match) => match.group(2)!)
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

/// What a new picture's description starts as: the passage in plain words,
/// clipped to [illustratePromptChars] at a word where it can be.
String illustratePromptFrom(String passage) {
  final plain = plainAssistText(passage);
  if (plain.length <= illustratePromptChars) return plain;
  final clipped = clipHead(plain, illustratePromptChars);
  final space = clipped.lastIndexOf(' ');
  return (space > illustratePromptChars * 0.6
          ? clipped.substring(0, space)
          : clipped)
      .trim();
}

/// The passage a picture illustrates, clipped to [illustratePassageChars].
String illustratePassageFrom(String passage) =>
    clipHead(passage.trim(), illustratePassageChars);
