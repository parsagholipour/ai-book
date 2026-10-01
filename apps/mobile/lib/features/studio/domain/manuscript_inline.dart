/// What a line of a chapter's markdown is made of, before any styling.
///
/// The editor draws markdown as it will read in the book and, for bold and
/// italic, hides the marks themselves; the editing rules that keep those hidden
/// marks from being broken by a cursor or a key press need to know exactly
/// which characters are marks. Both read the parse in this file, so they cannot
/// disagree about it. Nothing here knows about colour, size or widgets.
///
/// Offsets are UTF-16 code units, the unit a text field's selection is in, and
/// are relative to the start of the line unless a function says otherwise.
library;

import 'dart:ui' show TextRange;

/// What a whole line is.
enum LineKind {
  /// Nothing but whitespace.
  blank,

  /// A line inside a code fence, or the fence line itself.
  code,

  /// `#`…`######` and a title.
  heading,

  /// `***`, `---` or `___`.
  sceneBreak,

  /// `<!-- page -->` or a line that is only a picture.
  marker,

  /// `> `.
  quote,

  /// `- `, `* `, `+ ` or `1. `.
  listItem,

  /// Anything else: a line of prose.
  text,
}

/// Syntax at the front of a line, before its text.
enum PrefixRole {
  /// `## ` or `> `: a mark, drawn faint.
  marker,

  /// Indentation or the gap after a list marker: drawn as text.
  plain,

  /// `-` or `12.`: the bullet or the number.
  listMarker,
}

class LinePrefix {
  const LinePrefix(this.start, this.end, this.role);

  final int start;
  final int end;
  final PrefixRole role;
}

/// One line, classified. [inline] is the parse of the line's text (from
/// [inlineStart]); it is empty for a line with no inline markdown in it (a
/// code line, a blank line, a scene break).
class ManuscriptLine {
  const ManuscriptLine(
    this.kind, {
    this.headingLevel = 0,
    this.isFence = false,
    this.prefix = const [],
    this.inlineStart = 0,
    this.inline = const [],
  });

  final LineKind kind;
  final int headingLevel;

  /// A ``` or ~~~ line (only when [kind] is [LineKind.code]).
  final bool isFence;
  final List<LinePrefix> prefix;
  final int inlineStart;
  final List<InlineNode> inline;
}

sealed class InlineNode {
  const InlineNode();
}

/// Plain text.
class TextNode extends InlineNode {
  const TextNode(this.start, this.end);

  final int start;
  final int end;
}

/// The `\` of `\*`: the escaped character that follows is a [TextNode].
class EscapeNode extends InlineNode {
  const EscapeNode(this.at);

  final int at;
}

/// `` `code` ``: the ticks and what is between them.
class CodeNode extends InlineNode {
  const CodeNode(this.open, this.inner, this.close);

  final TextRange open;
  final TextRange inner;
  final TextRange close;
}

/// `![alt](url)`, whole.
class ImageNode extends InlineNode {
  const ImageNode(this.range);

  final TextRange range;
}

/// `[label](url)`.
class LinkNode extends InlineNode {
  const LinkNode(this.open, this.label, this.tail);

  /// The `[`.
  final TextRange open;
  final List<InlineNode> label;

  /// The `](url)` after the label.
  final TextRange tail;
}

enum EmphasisKind { bold, italic, strike }

/// `**bold**`, `*italic*`, `__bold__`, `_italic_` or `~~strike~~`.
class EmphasisNode extends InlineNode {
  const EmphasisNode(this.kind, this.open, this.children, this.close);

  final EmphasisKind kind;
  final TextRange open;
  final List<InlineNode> children;
  final TextRange close;

  /// Bold and italic are drawn with their marks hidden; strikethrough keeps
  /// its own, faint.
  bool get marksAreHidden => kind != EmphasisKind.strike;
}

final _fenceLine = RegExp(r'^\s{0,3}(```|~~~)');
final _heading = RegExp(r'^(#{1,6})([ \t]+)(.*)$');
final _thematicBreak = RegExp(
  r'^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$',
);
final _quote = RegExp(r'^([ \t]{0,3}>[ \t]?)(.*)$');
final _list = RegExp(r'^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$');
final _imageOnly = RegExp(r'^\s*!\[[^\]]*\]\([^)]*\)\s*$');
final _linkOrImage = RegExp(r'(!?)\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)');

/// The fence a line opens or closes, or null.
String? fenceMarkerOf(String line) => _fenceLine.firstMatch(line)?.group(1);

/// Whether the line after [line] is inside a code fence, given whether [line]
/// was ([inFence]) and the marker that opened it ([openedWith]).
({bool inFence, String? openedWith}) fenceStateAfter(
  String line, {
  required bool inFence,
  required String? openedWith,
}) {
  final marker = fenceMarkerOf(line);
  if (marker == null) return (inFence: inFence, openedWith: openedWith);
  if (!inFence) return (inFence: true, openedWith: marker);
  if (marker == openedWith) return (inFence: false, openedWith: null);
  return (inFence: inFence, openedWith: openedWith);
}

/// Classifies one line and parses its inline markdown.
ManuscriptLine parseLine(String line, {required bool inFence}) {
  if (inFence) {
    return ManuscriptLine(LineKind.code, isFence: _fenceLine.hasMatch(line));
  }
  if (line.trim().isEmpty) return const ManuscriptLine(LineKind.blank);
  if (_fenceLine.hasMatch(line)) {
    return const ManuscriptLine(LineKind.code, isFence: true);
  }
  final heading = _heading.firstMatch(line);
  if (heading != null) {
    final mark = heading.group(1)!.length + heading.group(2)!.length;
    return ManuscriptLine(
      LineKind.heading,
      headingLevel: heading.group(1)!.length,
      prefix: [LinePrefix(0, mark, PrefixRole.marker)],
      inlineStart: mark,
      inline: parseInline(heading.group(3)!, at: mark),
    );
  }
  if (_thematicBreak.hasMatch(line)) {
    return const ManuscriptLine(LineKind.sceneBreak);
  }
  if (line.trim() == '<!-- page -->' || _imageOnly.hasMatch(line)) {
    return const ManuscriptLine(LineKind.marker);
  }
  final quote = _quote.firstMatch(line);
  if (quote != null) {
    final mark = quote.group(1)!.length;
    return ManuscriptLine(
      LineKind.quote,
      prefix: [LinePrefix(0, mark, PrefixRole.marker)],
      inlineStart: mark,
      inline: parseInline(quote.group(2)!, at: mark),
    );
  }
  final item = _list.firstMatch(line);
  if (item != null) {
    final indent = item.group(1)!.length;
    final bullet = indent + item.group(2)!.length;
    final gap = bullet + item.group(3)!.length;
    return ManuscriptLine(
      LineKind.listItem,
      prefix: [
        if (indent > 0) LinePrefix(0, indent, PrefixRole.plain),
        LinePrefix(indent, bullet, PrefixRole.listMarker),
        LinePrefix(bullet, gap, PrefixRole.plain),
      ],
      inlineStart: gap,
      inline: parseInline(item.group(4)!, at: gap),
    );
  }
  return ManuscriptLine(LineKind.text, inline: parseInline(line, at: 0));
}

const _escapable = r'\`*_{}[]()#+-.!~>';

/// Inline markdown in [s], which starts at offset [at] of its line: code
/// spans, bold, italic, strikethrough, links and pictures. Unbalanced marks
/// stay plain text.
List<InlineNode> parseInline(String s, {int at = 0}) {
  final out = <InlineNode>[];
  var plainStart = -1;
  void flush(int end) {
    if (plainStart >= 0 && end > plainStart) {
      out.add(TextNode(plainStart, end));
    }
    plainStart = -1;
  }

  var i = 0;
  while (i < s.length) {
    final c = s[i];
    if (c == r'\' && i + 1 < s.length && _escapable.contains(s[i + 1])) {
      flush(at + i);
      out.add(EscapeNode(at + i));
      // The escaped character is text, and starts the next plain run.
      plainStart = at + i + 1;
      i += 2;
      continue;
    }
    if (c == '`') {
      final close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        flush(at + i);
        out.add(
          CodeNode(
            TextRange(start: at + i, end: at + i + 1),
            TextRange(start: at + i + 1, end: at + close),
            TextRange(start: at + close, end: at + close + 1),
          ),
        );
        i = close + 1;
        continue;
      }
    }
    if (c == '!' || c == '[') {
      final match = _linkOrImage.matchAsPrefix(s, i);
      if (match != null) {
        flush(at + i);
        if (match.group(1)!.isNotEmpty) {
          out.add(ImageNode(TextRange(start: at + i, end: at + match.end)));
        } else {
          final label = match.group(2)!;
          out.add(
            LinkNode(
              TextRange(start: at + i, end: at + i + 1),
              parseInline(label, at: at + i + 1),
              TextRange(start: at + i + 1 + label.length, end: at + match.end),
            ),
          );
        }
        i = match.end;
        continue;
      }
    }
    final pair = i + 1 < s.length ? s.substring(i, i + 2) : '';
    if (pair == '**' || pair == '__' || pair == '~~') {
      final close = _closerFor(s, pair, i + 2);
      if (close != null) {
        flush(at + i);
        out.add(
          EmphasisNode(
            pair == '~~' ? EmphasisKind.strike : EmphasisKind.bold,
            TextRange(start: at + i, end: at + i + 2),
            parseInline(s.substring(i + 2, close), at: at + i + 2),
            TextRange(start: at + close, end: at + close + 2),
          ),
        );
        i = close + 2;
        continue;
      }
    }
    if (c == '*' || c == '_') {
      final close = _italicCloser(s, c, i);
      if (close != null) {
        flush(at + i);
        out.add(
          EmphasisNode(
            EmphasisKind.italic,
            TextRange(start: at + i, end: at + i + 1),
            parseInline(s.substring(i + 1, close), at: at + i + 1),
            TextRange(start: at + close, end: at + close + 1),
          ),
        );
        i = close + 1;
        continue;
      }
    }
    if (plainStart < 0) plainStart = at + i;
    i++;
  }
  flush(at + s.length);
  return out;
}

/// Where a `**`, `__` or `~~` opened at [from] - 2 closes, or null.
///
/// The closer is the last two characters of the next run of that character,
/// so `***word***` closes bold on its final two stars and leaves the inner
/// `*word*` to italic.
int? _closerFor(String s, String pair, int from) {
  if (from >= s.length || _isBlank(s.codeUnitAt(from))) return null;
  final char = pair[0];
  var j = from + 1;
  while (j < s.length) {
    if (s[j] == char) {
      var run = 1;
      while (j + run < s.length && s[j + run] == char) {
        run++;
      }
      if (run >= 2 && !_isBlank(s.codeUnitAt(j - 1))) return j + run - 2;
      j += run;
      continue;
    }
    j++;
  }
  return null;
}

/// Where a single `*` or `_` opened at [open] closes, or null. Runs of two or
/// more are bold inside the italic and are skipped. An `_` must sit at word
/// edges, so snake_case and file_names stay plain.
int? _italicCloser(String s, String char, int open) {
  final start = open + 1;
  if (start >= s.length || _isBlank(s.codeUnitAt(start))) return null;
  if (char == '_' && open > 0 && _isWordUnit(s.codeUnitAt(open - 1))) {
    return null;
  }
  var j = start;
  while (j < s.length) {
    if (s[j] == char) {
      var run = 1;
      while (j + run < s.length && s[j + run] == char) {
        run++;
      }
      final closes =
          run == 1 &&
          j > start &&
          !_isBlank(s.codeUnitAt(j - 1)) &&
          (char != '_' ||
              j + 1 >= s.length ||
              !_isWordUnit(s.codeUnitAt(j + 1)));
      if (closes) return j;
      j += run;
      continue;
    }
    j++;
  }
  return null;
}

bool _isBlank(int unit) => unit == 0x20 || unit == 0x09 || unit == 0xa0;

bool _isWordUnit(int unit) =>
    (unit >= 0x30 && unit <= 0x39) ||
    (unit >= 0x41 && unit <= 0x5a) ||
    (unit >= 0x61 && unit <= 0x7a) ||
    unit > 0x7f;

final _wordChar = RegExp(r"[\p{L}\p{N}\p{M}'’]", unicode: true);

/// The word [offset] is in or touching, or null between words.
({int start, int end})? wordAround(String text, int offset) {
  bool isWord(int index) =>
      index >= 0 &&
      index < text.length &&
      _wordChar.hasMatch(String.fromCharCode(text.codeUnitAt(index)));
  var start = offset;
  var end = offset;
  while (isWord(start - 1)) {
    start--;
  }
  while (isWord(end)) {
    end++;
  }
  if (start == end) return null;
  return (start: start, end: end);
}
