/// The editing rules for bold and italic whose marks are hidden.
///
/// The editor draws `**bold**` as bold and does not draw the stars, but the
/// stars are still in the text: the saved markdown, the selection offsets and
/// the undo history are all that text. That makes every offset next to a mark
/// a place the cursor can rest without looking like it moved, and every key
/// press there a chance to break a mark nobody can see. These functions are the
/// rules that keep that from happening, so that a mark behaves as one thing:
///
/// * The cursor never rests inside a mark, and an arrow key never stops on one
///   (it would look like a key that did nothing).
/// * Backspace and Delete next to a mark remove the letter beside it, not a
///   star.
/// * Deleting one end of a bold word without the other keeps the word bold.
///   Deleting all of it, or the last letter of it, takes its marks with it.
/// * A space typed at the end of a bold word goes after the word, and Enter
///   inside one ends the bold before the break and starts it again after.
/// * Typing style: turning bold on with the cursor between words writes
///   nothing; the marks go round the next thing typed. Spaces typed at the
///   end of a bold run keep its style on, and the next word joins the run;
///   Bold again at the end of the run steps out of it.
/// * A keyboard edit made on text a formatter has since rewritten is made
///   again on the rewrite ([ManuscriptImeRebase]).
///
/// Everything here is a pure function of a [TextEditingValue].
library;

import 'package:flutter/services.dart';

import 'manuscript_inline.dart';

part 'manuscript_emphasis_edit.dart';
part 'manuscript_emphasis_ime.dart';
part 'manuscript_emphasis_toggle.dart';

/// `**bold**` or `*italic*` (either spelling): the two marks and what they
/// hold. Strikethrough keeps its marks visible and is not one of these.
class EmphasisPair {
  const EmphasisPair(this.kind, this.open, this.close);

  final EmphasisKind kind;
  final TextRange open;
  final TextRange close;

  /// What is between the marks, which is what is bold.
  TextRange get content => TextRange(start: open.end, end: close.start);
}

/// Every bold and italic pair in a chapter and the runs of hidden marks they
/// make. Built once per text and reused, since a key press asks about the same
/// text several times.
class EmphasisIndex {
  EmphasisIndex._(this.text, this.pairs, this.runs);

  final String text;

  /// In order of where they open.
  final List<EmphasisPair> pairs;

  /// The hidden characters as maximal ranges: the closing marks of one word
  /// and the opening marks of the next, when they touch, are one run.
  final List<TextRange> runs;

  static EmphasisIndex? _last;

  static EmphasisIndex of(String text) {
    final last = _last;
    if (last != null && last.text == text) return last;
    return _last = _build(text);
  }

  /// The pairs of one line, by the line's text and relative to its start. A
  /// key press changes one line of hundreds, so the rest are read from here.
  static final Map<String, List<EmphasisPair>> _lines = {};

  static List<EmphasisPair> _pairsOfLine(String line) {
    final known = _lines[line];
    if (known != null) return known;
    if (_lines.length > 4000) _lines.clear();
    final pairs = <EmphasisPair>[];
    _collect(parseLine(line, inFence: false).inline, 0, pairs);
    return _lines[line] = pairs;
  }

  static EmphasisIndex _build(String text) {
    final pairs = <EmphasisPair>[];
    var fence = (inFence: false, openedWith: null as String?);
    var start = 0;
    while (start <= text.length) {
      var end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      var hasMark = false;
      var hasFence = false;
      for (var i = start; i < end; i++) {
        final unit = text.codeUnitAt(i);
        if (unit == 0x2a || unit == 0x5f) {
          hasMark = true;
        } else if (unit == 0x60 || unit == 0x7e) {
          hasFence = true;
        }
      }
      if (hasMark && !fence.inFence) {
        for (final pair in _pairsOfLine(text.substring(start, end))) {
          pairs.add(
            EmphasisPair(
              pair.kind,
              TextRange(
                start: pair.open.start + start,
                end: pair.open.end + start,
              ),
              TextRange(
                start: pair.close.start + start,
                end: pair.close.end + start,
              ),
            ),
          );
        }
      }
      if (hasFence) {
        fence = fenceStateAfter(
          text.substring(start, end),
          inFence: fence.inFence,
          openedWith: fence.openedWith,
        );
      }
      start = end + 1;
    }
    pairs.sort((a, b) => a.open.start.compareTo(b.open.start));
    final marks = <TextRange>[
      for (final pair in pairs) ...[pair.open, pair.close],
    ]..sort((a, b) => a.start.compareTo(b.start));
    final runs = <TextRange>[];
    for (final mark in marks) {
      if (runs.isNotEmpty && mark.start <= runs.last.end) {
        final last = runs.removeLast();
        runs.add(
          TextRange(
            start: last.start,
            end: mark.end > last.end ? mark.end : last.end,
          ),
        );
      } else {
        runs.add(mark);
      }
    }
    return EmphasisIndex._(text, pairs, runs);
  }

  static void _collect(
    List<InlineNode> nodes,
    int lineStart,
    List<EmphasisPair> out,
  ) {
    TextRange shift(TextRange r) =>
        TextRange(start: r.start + lineStart, end: r.end + lineStart);
    for (final node in nodes) {
      switch (node) {
        case EmphasisNode():
          if (node.marksAreHidden) {
            out.add(
              EmphasisPair(node.kind, shift(node.open), shift(node.close)),
            );
          }
          _collect(node.children, lineStart, out);
        case LinkNode():
          _collect(node.label, lineStart, out);
        case TextNode() || EscapeNode() || CodeNode() || ImageNode():
          break;
      }
    }
  }

  /// Whether the character at [index] is a hidden mark.
  bool isHidden(int index) {
    for (final run in runs) {
      if (index < run.start) return false;
      if (index < run.end) return true;
    }
    return false;
  }

  /// The run that [offset] is strictly inside, or null: an offset at either
  /// edge of a run is a place the cursor may rest.
  TextRange? runAround(int offset) {
    for (final run in runs) {
      if (offset <= run.start) return null;
      if (offset < run.end) return run;
    }
    return null;
  }

  /// The run with an edge at [offset], or null.
  TextRange? runAtEdge(int offset) {
    for (final run in runs) {
      if (offset < run.start) return null;
      if (offset == run.start || offset == run.end) return run;
    }
    return null;
  }

  /// The pairs whose content holds the whole of [range] (edges included), as
  /// the cursor sees them: the innermost last.
  List<EmphasisPair> containing(int start, int end) => [
    for (final pair in pairs)
      if (pair.open.end <= start && end <= pair.close.start) pair,
  ];
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

/// [next] with its cursor moved off any mark it rests inside, given the value
/// it replaces.
///
/// A mark has two edges and the cursor may rest on either, but not between
/// them. An offset that lands strictly inside one (a tap, a drag) goes to the
/// near edge, the one that gives the cursor the style of the letter before it,
/// as in any word processor. An offset that got there by one step from an edge
/// of the mark is a key press: a caret goes on past the next letter, since a
/// step over a mark that moved nothing you can see would look like a dead key,
/// and the end of a selection goes to the far edge.
TextEditingValue snapSelection(TextEditingValue old, TextEditingValue next) {
  final selection = next.selection;
  if (!selection.isValid) return next;
  final text = next.text;
  if (!text.contains('*') && !text.contains('_')) return next;
  final index = EmphasisIndex.of(text);
  if (index.runs.isEmpty) return next;

  final oldSelection = old.selection;
  final sameText = old.text == text && oldSelection.isValid;
  int snap(int offset, int? was, {required bool caret}) {
    final inside = index.runAround(offset);
    // A step: one character, from an edge of a run to inside it or to its
    // other edge. (A tap that lands somewhere else is not a step, even when
    // it lands on the other edge of the run the caret was at.)
    if (sameText && was != null && (offset - was).abs() == 1) {
      final from = index.runAtEdge(was);
      final to = inside ?? index.runAtEdge(offset);
      if (from != null && to != null && from.start == to.start) {
        if (caret) {
          return offset > was ? _after(text, to.end) : _before(text, to.start);
        }
        return offset > was ? to.end : to.start;
      }
    }
    return inside == null ? offset : inside.start;
  }

  final collapsed = selection.isCollapsed;
  final base = snap(
    selection.baseOffset,
    oldSelection.isValid ? oldSelection.baseOffset : null,
    caret: collapsed && oldSelection.isCollapsed,
  );
  final extent = collapsed
      ? base
      : snap(
          selection.extentOffset,
          oldSelection.isValid ? oldSelection.extentOffset : null,
          caret: false,
        );
  if (base == selection.baseOffset && extent == selection.extentOffset) {
    return next;
  }
  return next.copyWith(
    selection: selection.copyWith(baseOffset: base, extentOffset: extent),
  );
}

/// [offset] moved one letter on, past a surrogate pair whole.
int _after(String text, int offset) {
  if (offset >= text.length) return text.length;
  final unit = text.codeUnitAt(offset);
  final wide = unit >= 0xd800 && unit <= 0xdbff && offset + 1 < text.length;
  return offset + (wide ? 2 : 1);
}

/// [offset] moved one letter back, past a surrogate pair whole.
int _before(String text, int offset) {
  if (offset <= 0) return 0;
  final unit = text.codeUnitAt(offset - 1);
  final wide = unit >= 0xdc00 && unit <= 0xdfff && offset - 2 >= 0;
  return offset - (wide ? 2 : 1);
}

// ---------------------------------------------------------------------------
// Where the cursor is
// ---------------------------------------------------------------------------

/// Whether [value]'s cursor or selection is inside bold (or italic) text, so
/// the toolbar can show the button lit and typing continues the style.
///
/// A cursor at the far edge of a bold word, after its marks, is outside it:
/// what is typed there is not bold.
bool emphasisAt(TextEditingValue value, EmphasisKind kind) {
  final selection = value.selection;
  if (!selection.isValid) return false;
  final text = value.text;
  if (!text.contains('*') && !text.contains('_')) return false;
  final index = EmphasisIndex.of(text);
  return index
      .containing(selection.start, selection.end)
      .any((pair) => pair.kind == kind);
}

/// Whether the cursor of [value] is in or touching a word, which is what
/// bold and italic act on when nothing is selected.
bool cursorTouchesWord(TextEditingValue value) {
  final selection = value.selection;
  if (!selection.isValid || !selection.isCollapsed) return true;
  return wordAround(
        value.text,
        selection.baseOffset.clamp(0, value.text.length),
      ) !=
      null;
}
