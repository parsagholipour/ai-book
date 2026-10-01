part of 'manuscript_emphasis.dart';

// ---------------------------------------------------------------------------
// The Bold and Italic buttons
// ---------------------------------------------------------------------------

/// Bold or italic on the selection, or on the word the cursor is in.
///
/// It works on what is *seen*: a selection is the letters it covers, whether
/// or not its ends happen to include a hidden mark. On text that is already
/// [kind] it takes the style off; on text that is partly so it makes all of it
/// so; and on part of a longer bold run it takes bold off that part and leaves
/// the rest. With the cursor between words there is nothing to act on, so an
/// empty pair goes in (or comes out, if it is what the cursor is in) — the
/// editor does not use that: it keeps a typing style instead.
TextEditingValue toggleEmphasis(TextEditingValue value, EmphasisKind kind) {
  assert(kind != EmphasisKind.strike);
  final text = value.text;
  final selection = value.selection.isValid
      ? value.selection
      : TextSelection.collapsed(offset: text.length);
  final marker = _markerFor(kind);
  var start = selection.start;
  var end = selection.end;
  int? caretInWord;

  if (selection.isCollapsed) {
    // An empty pair made and changed their mind about.
    final m = marker.length;
    if (start >= m &&
        start + m <= text.length &&
        text.substring(start - m, start) == marker &&
        text.substring(start, start + m) == marker &&
        (start - m == 0 || text[start - m - 1] != marker[0]) &&
        (start + m == text.length || text[start + m] != marker[0])) {
      return _value(text.replaceRange(start - m, start + m, ''), start - m);
    }
    final word = wordAround(text, start);
    if (word == null) {
      return _value(text.replaceRange(start, start, marker * 2), start + m);
    }
    caretInWord = selection.extentOffset - word.start;
    start = word.start;
    end = word.end;
  } else {
    // What is seen: past hidden marks and spaces at either end.
    final index = EmphasisIndex.of(text);
    var settled = false;
    while (!settled) {
      settled = true;
      final before = index.runAround(start) ?? index.runAtEdge(start);
      if (before != null && start < end && start >= before.start) {
        if (start != before.end) {
          start = before.end;
          settled = false;
        }
      }
      final after = index.runAround(end) ?? index.runAtEdge(end);
      if (after != null && end > start && end <= after.end) {
        if (end != after.start) {
          end = after.start;
          settled = false;
        }
      }
      while (start < end && _isSpace(text.codeUnitAt(start))) {
        start++;
        settled = false;
      }
      while (end > start && _isSpace(text.codeUnitAt(end - 1))) {
        end--;
        settled = false;
      }
    }
    if (start >= end) return value;
  }

  final result = _emphasise(text, EmphasisIndex.of(text), start, end, kind);
  final range = result.range;
  return TextEditingValue(
    text: result.text,
    selection: caretInWord != null
        ? TextSelection.collapsed(
            offset: range.start + caretInWord.clamp(0, range.end - range.start),
          )
        : TextSelection(baseOffset: range.start, extentOffset: range.end),
  );
}

/// Bold (or italic) switched off with the cursor at the end of a run of it:
/// the cursor steps out past that run's closing marks, so what is typed next is
/// plain, and the run keeps every letter it has. Null when the cursor is not at
/// the end of a [kind] run.
///
/// It is what a reader means by tapping Bold again after typing a bold phrase.
/// Taken as "the word the cursor touches", the tap unbolded the phrase's last
/// word instead, and the next words went on in bold. Runs of other kinds the
/// cursor steps out of on the way (italic inside the bold) stay on, as
/// [keep].
({TextEditingValue value, Set<EmphasisKind> keep})? leaveRunEnd(
  TextEditingValue value,
  EmphasisKind kind,
) {
  final selection = value.selection;
  if (!selection.isValid || !selection.isCollapsed) return null;
  final text = value.text;
  if (!text.contains('*') && !text.contains('_')) return null;
  final index = EmphasisIndex.of(text);
  final passed = <EmphasisKind>{};
  var at = selection.baseOffset;
  var stepped = true;
  while (stepped) {
    stepped = false;
    for (final pair in index.pairs) {
      if (pair.close.start != at || pair.close.end <= at) continue;
      if (pair.kind == kind) {
        return (
          value: TextEditingValue(
            text: text,
            selection: TextSelection.collapsed(offset: pair.close.end),
          ),
          keep: passed,
        );
      }
      passed.add(pair.kind);
      at = pair.close.end;
      stepped = true;
      break;
    }
  }
  return null;
}

/// The letters of a pair as they are seen: its content less any hidden marks
/// of other pairs at either end (the italic in `***word***` is inside the bold,
/// and the bold's letters are still just `word`).
TextRange _seen(EmphasisIndex index, EmphasisPair pair) {
  var start = pair.content.start;
  var end = pair.content.end;
  final head = index.runAround(start);
  if (head != null) start = head.end;
  final tail = index.runAround(end);
  if (tail != null) end = tail.start;
  return TextRange(start: start, end: end);
}

({String text, TextRange range}) _emphasise(
  String text,
  EmphasisIndex index,
  int start,
  int end,
  EmphasisKind kind,
) {
  final marker = _markerFor(kind);
  final same = [
    for (final pair in index.pairs)
      if (pair.kind == kind &&
          pair.open.start <= end &&
          start <= pair.close.end)
        pair,
  ];

  String wrap(String t, int from, int to) =>
      t.replaceRange(to, to, marker).replaceRange(from, from, marker);

  if (same.isEmpty) {
    return (
      text: wrap(text, start, end),
      range: TextRange(start: start + marker.length, end: end + marker.length),
    );
  }

  if (same.length == 1) {
    final pair = same.single;
    final seen = _seen(index, pair);
    if (pair.content.start <= start && end <= pair.content.end) {
      if (start == seen.start && end == seen.end) {
        // All of it: take the style off.
        final open = pair.open.end - pair.open.start;
        final bare = text
            .replaceRange(pair.close.start, pair.close.end, '')
            .replaceRange(pair.open.start, pair.open.end, '');
        return (
          text: bare,
          range: TextRange(start: start - open, end: end - open),
        );
      }
      if (start >= seen.start && end <= seen.end) {
        // Part of it: the parts either side stay, with the spaces that end
        // them moved out of their marks.
        final openText = _markText(text, pair.open);
        final closeText = _markText(text, pair.close);
        final left = text.substring(pair.content.start, start);
        final right = text.substring(end, pair.content.end);
        String core(String s, {required bool fromEnd}) {
          var a = 0;
          var b = s.length;
          if (fromEnd) {
            while (b > 0 && _isSpace(s.codeUnitAt(b - 1))) {
              b--;
            }
          } else {
            while (a < b && _isSpace(s.codeUnitAt(a))) {
              a++;
            }
          }
          return s.substring(a, b);
        }

        final leftCore = core(left, fromEnd: true);
        final rightCore = core(right, fromEnd: false);
        final leftSpaces = left.substring(leftCore.length);
        final rightSpaces = right.substring(0, right.length - rightCore.length);
        final head = leftCore.trim().isEmpty
            ? left
            : '$openText$leftCore$closeText$leftSpaces';
        final tail = rightCore.trim().isEmpty
            ? right
            : '$rightSpaces$openText$rightCore$closeText';
        final middle = text.substring(start, end);
        final built =
            '${text.substring(0, pair.open.start)}$head$middle$tail'
            '${text.substring(pair.close.end)}';
        final from = pair.open.start + head.length;
        return (
          text: built,
          range: TextRange(start: from, end: from + middle.length),
        );
      }
    }
  }

  // Part of it already is, or it sits against a run that is: one run, whole.
  var from = start;
  var to = end;
  for (final pair in same) {
    if (pair.content.start < from) from = pair.content.start;
    if (pair.content.end > to) to = pair.content.end;
  }
  final removed = <TextRange>[
    for (final pair in same) ...[pair.open, pair.close],
  ]..sort((a, b) => a.start.compareTo(b.start));
  int shifted(int offset) {
    var gone = 0;
    for (final range in removed) {
      if (range.start < offset) {
        gone += (range.end < offset ? range.end : offset) - range.start;
      }
    }
    return offset - gone;
  }

  var bare = text;
  for (final range in removed.reversed) {
    bare = bare.replaceRange(range.start, range.end, '');
  }
  final a = shifted(from);
  final b = shifted(to);
  return (
    text: wrap(bare, a, b),
    range: TextRange(start: a + marker.length, end: b + marker.length),
  );
}
