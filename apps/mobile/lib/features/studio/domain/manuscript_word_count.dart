/// Word counting for the Studio's live counters.
///
/// The server's `manuscriptWordCount` (packages/core/src/authoring/
/// manuscriptText.ts) is the authority — it is what the outline, the book page
/// and the publish checklist show. This mirrors it closely enough that the
/// number under the editor does not jump when a save comes back: prose only
/// (no fences, picture lines or page separators), inline markup stripped, and
/// the same token rule, with CJK characters counted two to a word and
/// unsegmented scripts (Thai, Lao, Khmer, Myanmar) four to a word.
library;

import 'manuscript_blocks.dart';

final _fence = RegExp(r'^\s{0,3}(```|~~~)');
final _imageLine = RegExp(r'^\s*!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)\s*$');
final _separator = RegExp(r'^\s*<!--\s*page\s*-->\s*$', caseSensitive: false);
final _token = RegExp(
  r"[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*",
  unicode: true,
);
final _mark = RegExp(r'\p{M}', unicode: true);
// Marks are skipped before a character is classified, as on the server, so
// a Thai vowel sign is neither a mark twice nor a letter.
final _cjk = RegExp(
  r'(?!\p{M})[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}'
  r'\p{Script=Hangul}]',
  unicode: true,
);
final _unsegmented = RegExp(
  r'(?!\p{M})[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}'
  r'\p{Script=Myanmar}]',
  unicode: true,
);

/// Words the author wrote in [markdown].
int manuscriptWordCount(String markdown) {
  if (markdown.isEmpty) return 0;
  final prose = StringBuffer();
  String? fence;
  for (final line in markdown.split('\n')) {
    final match = _fence.firstMatch(line);
    if (fence != null) {
      if (match != null && match.group(1) == fence) fence = null;
      continue;
    }
    if (match != null) {
      fence = match.group(1);
      continue;
    }
    if (_imageLine.hasMatch(line) || _separator.hasMatch(line)) continue;
    prose.writeln(line);
  }
  return countReadableWords(_stripInline(prose.toString()));
}

/// Words across a list of blocks; only text blocks carry any.
int manuscriptBlocksWordCount(Iterable<ManuscriptBlock> blocks) {
  var total = 0;
  for (final block in blocks) {
    if (block is TextBlock) total += manuscriptWordCount(block.text);
  }
  return total;
}

/// The token rule `countReadableWords` in packages/core uses.
///
/// Runs on every keystroke for the text block being edited, so the common
/// cases are answered without a per-character regex: an ASCII token, and a
/// token with no CJK or unsegmented character, are one word each.
int countReadableWords(String text) {
  var count = 0;
  for (final match in _token.allMatches(text)) {
    final token = match.group(0)!;
    if (_isAscii(token) || !_segmented.hasMatch(token)) {
      count++;
      continue;
    }
    final cjk = _cjk.allMatches(token).length;
    final unsegmented = _unsegmented.allMatches(token).length;
    final marks = _mark.allMatches(token).length;
    final spaced = token.runes.length - cjk - unsegmented - marks;
    count += (cjk + 1) ~/ 2 + (unsegmented + 3) ~/ 4;
    if (spaced > 0) count++;
  }
  return count;
}

final _segmented = RegExp(
  r'[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}'
  r'\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]',
  unicode: true,
);

bool _isAscii(String token) {
  for (var i = 0; i < token.length; i++) {
    if (token.codeUnitAt(i) > 0x7f) return false;
  }
  return true;
}

String _stripInline(String text) => text
    .replaceAll(RegExp(r'^\s{0,3}#{1,6}\s+', multiLine: true), '')
    .replaceAll(RegExp(r'^\s{0,3}>\s?', multiLine: true), '')
    .replaceAll(RegExp(r'^\s*(?:[-*+]|\d+[.)])\s+', multiLine: true), '')
    .replaceAllMapped(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), (m) => m.group(1)!)
    .replaceAllMapped(RegExp(r'\[([^\]]*)\]\([^)]*\)'), (m) => m.group(1)!)
    .replaceAll(RegExp(r'(\*\*|__|\*|_|~~|`)'), '');

/// "1,248" — a count grouped in threes, the way the rest of the app writes
/// counts in English copy.
String formatStudioCount(int value) {
  final negative = value < 0;
  final digits = value.abs().toString();
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
    buffer.write(digits[i]);
  }
  return negative ? '−$buffer' : buffer.toString();
}

/// "1 word" / "1,248 words".
String formatStudioWords(int value) =>
    '${formatStudioCount(value)} ${value == 1 ? 'word' : 'words'}';
