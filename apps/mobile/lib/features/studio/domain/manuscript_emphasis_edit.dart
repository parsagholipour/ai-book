part of 'manuscript_emphasis.dart';

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

/// What a key press or paste did to the text: `[start, end)` of the old text
/// became [inserted].
class _Change {
  const _Change(this.start, this.end, this.inserted);

  final int start;
  final int end;
  final String inserted;

  bool get isInsertion => start == end;
}

/// What the platform meant by turning [old] into [next], read from where the
/// cursor was and where it went where that is unambiguous (deleting one of two
/// stars in a row leaves the same text either way), else from the text alone.
_Change? _changeOf(TextEditingValue old, TextEditingValue next) {
  final o = old.text;
  final n = next.text;
  if (o == n) return null;
  final was = old.selection;
  final now = next.selection;
  _Change? attempt(int start, int end, int inserted) {
    if (inserted < 0 || start < 0 || end > o.length || start > end) return null;
    if (n.length != o.length - (end - start) + inserted) return null;
    if (!n.startsWith(o.substring(0, start))) return null;
    if (!n.endsWith(o.substring(end))) return null;
    return _Change(start, end, n.substring(start, start + inserted));
  }

  if (was.isValid && now.isValid && now.isCollapsed) {
    if (!was.isCollapsed) {
      final kept = o.length - (was.end - was.start);
      final found = attempt(was.start, was.end, n.length - kept);
      if (found != null &&
          now.baseOffset == was.start + found.inserted.length) {
        return found;
      }
    } else {
      final at = was.baseOffset;
      if (n.length >= o.length) {
        final found = attempt(at, at, n.length - o.length);
        if (found != null && now.baseOffset == at + found.inserted.length) {
          return found;
        }
      } else {
        final removed = o.length - n.length;
        if (now.baseOffset == at - removed) {
          final found = attempt(at - removed, at, 0);
          if (found != null) return found;
        }
        if (now.baseOffset == at) {
          final found = attempt(at, at + removed, 0);
          if (found != null) return found;
        }
      }
    }
  }
  var prefix = 0;
  final shortest = o.length < n.length ? o.length : n.length;
  while (prefix < shortest && o.codeUnitAt(prefix) == n.codeUnitAt(prefix)) {
    prefix++;
  }
  var suffix = 0;
  while (suffix < shortest - prefix &&
      o.codeUnitAt(o.length - 1 - suffix) ==
          n.codeUnitAt(n.length - 1 - suffix)) {
    suffix++;
  }
  return _Change(
    prefix,
    o.length - suffix,
    n.substring(prefix, n.length - suffix),
  );
}

/// The outcome of [guardEdit].
class EmphasisGuardResult {
  const EmphasisGuardResult(this.value, {this.appliedTypingStyle = false});

  final TextEditingValue value;

  /// The typing style the caller passed was used up by this edit.
  final bool appliedTypingStyle;
}

/// [next], the value a key press, paste or cut produced from [old], corrected
/// so that no hidden mark is broken by it. [typingStyle] is bold or italic
/// switched on with nothing selected: it goes round what was typed.
EmphasisGuardResult guardEdit(
  TextEditingValue old,
  TextEditingValue next, {
  Set<EmphasisKind> typingStyle = const {},
}) {
  final change = _changeOf(old, next);
  if (change == null) return EmphasisGuardResult(next);
  if (typingStyle.isNotEmpty && change.isInsertion) {
    final styled = _applyTypingStyle(old, next, change, typingStyle);
    if (styled != null) {
      return EmphasisGuardResult(styled, appliedTypingStyle: true);
    }
  }
  final o = old.text;
  if (!o.contains('*') && !o.contains('_')) return EmphasisGuardResult(next);
  final index = EmphasisIndex.of(o);
  if (index.pairs.isEmpty) return EmphasisGuardResult(next);
  final guarded = change.isInsertion
      ? _guardInsertion(o, index, change)
      : _guardDeletion(old, next, index, change);
  return EmphasisGuardResult(guarded ?? next);
}

bool _isSpace(int unit) =>
    unit == 0x20 || unit == 0x09 || unit == 0x0a || unit == 0xa0;

TextEditingValue _value(String text, int caret) => TextEditingValue(
  text: text,
  selection: TextSelection.collapsed(offset: caret),
);

String _markText(String text, TextRange range) =>
    text.substring(range.start, range.end);

/// Typed text at the cursor, moved out of marks it must not go inside, or
/// null to leave it where the platform put it.
TextEditingValue? _guardInsertion(String o, EmphasisIndex index, _Change c) {
  if (c.inserted.isEmpty || !_isSpace(c.inserted.codeUnitAt(0))) return null;
  var at = c.start;
  // A space typed at the end of a bold word goes after the word: `**word **`
  // is not bold. Out through every pair that ends here, innermost first.
  var moved = true;
  while (moved) {
    moved = false;
    for (final pair in index.pairs) {
      if (pair.close.start == at) {
        at = pair.close.end;
        moved = true;
        break;
      }
    }
  }
  // …and one typed at the start, just inside the opening marks, goes before.
  if (at == c.start) {
    moved = true;
    while (moved) {
      moved = false;
      for (final pair in index.pairs) {
        if (pair.open.end == at) {
          at = pair.open.start;
          moved = true;
          break;
        }
      }
    }
  }
  // A break inside a bold word ends the bold before it and begins it again
  // after: marks cannot cross a line.
  var closers = '';
  var openers = '';
  if (c.inserted.codeUnitAt(0) == 0x0a) {
    final around = index.containing(at, at)
      ..sort((a, b) => b.open.start.compareTo(a.open.start));
    for (final pair in around) {
      if (pair.open.end == at || pair.close.start == at) continue;
      closers += _markText(o, pair.close);
    }
    for (final pair in around.reversed) {
      if (pair.open.end == at || pair.close.start == at) continue;
      openers += _markText(o, pair.open);
    }
  }
  if (at == c.start && closers.isEmpty) return null;
  final head = o.substring(0, at);
  final text = '$head$closers${c.inserted}$openers${o.substring(at)}';
  return _value(text, at + closers.length + c.inserted.length + openers.length);
}

/// A deletion (or a replacement, which is a deletion and an insertion) that
/// leaves every pair whole, or removes it whole.
TextEditingValue? _guardDeletion(
  TextEditingValue old,
  TextEditingValue next,
  EmphasisIndex index,
  _Change change,
) {
  final o = old.text;
  var start = change.start;
  var end = change.end;
  var inserted = change.inserted;

  // Backspace or Delete over marks alone: the person meant the letter beside
  // them. Which side is the side the cursor was on.
  if (inserted.isEmpty && _allHidden(index, start, end)) {
    final was = old.selection;
    final forward = was.isValid && was.isCollapsed && was.baseOffset == start;
    final target = forward
        ? _visibleAfter(o, index, end)
        : _visibleBefore(o, index, start);
    if (target == null) return old; // nothing to delete: the edit is a no-op
    start = target.start;
    end = target.end;
  }

  // A pair's marks go whole or not at all: widen over any it half covers.
  for (final pair in index.pairs) {
    for (final mark in [pair.open, pair.close]) {
      final touches = mark.start < end && start < mark.end;
      if (!touches) continue;
      if (mark.start < start) start = mark.start;
      if (mark.end > end) end = mark.end;
    }
  }

  final gone = <TextRange>[TextRange(start: start, end: end)];
  final kept = <TextRange>[];
  final candidates = [
    for (final pair in index.pairs)
      if (pair.close.end >= start && pair.open.start <= end) pair,
  ];
  for (final pair in candidates) {
    final openHit = pair.open.start >= start && pair.open.end <= end;
    final closeHit = pair.close.start >= start && pair.close.end <= end;
    if (openHit && closeHit) continue; // the whole pair went with the range
    if (openHit || closeHit) {
      final survivor = openHit ? pair.close : pair.open;
      final hit = openHit ? pair.open : pair.close;
      // The marks that were hit stay if letters are left for them to hold.
      final left = openHit
          ? _visibleIn(o, index, end, survivor.start, gone)
          : _visibleIn(o, index, survivor.end, start, gone);
      if (left > 0) {
        kept.add(hit);
      } else {
        gone.add(survivor);
      }
    } else {
      // Neither mark was touched: the pair dies with its last letter.
      final inside = pair.open.end <= start && end <= pair.close.start;
      if (!inside) continue;
      final letters =
          _visibleIn(o, index, pair.open.end, pair.close.start, gone) +
          (inserted.isEmpty ? 0 : 1);
      if (letters == 0) {
        gone
          ..add(pair.open)
          ..add(pair.close);
      }
    }
  }

  final removed = List<bool>.filled(o.length, false);
  for (final range in gone) {
    for (var i = range.start; i < range.end; i++) {
      removed[i] = true;
    }
  }
  for (final range in kept) {
    for (var i = range.start; i < range.end; i++) {
      removed[i] = true;
    }
  }
  String slice(int from, int to) {
    final out = StringBuffer();
    for (var i = from; i < to; i++) {
      if (!removed[i]) out.writeCharCode(o.codeUnitAt(i));
    }
    return out.toString();
  }

  final head = slice(0, start);
  final keptText = (kept..sort((a, b) => a.start.compareTo(b.start)))
      .map((range) => _markText(o, range))
      .join();
  final text = '$head$inserted$keptText${slice(end, o.length)}';
  // The cursor goes where the range was: after what stayed before it (less any
  // marks of a pair that died with it) and what was typed over it, and before
  // the marks that were kept, so what is typed next has the style of the
  // letter before it.
  return _value(text, head.length + inserted.length);
}

bool _allHidden(EmphasisIndex index, int start, int end) {
  if (end <= start) return false;
  for (var i = start; i < end; i++) {
    if (!index.isHidden(i)) return false;
  }
  return true;
}

/// The letter before [offset] that is not a mark, whole, or null.
TextRange? _visibleBefore(String text, EmphasisIndex index, int offset) {
  var i = offset - 1;
  while (i >= 0 && index.isHidden(i)) {
    i--;
  }
  if (i < 0) return null;
  final unit = text.codeUnitAt(i);
  final low = unit >= 0xdc00 && unit <= 0xdfff && i > 0;
  return TextRange(start: low ? i - 1 : i, end: i + 1);
}

/// The letter at or after [offset] that is not a mark, whole, or null.
TextRange? _visibleAfter(String text, EmphasisIndex index, int offset) {
  var i = offset;
  while (i < text.length && index.isHidden(i)) {
    i++;
  }
  if (i >= text.length) return null;
  final unit = text.codeUnitAt(i);
  final high = unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length;
  return TextRange(start: i, end: i + (high ? 2 : 1));
}

/// Letters in `[from, to)` that are not marks and not in [gone].
int _visibleIn(
  String text,
  EmphasisIndex index,
  int from,
  int to,
  List<TextRange> gone,
) {
  var count = 0;
  for (var i = from; i < to; i++) {
    if (index.isHidden(i)) continue;
    if (gone.any((range) => i >= range.start && i < range.end)) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Typing style
// ---------------------------------------------------------------------------

String _markerFor(EmphasisKind kind) => kind == EmphasisKind.bold ? '**' : '*';

/// Text typed with bold or italic switched on and nothing selected: the marks
/// go round it. The cursor ends inside them, so the next letter is bold too.
TextEditingValue? _applyTypingStyle(
  TextEditingValue old,
  TextEditingValue next,
  _Change change,
  Set<EmphasisKind> style,
) {
  final inserted = change.inserted;
  if (inserted.isEmpty || inserted.contains('\n')) return null;
  var lead = 0;
  while (lead < inserted.length && _isSpace(inserted.codeUnitAt(lead))) {
    lead++;
  }
  // Only a space so far: there is nothing to make bold yet.
  if (lead == inserted.length) return null;
  var tail = inserted.length;
  while (tail > lead && _isSpace(inserted.codeUnitAt(tail - 1))) {
    tail--;
  }
  final spaceBefore = inserted.substring(0, lead);
  final word = inserted.substring(lead, tail);
  final spaceAfter = inserted.substring(tail);
  final o = old.text;
  final at = change.start;

  TextRange composingShifted(int by) {
    final composing = next.composing;
    return composing.isValid && !composing.isCollapsed
        ? TextRange(start: composing.start + by, end: composing.end + by)
        : TextRange.empty;
  }

  // Bold typed right after a bold word is that word going on, not a second
  // one (`**a****b**` does not read back as two): the word goes in before the
  // word's closing marks.
  final index = EmphasisIndex.of(o);
  if (lead == 0 && spaceAfter.isEmpty) {
    for (final kind in style) {
      for (final pair in index.pairs) {
        if (pair.kind == kind && pair.close.end == at) {
          final closeLength = pair.close.end - pair.close.start;
          final text =
              '${o.substring(0, pair.close.start)}$word'
              '${_markText(o, pair.close)}${o.substring(at)}';
          return TextEditingValue(
            text: text,
            selection: TextSelection.collapsed(
              offset: pair.close.start + word.length,
            ),
            composing: composingShifted(-closeLength),
          );
        }
      }
    }
  }

  final ordered = [
    if (style.contains(EmphasisKind.bold)) EmphasisKind.bold,
    if (style.contains(EmphasisKind.italic)) EmphasisKind.italic,
  ];
  final open = ordered.map(_markerFor).join();
  final close = ordered.reversed.map(_markerFor).join();
  final text =
      '${o.substring(0, at)}$spaceBefore$open$word$close$spaceAfter'
      '${o.substring(at)}';
  return TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(
      offset: at + spaceBefore.length + open.length + word.length,
    ),
    composing: composingShifted(open.length + spaceBefore.length),
  );
}

/// A [TextInputFormatter] that runs [guardEdit] on every edit. [typingStyle]
/// is asked for each one.
class ManuscriptEmphasisFormatter extends TextInputFormatter {
  const ManuscriptEmphasisFormatter({this.typingStyle});

  final Set<EmphasisKind> Function()? typingStyle;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) => guardEdit(
    oldValue,
    newValue,
    typingStyle: typingStyle?.call() ?? const {},
  ).value;
}
