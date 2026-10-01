import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../domain/manuscript_emphasis.dart';
import '../domain/manuscript_formatting.dart';
import '../domain/manuscript_inline.dart';

/// A text controller that draws markdown as it will read in the book, without
/// changing a single character of it.
///
/// Headings are large and bold, `**bold**` is bold, `*italic*` is italic,
/// quotes are italic and quiet, list markers take the brand tint and a scene
/// break is muted and spaced out. The syntax marks themselves stay in the text
/// — offsets, selection, undo and the saved markdown are all the plain text.
/// The marks of bold and italic are not drawn at all, so the words are simply
/// bold and italic; the others (a heading's `#`, a quote's `>`, a link's
/// brackets) are drawn faint and a little smaller, so the page reads as prose.
///
/// Because a hidden mark is still a character, the controller also keeps the
/// cursor from resting inside one and holds the *typing style* (bold switched
/// on with nothing selected). The rules are in `manuscript_emphasis.dart`; the
/// edits that break marks are corrected by [ManuscriptEmphasisFormatter],
/// which the field it is in has to be given.
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

  Set<EmphasisKind> _typingStyle = const {};

  /// Bold and italic switched on with the cursor between words: nothing is
  /// written until the next thing is typed, which the marks then go round.
  /// It belongs to the place it was asked for and is let go of when the cursor
  /// moves or the text changes — except by spaces typed at the end of a bold
  /// or italic run, which keep the run's style on so a phrase can be typed in
  /// it (see [continuedTypingStyle]).
  Set<EmphasisKind> get typingStyle => _typingStyle;

  /// The formatter that keeps hidden marks whole and applies [typingStyle].
  late final ManuscriptEmphasisFormatter emphasisFormatter =
      ManuscriptEmphasisFormatter(typingStyle: () => _typingStyle);

  /// Moves a keyboard's edit made on text the formatters have since rewritten
  /// onto the rewrite. It keeps the last value the keyboard sent, so it is one
  /// per field, and it runs before anything reads the edit.
  late final ManuscriptImeRebase imeRebase = ManuscriptImeRebase();

  /// What a field over this controller must take as `inputFormatters`, in
  /// this order: the keyboard's edit moved onto the current text, Enter as a
  /// paragraph or list item, then the hidden marks kept whole.
  List<TextInputFormatter> get inputFormatters => [
    imeRebase,
    const ManuscriptEnterFormatter(),
    emphasisFormatter,
  ];

  @override
  set value(TextEditingValue newValue) {
    final snapped = snapSelection(value, newValue);
    if (snapped.text != value.text || snapped.selection != value.selection) {
      _typingStyle = continuedTypingStyle(value, snapped, _typingStyle);
    }
    super.value = snapped;
  }

  /// The Bold and Italic buttons and their shortcuts.
  ///
  /// At the end of a run of [kind] it steps out of the run, so what is typed
  /// next is not [kind]. On a selection or a word it changes the text (see
  /// [toggleEmphasis]). With
  /// the cursor between words there is nothing to change, so it switches the
  /// typing style instead — unless the cursor is already in text of that
  /// style, where there is nothing to switch on.
  void toggleStyle(EmphasisKind kind) {
    final current = value;
    // At the end of a run of this style, the button turns it off for what is
    // typed next rather than taking it off the last word (see [leaveRunEnd]).
    // The composing word is let go of, so the keyboard starts the next word
    // where the cursor now is.
    final left = leaveRunEnd(current, kind);
    if (left != null) {
      value = left.value;
      _typingStyle = left.keep;
      notifyListeners();
      return;
    }
    if (current.selection.isValid &&
        current.selection.isCollapsed &&
        !cursorTouchesWord(current)) {
      if (emphasisAt(current, kind)) return;
      _typingStyle = _typingStyle.contains(kind)
          ? ({..._typingStyle}..remove(kind))
          : {..._typingStyle, kind};
      notifyListeners();
      return;
    }
    value = toggleEmphasis(current, kind);
  }

  /// Whether the cursor or selection is in [kind] text, or [kind] is about to
  /// be typed: what the toolbar button shows.
  bool isStyleOn(EmphasisKind kind) =>
      _typingStyle.contains(kind) || emphasisAt(value, kind);

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
    var fence = (inFence: false, openedWith: null as String?);
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      final key = _LineKey(line, fence.inFence);
      final styled =
          used[key] ??
          _cache[key] ??
          (() {
            debugStyledLines++;
            return _styleLine(line, fence.inFence, palette);
          })();
      used[key] = styled;
      spans.addAll(styled.spans);
      if (i < lines.length - 1) {
        spans.add(TextSpan(text: '\n', style: styled.newline));
      }
      fence = fenceStateAfter(
        line,
        inFence: fence.inFence,
        openedWith: fence.openedWith,
      );
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

  /// A bold or italic mark: there, in the text, and not drawn.
  late final TextStyle hidden = base.copyWith(
    fontSize: 0,
    letterSpacing: 0,
    height: 1,
    fontWeight: FontWeight.w400,
    fontStyle: FontStyle.normal,
    decoration: TextDecoration.none,
  );

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

_StyledLine _styleLine(String line, bool inFence, ManuscriptSpanPalette p) {
  final parsed = parseLine(line, inFence: inFence);
  switch (parsed.kind) {
    case LineKind.code:
      return _StyledLine(
        _span(line, parsed.isFence ? p.marker : p.codeBlock),
        p.codeBlock,
      );
    case LineKind.blank:
      return _StyledLine(_span(line, p.body), p.blankLine);
    case LineKind.heading:
      final style = p.heading(parsed.headingLevel);
      return _StyledLine([
        ..._prefix(line, parsed, p),
        ..._inline(line, parsed.inline, style, p),
      ], style);
    case LineKind.sceneBreak:
      return _StyledLine(_span(line, p.sceneBreak), p.body);
    case LineKind.marker:
      return _StyledLine(_span(line, p.marker), p.body);
    case LineKind.quote:
      return _StyledLine([
        ..._prefix(line, parsed, p),
        ..._inline(line, parsed.inline, p.quote, p),
      ], p.body);
    case LineKind.listItem:
      return _StyledLine([
        ..._prefix(line, parsed, p),
        ..._inline(line, parsed.inline, p.body, p),
      ], p.body);
    case LineKind.text:
      return _StyledLine(_inline(line, parsed.inline, p.body, p), p.body);
  }
}

List<TextSpan> _span(String text, TextStyle style) =>
    text.isEmpty ? const [] : [TextSpan(text: text, style: style)];

List<TextSpan> _prefix(
  String line,
  ManuscriptLine parsed,
  ManuscriptSpanPalette p,
) => [
  for (final part in parsed.prefix)
    TextSpan(
      text: line.substring(part.start, part.end),
      style: switch (part.role) {
        PrefixRole.marker => p.marker,
        PrefixRole.plain => p.body,
        PrefixRole.listMarker => p.listMarker,
      },
    ),
];

/// The spans for the parse of a line's text.
///
/// A bold or italic mark is drawn at no size at all: the text is bold or
/// italic and nothing shows that a `*` is there. The other marks (a link's
/// brackets, a code span's ticks, a strikethrough's `~~`) stay faint.
List<TextSpan> _inline(
  String line,
  List<InlineNode> nodes,
  TextStyle style,
  ManuscriptSpanPalette p,
) {
  final out = <TextSpan>[];
  TextStyle markerIn(TextStyle host) =>
      p.marker.copyWith(fontSize: (host.fontSize ?? p._size) * 0.86);
  TextSpan slice(int start, int end, TextStyle style) =>
      TextSpan(text: line.substring(start, end), style: style);

  void walk(List<InlineNode> nodes, TextStyle style) {
    for (final node in nodes) {
      switch (node) {
        case TextNode():
          out.add(slice(node.start, node.end, style));
        case EscapeNode():
          out.add(slice(node.at, node.at + 1, markerIn(style)));
        case CodeNode():
          out
            ..add(slice(node.open.start, node.open.end, markerIn(style)))
            ..add(slice(node.inner.start, node.inner.end, p.code))
            ..add(slice(node.close.start, node.close.end, markerIn(style)));
        case ImageNode():
          out.add(slice(node.range.start, node.range.end, markerIn(style)));
        case LinkNode():
          out.add(slice(node.open.start, node.open.end, markerIn(style)));
          walk(node.label, style.merge(p.link));
          out.add(slice(node.tail.start, node.tail.end, markerIn(style)));
        case EmphasisNode():
          final mark = node.marksAreHidden ? p.hidden : markerIn(style);
          out.add(slice(node.open.start, node.open.end, mark));
          walk(node.children, switch (node.kind) {
            EmphasisKind.strike => style.copyWith(
              decoration: TextDecoration.lineThrough,
              decorationColor: style.color?.withValues(alpha: 0.6),
            ),
            EmphasisKind.bold => style.copyWith(fontWeight: FontWeight.w800),
            EmphasisKind.italic => style.copyWith(fontStyle: FontStyle.italic),
          });
          out.add(slice(node.close.start, node.close.end, mark));
      }
    }
  }

  walk(nodes, style);
  return out;
}

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
