import 'package:flutter/material.dart';

/// A text controller that draws markdown as it will read in the book, without
/// changing a single character of it.
///
/// Headings are large and bold, `**bold**` is bold, `*italic*` is italic,
/// quotes are italic and quiet, list markers take the brand tint and a scene
/// break is muted and spaced out. The syntax marks themselves stay in the text
/// — offsets, selection, undo and the saved markdown are all the plain text —
/// but are drawn faint and a little smaller, so the page reads as prose.
///
/// A blank line is drawn at about half height. Paragraphs in markdown are
/// separated by one, so this is what paragraph spacing looks like here.
///
/// Styling runs on every keystroke over the whole field, which can hold a
/// 10,000-word chapter. It is memoized per line: a line's spans depend only on
/// its text, whether it sits inside a code fence, and the theme, so an edit
/// restyles the one line it touched and reuses the rest. The cache is rebuilt
/// from the lines in use on every pass, so it never outgrows the text.
class ManuscriptEditingController extends TextEditingController {
  ManuscriptEditingController({super.text});

  ManuscriptSpanPalette? _palette;
  Map<_LineKey, _StyledLine> _cache = {};

  /// How many lines were styled from scratch (not from the cache) so far.
  @visibleForTesting
  int debugStyledLines = 0;

  @override
  TextSpan buildTextSpan({
    required BuildContext context,
    TextStyle? style,
    required bool withComposing,
  }) {
    final palette = ManuscriptSpanPalette.of(context, style);
    return buildStyledSpan(
      palette: palette,
      style: style,
      composing: withComposing && value.isComposingRangeValid
          ? value.composing
          : TextRange.empty,
    );
  }

  /// The styled text for [palette], with [composing] underlined the way a
  /// plain [TextField] underlines an IME's composing region.
  @visibleForTesting
  TextSpan buildStyledSpan({
    required ManuscriptSpanPalette palette,
    TextStyle? style,
    TextRange composing = TextRange.empty,
  }) {
    if (palette != _palette) {
      _palette = palette;
      _cache = {};
    }
    final spans = <TextSpan>[];
    final used = <_LineKey, _StyledLine>{};
    final lines = text.split('\n');
    var inFence = false;
    String? fenceMarker;
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      final key = _LineKey(line, inFence);
      final styled =
          used[key] ??
          _cache[key] ??
          (() {
            debugStyledLines++;
            return _styleLine(line, inFence, palette);
          })();
      used[key] = styled;
      spans.addAll(styled.spans);
      if (i < lines.length - 1) {
        spans.add(TextSpan(text: '\n', style: styled.newline));
      }
      final fence = _fenceLine.firstMatch(line);
      if (fence != null) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fence.group(1);
        } else if (fence.group(1) == fenceMarker) {
          inFence = false;
          fenceMarker = null;
        }
      }
    }
    _cache = used;
    final children = composing.isValid && !composing.isCollapsed
        ? _underline(spans, composing)
        : spans;
    // Every span carries its own full style, so the root's only job is to be
    // what the field measures a "line" by: see [ManuscriptCaret].
    return TextSpan(style: palette.blankLine, children: children);
  }
}

/// Where the field draws its caret, so it sits on the line being written.
///
/// A blank line is drawn at about half height (see the controller), which the
/// field does not expect. It centres the caret on a strut box at the line's
/// baseline, and puts the caret at the end of the text — on the empty line
/// after a paragraph break — a "standard line" above the last baseline. With
/// the body's own line as that standard both come out right on a text line and
/// wrong everywhere else, so the standard is the blank line instead: the strut
/// and the root span are a blank line's size, every text line is taller than
/// them, and the field's caret arithmetic agrees with itself.
///
/// A blank line keeps its baseline near its bottom (negative *even* leading,
/// see [ManuscriptSpanPalette.blankStyleFor]), which makes the caret's centre
/// the centre of the line it is on, blank or not. A caret the height of a text
/// line would poke out of a blank one, so on an empty line it is the height of
/// the line and grows to full height when the first letter lands.
@immutable
class ManuscriptCaret {
  const ManuscriptCaret({required this.height, required this.emptyLineHeight});

  /// Measures the caret for a field whose text is [body], at [scaler].
  factory ManuscriptCaret.measure({
    required TextStyle body,
    required TextScaler scaler,
    required TextDirection textDirection,
  }) {
    final strut = ManuscriptSpanPalette.strutFor(
      body,
    ).inheritFromTextStyle(body);
    TextPainter measure(TextStyle style) => TextPainter(
      text: TextSpan(text: 'A', style: style),
      textDirection: textDirection,
      textScaler: scaler,
      strutStyle: strut,
    )..layout();
    final bodyLine = measure(body);
    final blankLine = measure(ManuscriptSpanPalette.blankStyleFor(body));
    final caret = ManuscriptCaret(
      // What a stock text field draws: the line, less the field's own 2px
      // inset at each end.
      height: bodyLine.height - 4,
      emptyLineHeight: blankLine.height,
    );
    bodyLine.dispose();
    blankLine.dispose();
    return caret;
  }

  /// The caret on a line of text.
  final double height;

  /// The caret on a blank line.
  final double emptyLineHeight;

  /// The caret's height with the cursor where [value] puts it.
  ///
  /// An empty chapter is not a blank line: its one line is as tall as the
  /// text that will fill it.
  double heightFor(TextEditingValue value) =>
      value.text.isNotEmpty && caretOnEmptyLine(value)
      ? emptyLineHeight
      : height;

  @override
  bool operator ==(Object other) =>
      other is ManuscriptCaret &&
      other.height == height &&
      other.emptyLineHeight == emptyLineHeight;

  @override
  int get hashCode => Object.hash(height, emptyLineHeight);
}

/// Whether [value] is a cursor on a line with nothing on it: the empty last
/// line after a paragraph break, an empty chapter, or a blank line between two
/// paragraphs.
bool caretOnEmptyLine(TextEditingValue value) {
  final selection = value.selection;
  if (!selection.isValid || !selection.isCollapsed) return false;
  final text = value.text;
  final at = selection.baseOffset.clamp(0, text.length);
  return (at == 0 || text.codeUnitAt(at - 1) == 0x0a) &&
      (at == text.length || text.codeUnitAt(at) == 0x0a);
}

/// Every style the controller draws with, derived once per theme and base
/// style. Two palettes are equal when their inputs are, which is what keys the
/// line cache.
@immutable
class ManuscriptSpanPalette {
  ManuscriptSpanPalette({required this.base, required this.scheme})
    : _size = base.fontSize ?? 16;

  factory ManuscriptSpanPalette.of(BuildContext context, TextStyle? style) {
    final theme = Theme.of(context);
    return ManuscriptSpanPalette(
      base: theme.textTheme.bodyLarge!.merge(style),
      scheme: theme.colorScheme,
    );
  }

  final TextStyle base;
  final ColorScheme scheme;
  final double _size;

  late final TextStyle body = base;

  /// `#` is the largest; `###` and below sit just above the body.
  TextStyle heading(int level) {
    final scale = switch (level) {
      1 => 1.55,
      2 => 1.32,
      _ => 1.14,
    };
    return base.copyWith(
      fontSize: _size * scale,
      fontWeight: FontWeight.w800,
      height: 1.3,
      letterSpacing: level <= 2 ? -0.3 : -0.1,
    );
  }

  late final TextStyle marker = base.copyWith(
    color: scheme.onSurface.withValues(alpha: 0.32),
    fontSize: _size * 0.86,
    fontWeight: FontWeight.w500,
    fontStyle: FontStyle.normal,
    decoration: TextDecoration.none,
  );

  late final TextStyle quote = base.copyWith(
    fontStyle: FontStyle.italic,
    color: scheme.onSurfaceVariant,
  );

  late final TextStyle listMarker = base.copyWith(
    color: scheme.primary,
    fontWeight: FontWeight.w800,
  );

  late final TextStyle sceneBreak = base.copyWith(
    color: scheme.onSurfaceVariant.withValues(alpha: 0.7),
    letterSpacing: _size * 0.6,
    fontWeight: FontWeight.w700,
  );

  late final TextStyle code = base.copyWith(
    fontFamily: 'monospace',
    fontFamilyFallback: const ['Roboto Mono', 'Menlo', 'Courier'],
    fontSize: _size * 0.88,
    backgroundColor: scheme.surfaceContainerHigh,
  );

  late final TextStyle codeBlock = base.copyWith(
    fontFamily: 'monospace',
    fontFamilyFallback: const ['Roboto Mono', 'Menlo', 'Courier'],
    fontSize: _size * 0.88,
    color: scheme.onSurfaceVariant,
  );

  late final TextStyle link = base.copyWith(
    color: scheme.primary,
    decoration: TextDecoration.underline,
    decorationColor: scheme.primary.withValues(alpha: 0.4),
  );

  /// A blank line: half a line, so the gap between paragraphs reads as
  /// paragraph spacing rather than an empty line.
  late final TextStyle blankLine = blankStyleFor(base);

  /// A blank line is 0.84 of the font size tall (15 at 18), whatever the font.
  ///
  /// It is that tall by *negative even leading* rather than by a smaller font:
  /// shrinking a line's height that way takes the same from above and below
  /// the text, so the baseline stays near the bottom of a short line, which is
  /// exactly where the field's caret arithmetic wants to find it. See
  /// [ManuscriptCaret].
  static const double _blankHeight = 0.84;

  static TextStyle blankStyleFor(TextStyle body) => body.copyWith(
    height: _blankHeight,
    leadingDistribution: TextLeadingDistribution.even,
  );

  /// The field's strut: as tall as a blank line and no taller, so nothing
  /// holds a blank line open and every text line is left to its own spans.
  static StrutStyle strutFor(TextStyle body) => StrutStyle(
    fontSize: body.fontSize ?? 16,
    height: _blankHeight,
    leading: 0,
    leadingDistribution: TextLeadingDistribution.even,
  );

  @override
  bool operator ==(Object other) =>
      other is ManuscriptSpanPalette &&
      other.base == base &&
      other.scheme == scheme;

  @override
  int get hashCode => Object.hash(base, scheme);
}

@immutable
class _LineKey {
  const _LineKey(this.text, this.inFence);

  final String text;
  final bool inFence;

  @override
  bool operator ==(Object other) =>
      other is _LineKey && other.text == text && other.inFence == inFence;

  @override
  int get hashCode => Object.hash(text, inFence);
}

class _StyledLine {
  const _StyledLine(this.spans, this.newline);

  final List<TextSpan> spans;

  /// The style of the newline that ends this line, which sets the height of
  /// the line when it is empty.
  final TextStyle newline;
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

_StyledLine _styleLine(String line, bool inFence, ManuscriptSpanPalette p) {
  if (inFence) {
    final style = _fenceLine.hasMatch(line) ? p.marker : p.codeBlock;
    return _StyledLine(_span(line, style), p.codeBlock);
  }
  if (line.trim().isEmpty) {
    return _StyledLine(_span(line, p.body), p.blankLine);
  }
  if (_fenceLine.hasMatch(line)) {
    return _StyledLine(_span(line, p.marker), p.codeBlock);
  }
  final heading = _heading.firstMatch(line);
  if (heading != null) {
    final style = p.heading(heading.group(1)!.length);
    return _StyledLine([
      TextSpan(text: heading.group(1)! + heading.group(2)!, style: p.marker),
      ..._inline(heading.group(3)!, style, p),
    ], style);
  }
  if (_thematicBreak.hasMatch(line)) {
    return _StyledLine(_span(line, p.sceneBreak), p.body);
  }
  if (line.trim() == '<!-- page -->' || _imageOnly.hasMatch(line)) {
    return _StyledLine(_span(line, p.marker), p.body);
  }
  final quote = _quote.firstMatch(line);
  if (quote != null) {
    return _StyledLine([
      TextSpan(text: quote.group(1), style: p.marker),
      ..._inline(quote.group(2)!, p.quote, p),
    ], p.body);
  }
  final item = _list.firstMatch(line);
  if (item != null) {
    return _StyledLine([
      if (item.group(1)!.isNotEmpty)
        TextSpan(text: item.group(1), style: p.body),
      TextSpan(text: item.group(2), style: p.listMarker),
      TextSpan(text: item.group(3), style: p.body),
      ..._inline(item.group(4)!, p.body, p),
    ], p.body);
  }
  return _StyledLine(_inline(line, p.body, p), p.body);
}

List<TextSpan> _span(String text, TextStyle style) =>
    text.isEmpty ? const [] : [TextSpan(text: text, style: style)];

const _escapable = r'\`*_{}[]()#+-.!~>';

/// Inline markdown on one line: code spans, bold, italic, strikethrough,
/// links and pictures. Unbalanced markers stay plain text.
List<TextSpan> _inline(String s, TextStyle style, ManuscriptSpanPalette p) {
  final out = <TextSpan>[];
  final plain = StringBuffer();
  void flush() {
    if (plain.isEmpty) return;
    out.add(TextSpan(text: plain.toString(), style: style));
    plain.clear();
  }

  TextStyle markerIn(TextStyle host) =>
      p.marker.copyWith(fontSize: (host.fontSize ?? p._size) * 0.86);

  var i = 0;
  while (i < s.length) {
    final c = s[i];
    if (c == r'\' && i + 1 < s.length && _escapable.contains(s[i + 1])) {
      flush();
      out.add(TextSpan(text: c, style: markerIn(style)));
      plain.write(s[i + 1]);
      i += 2;
      continue;
    }
    if (c == '`') {
      final close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        flush();
        out
          ..add(TextSpan(text: '`', style: markerIn(style)))
          ..add(TextSpan(text: s.substring(i + 1, close), style: p.code))
          ..add(TextSpan(text: '`', style: markerIn(style)));
        i = close + 1;
        continue;
      }
    }
    if (c == '!' || c == '[') {
      final match = _linkOrImage.matchAsPrefix(s, i);
      if (match != null) {
        flush();
        if (match.group(1)!.isNotEmpty) {
          out.add(TextSpan(text: match.group(0), style: markerIn(style)));
        } else {
          final label = match.group(2)!;
          out
            ..add(TextSpan(text: '[', style: markerIn(style)))
            ..addAll(_inline(label, style.merge(p.link), p))
            ..add(
              TextSpan(
                text: match.group(0)!.substring(label.length + 1),
                style: markerIn(style),
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
        flush();
        final inner = switch (pair) {
          '~~' => style.copyWith(
            decoration: TextDecoration.lineThrough,
            decorationColor: style.color?.withValues(alpha: 0.6),
          ),
          _ => style.copyWith(fontWeight: FontWeight.w800),
        };
        out
          ..add(TextSpan(text: pair, style: markerIn(style)))
          ..addAll(_inline(s.substring(i + 2, close), inner, p))
          ..add(TextSpan(text: pair, style: markerIn(style)));
        i = close + 2;
        continue;
      }
    }
    if (c == '*' || c == '_') {
      final close = _italicCloser(s, c, i);
      if (close != null) {
        flush();
        out
          ..add(TextSpan(text: c, style: markerIn(style)))
          ..addAll(
            _inline(
              s.substring(i + 1, close),
              style.copyWith(fontStyle: FontStyle.italic),
              p,
            ),
          )
          ..add(TextSpan(text: c, style: markerIn(style)));
        i = close + 1;
        continue;
      }
    }
    plain.write(c);
    i++;
  }
  flush();
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

/// [spans] with [range] underlined, splitting the spans it cuts through. The
/// cached spans are never modified; the ones touched are replaced.
List<TextSpan> _underline(List<TextSpan> spans, TextRange range) {
  final out = <TextSpan>[];
  var offset = 0;
  for (final span in spans) {
    final text = span.text ?? '';
    final start = offset;
    final end = offset + text.length;
    offset = end;
    if (end <= range.start || start >= range.end || text.isEmpty) {
      out.add(span);
      continue;
    }
    final cutStart = (range.start - start).clamp(0, text.length);
    final cutEnd = (range.end - start).clamp(0, text.length);
    final style = span.style ?? const TextStyle();
    if (cutStart > 0) {
      out.add(TextSpan(text: text.substring(0, cutStart), style: style));
    }
    out.add(
      TextSpan(
        text: text.substring(cutStart, cutEnd),
        style: style.merge(
          const TextStyle(decoration: TextDecoration.underline),
        ),
      ),
    );
    if (cutEnd < text.length) {
      out.add(TextSpan(text: text.substring(cutEnd), style: style));
    }
  }
  return out;
}
