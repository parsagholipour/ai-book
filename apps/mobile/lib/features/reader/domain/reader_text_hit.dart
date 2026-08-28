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
/// That null is the only thing a *press* has to decline with, which is why this
/// entry point never reaches past the margin. Every numbered sheet this app
/// prints carries "Page n" in its bottom margin — the `@bottom-center` rule in
/// `packages/core/src/generation/pdfCss.ts`, which only `@page pdf-cover` and
/// `@page pdf-title` opt out of with `content: none` — so a page that is
/// nothing but a full-page illustration still has extractable text on it, and
/// "no words near the finger" and "no words on the page" are different
/// questions. Only the first of them refuses here; the cover, whose sheet is
/// one `<img>` and no footer, is the one place both answer the same way. A
/// press that resolved anyway would fire the long-press haptic, set the range
/// and leave the reader holding a Copy/Highlight bar over the words "Page 12":
/// `_anchorNear` in `presentation/reader_selection_drag.dart` starts its
/// selection from whatever this answers and has nothing else to stop on.
///
/// A drag wants the opposite answer and asks [readerDragCharIndexAt] instead —
/// the same split as [readerAnchorWordAt] and [readerWordAt], with the
/// qualified name on whichever of the pair is the one that deviates.
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

/// The character a *drag* is reaching for, which is a laxer question than
/// [readerCharIndexAt]'s and deliberately so.
///
/// A finger already holding a selection has said what it wants; all that is
/// left to settle is how much of it. So the margin answers first — the fast
/// path, and what nearly every move hits, since the finger is usually already
/// on or near a glyph — and when nothing is that close [_nearestCharByLine]
/// takes over with the nearest line, then the nearest character on that line.
/// That is what carries a drag past the last word of a short line — a page's
/// final line, more often than not — instead of stopping a word short of it,
/// which reads as the selection being broken rather than careful.
///
/// One margin cannot serve both callers: it would have to be narrow enough that
/// a press on a picture does not reach the footer under it and wide enough that
/// a drag can run a finger's width past the end of a line, and a finger is
/// wider than the gap the press has to refuse. Two entry points is what lets
/// each of them keep the rule it needs; [margin] is only the width of the fast
/// path, and widening it here would loosen the press as well.
int? readerDragCharIndexAt(
  PdfPageText text,
  PdfPoint point, {
  double margin = 8,
}) {
  return readerCharIndexAt(text, point, margin: margin) ??
      _nearestCharByLine(text, point, minimumReach: margin);
}

/// How far a drag may reach for a line, in multiples of that line's own height.
///
/// Measured in the line's own band rather than in points because the book is
/// typeset at a different size per script and the running footer is smaller
/// again, so a fixed number of points would be two lines on one page and half a
/// line on another. Two and a half bands clears the leading between two lines of
/// body type several times over — the gap the fallback exists to bridge — and is
/// nowhere near enough to cross a picture, which is the other half of the job: a
/// finger parked in the middle of a full-page illustration sits hundreds of
/// points above the "Page n" footer that is the only text on the sheet, so the
/// drag resolves to nothing there and the selection stands still at the last
/// word it reached — which is exactly what `extendTo` in
/// `presentation/reader_selection_drag.dart` says happens over an illustration.
const _dragLineReach = 2.5;

/// [readerDragCharIndexAt]'s fallback once nothing is within its margin: the
/// nearest line within [_dragLineReach] of the point, then the nearest
/// character on it.
///
/// A page's fragments are word-granularity — pdfrx lays out one per word and
/// one per run of spaces, never a whole line — so "the nearest line" is
/// reconstructed rather than looked up. What makes that possible is that the
/// formatter writes the *line's* own bounding box into every character box it
/// emits for that line (`PdfRect(r.left, bounds.top, r.right, bounds.bottom)`
/// in `PdfTextFormatter.addWord`), so a fragment's band is its line's band to
/// the bit, and two fragments are on one line exactly when their bands are
/// equal. Whichever band is nearest [point]'s Y is the line; the fragments
/// carrying that same band are the words on it. Clamping to that line's first
/// or last character once X is past either end is what lets a drag past a
/// short line's final word — a page's last line, more often than not — take
/// the whole word instead of stopping one short of it.
///
/// A line here is pdfrx's, which is finer than a printed one: a markdown
/// table's cells are separate lines, and so is either side of a direction
/// change inside one. That is the right grain to hold a drag to — a cell is
/// where a finger dragging inside a cell is asking to stay.
///
/// Two lines can be equally near, because two bands can hold the point's Y at
/// once. The nearer middle settles that, rather than whichever band
/// `text.fragments` happens to offer first: fragment order is emission order,
/// and on a page with a table that is not top to bottom.
///
/// Only the vertical search is bounded. Horizontally the whole line is fair
/// game: a finger sweeping down the outer margin of a page is asking for the
/// lines it is passing, which is what dragging does everywhere else on the
/// device. It is the vertical distance that tells a neighbouring line apart
/// from the far side of a picture, so that is the one with a ceiling on it.
int? _nearestCharByLine(
  PdfPageText text,
  PdfPoint point, {
  required double minimumReach,
}) {
  double? lineTop;
  double? lineBottom;
  var nearestLineDistance = double.infinity;
  var nearestLineCentreDistance = double.infinity;
  for (final fragment in text.fragments) {
    if (fragment.length <= 0) {
      continue;
    }
    final bounds = fragment.bounds;
    final distance = point.y > bounds.top
        ? point.y - bounds.top
        : point.y < bounds.bottom
        ? bounds.bottom - point.y
        : 0.0;
    final centreDistance = (point.y - (bounds.top + bounds.bottom) / 2).abs();
    if (distance > nearestLineDistance ||
        (distance == nearestLineDistance &&
            centreDistance >= nearestLineCentreDistance)) {
      continue;
    }
    nearestLineDistance = distance;
    nearestLineCentreDistance = centreDistance;
    lineTop = bounds.top;
    lineBottom = bounds.bottom;
  }
  final top = lineTop;
  final bottom = lineBottom;
  if (top == null || bottom == null) {
    return null;
  }
  // A band PDFium reported with no height at all must not be able to switch the
  // fallback off, so the press's own margin is the floor under the multiple.
  final scaledReach = (top - bottom) * _dragLineReach;
  final reach = scaledReach > minimumReach ? scaledReach : minimumReach;
  if (nearestLineDistance > reach) {
    return null;
  }
  // The band the first loop settled on, both of its edges — not everything
  // whose vertical extent happens to touch it. Since every fragment on a line
  // carries that line's own bounds, matching top and bottom together is asking
  // which line a fragment is on. The hair of tolerance is slack against a
  // formatter that one day measures each word for itself; it cannot let a
  // neighbouring line in, whose edges sit a line apart rather than a fraction
  // of a point.
  //
  // This was an overlap test — admit anything whose band reaches into the
  // chosen one — and a table is what that cost. Cells wrap to different depths
  // and are aligned as blocks, so a short cell's line lands staggered half a
  // line off from its neighbour's, and two staggered bands then overlap by a
  // point or so: [614.41, 624.21] against [605.48, 616.00] on one shipped
  // book's comparison table. This function is only reached when the finger is
  // further than the margin from every glyph, and inside a table that is easy
  // to be — the air past one cell's text is a whole column wide. From
  // (253.7, 624.2), 110 points right of "Deities/Entities" and 8 above
  // "caboclos, crianças," on the line under it, the overlap admitted the
  // staggered line, whose glyphs span that X, so it won outright at horizontal
  // distance 0 and the drag swallowed everything between the two.
  const lineTolerance = 0.5;
  int? nearest;
  var nearestDistance = double.infinity;
  for (final fragment in text.fragments) {
    final bounds = fragment.bounds;
    if ((bounds.top - top).abs() > lineTolerance ||
        (bounds.bottom - bottom).abs() > lineTolerance) {
      continue;
    }
    final count = fragment.charRects.length < fragment.length
        ? fragment.charRects.length
        : fragment.length;
    for (var i = 0; i < count; i++) {
      final rect = fragment.charRects[i];
      final distance = point.x > rect.right
          ? point.x - rect.right
          : point.x < rect.left
          ? rect.left - point.x
          : 0.0;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = fragment.index + i;
      }
    }
  }
  return nearest;
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
