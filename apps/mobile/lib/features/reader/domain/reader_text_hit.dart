import 'package:pdfrx/pdfrx.dart';

/// A character in a rendered page's extracted text.
///
/// Ordered the way the book reads — page first, then position on the page — so
/// two of these are all it takes to say which way a selection is being dragged
/// and which end of it is moving.
class ReaderTextHit implements Comparable<ReaderTextHit> {
  const ReaderTextHit(this.pageNumber, this.index);

  /// The PDF page number. The first page is 1.
  final int pageNumber;

  /// The character's index in that page's `fullText`.
  final int index;

  @override
  int compareTo(ReaderTextHit other) {
    if (pageNumber != other.pageNumber) {
      return pageNumber.compareTo(other.pageNumber);
    }
    return index.compareTo(other.index);
  }

  @override
  bool operator ==(Object other) =>
      other is ReaderTextHit &&
      other.pageNumber == pageNumber &&
      other.index == index;

  @override
  int get hashCode => Object.hash(pageNumber, index);

  @override
  String toString() => 'ReaderTextHit($pageNumber:$index)';
}

/// The character at [point] on a page, or null when the point is nowhere near
/// one.
///
/// [point] is in PDF page coordinates. The character whose box holds it wins;
/// failing that the nearest one within [margin] page points does. The margin is
/// what makes a finger resting between two lines resolve to the end of one
/// rather than to nothing, and answering null for anything further away is the
/// honest result for a finger in the margin or over an illustration — the
/// alternative is a selection that leaps to whichever words happen to be
/// furthest away.
///
/// This is deliberately the same rule pdfrx applies to its own handle drags, so
/// dragging a handle and dragging from a long press pick the same character.
/// The fragment box is tested first because a book page carries a few thousand
/// characters and this runs on every move the finger makes.
int? readerCharIndexAt(PdfPageText text, PdfPoint point, {double margin = 8}) {
  var nearestDistance = double.infinity;
  int? nearest;
  for (final fragment in text.fragments) {
    if (!fragment.bounds.containsPoint(point, margin: margin)) {
      continue;
    }
    final count = fragment.charRects.length < fragment.length
        ? fragment.charRects.length
        : fragment.length;
    for (var i = 0; i < count; i++) {
      final rect = fragment.charRects[i];
      if (rect.containsPoint(point)) {
        return fragment.index + i;
      }
      final distance = rect.distanceSquaredTo(point);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = fragment.index + i;
      }
    }
  }
  if (nearest != null && nearestDistance <= margin * margin) {
    return nearest;
  }
  return null;
}

/// The whole word around [index], as an inclusive character range.
///
/// A word here is one of pdfrx's text fragments, which is what its own
/// long-press pick uses — the formatter emits one fragment per word. Sharing
/// that notion is what keeps a drag agreeing with the word the press landed on
/// instead of quietly re-cutting it.
({int start, int end})? readerWordAt(PdfPageText text, int index) {
  final fragment = text.getFragmentForTextIndex(index);
  if (fragment == null || fragment.length <= 0) {
    return null;
  }
  return (start: fragment.index, end: fragment.end - 1);
}

/// The word a *press* should anchor to, which is never a blank one.
///
/// pdfrx emits a fragment for every run of spaces and for every line break, so
/// "the word here" can be a gap a couple of millimetres wide — and a finger is
/// not. A passage of nothing but whitespace is worse than nothing: it collapses
/// to an empty string, so no action bar opens and the press reads as having
/// done nothing at all. A press carries no direction to inherit, so the word
/// after the gap is preferred and the one before it is the fallback, which is
/// what makes a press past the end of a line take the last word on it.
///
/// The moving end of a drag deliberately does not do this — see [readerWordAt].
/// There the gap is a real place to stop, the finger is heading somewhere, and
/// stopping mid-space for one frame is finer-grained rather than wrong.
({int start, int end})? readerAnchorWordAt(PdfPageText text, int index) {
  final word = _wordFrom(text, index, 1) ?? _wordFrom(text, index, -1);
  if (word == null) {
    return null;
  }
  return (start: word.index, end: word.end - 1);
}

/// The first fragment at or beyond [index] with something in it, walking one
/// fragment at a time in the direction of [step].
PdfPageTextFragment? _wordFrom(PdfPageText text, int index, int step) {
  var fragment = text.getFragmentForTextIndex(index);
  // Bounded by the page's own fragment count. Each hop lands strictly outside
  // the fragment it came from, but a page whose fragments do not tile its text
  // must not be able to spin the gesture.
  var hops = text.fragments.length;
  while (fragment != null && fragment.text.trim().isEmpty && hops-- > 0) {
    final next = step > 0 ? fragment.end : fragment.index - 1;
    if (next < 0 || next >= text.charRects.length) {
      return null;
    }
    fragment = text.getFragmentForTextIndex(next);
  }
  if (fragment == null ||
      fragment.length <= 0 ||
      fragment.text.trim().isEmpty) {
    return null;
  }
  return fragment;
}

/// Where the two ends of the selection sit once the finger has reached the word
/// running from [movingStart] to [movingEnd].
///
/// The word the press landed on is never given up: dragging forward keeps its
/// first character and moves the last, dragging back keeps its last and moves
/// the first. That is what makes the gesture feel anchored to the place it
/// started rather than like two handles being pushed around, and it is why a
/// finger that wanders back over the starting word leaves exactly that word
/// selected instead of collapsing the selection to nothing.
({ReaderTextHit start, ReaderTextHit end}) readerDragSelection({
  required ReaderTextHit anchorStart,
  required ReaderTextHit anchorEnd,
  required ReaderTextHit movingStart,
  required ReaderTextHit movingEnd,
}) {
  if (movingStart.compareTo(anchorEnd) > 0) {
    return (start: anchorStart, end: movingEnd);
  }
  if (movingEnd.compareTo(anchorStart) < 0) {
    return (start: movingStart, end: anchorEnd);
  }
  return (start: anchorStart, end: anchorEnd);
}
