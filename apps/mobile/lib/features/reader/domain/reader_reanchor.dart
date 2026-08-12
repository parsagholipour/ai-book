import 'reader_annotation.dart';
import 'reader_annotation_geometry.dart';
import 'reader_page_locator.dart';

/// One page of a rendered book, as much of it as re-anchoring needs.
///
/// An interface rather than a `PdfPage` so the algorithm can be exercised
/// without PDFium, which is not available under `flutter test`.
abstract interface class ReanchorPage {
  /// The page's extracted text, as the PDF reports it.
  String get fullText;

  /// One rectangle per line covered by the half-open character range, in page
  /// fractions.
  List<NormRect> rectsForRange(int start, int end);
}

/// Loads a page's text, or null when it cannot be read.
typedef ReanchorPageLoader = Future<ReanchorPage?> Function(int pageNumber);

/// What a re-anchoring pass did.
class ReanchorResult {
  const ReanchorResult({
    required this.annotations,
    required this.moved,
    required this.orphaned,
    required this.carried,
  });

  final List<ReaderAnnotation> annotations;

  /// Passages found again, on the same page or a different one.
  final int moved;

  /// Passages that are no longer anywhere in the book.
  final int orphaned;

  /// Ink and placed text, which has no text to search for and stays where it
  /// was drawn.
  final int carried;

  bool get changed => moved > 0 || orphaned > 0 || carried > 0;
}

/// Shortest passage worth searching for. Below this a match says more about how
/// common the word is than about where the reader's highlight belongs.
const _minimumNeedle = 4;

/// Follows a book's markup into a newly compiled edition.
///
/// Editing a book recompiles the PDF, and the new file paginates differently:
/// a paragraph that was halfway down page 12 can end up at the top of page 13.
/// Bookmarks live with that by admitting they are approximate, but a highlight
/// cannot — drawn over the wrong words it is worse than useless.
///
/// So anything that recorded the text it was made against goes looking for that
/// text again. The search starts on the page the annotation used to be on and
/// works outwards, because repagination shifts things by a page or two, not
/// across the book; that keeps the common case to a handful of page reads
/// instead of one per page. A passage that has genuinely been rewritten away is
/// marked orphaned rather than deleted — it is still the reader's note, and
/// only they should decide it is gone.
///
/// Ink and placed text have no text to find. They keep their coordinates and
/// are reported as [ReanchorResult.carried] so the reader can be told they came
/// from an earlier version.
/// [isCancelled] stops the pass where it stands — the reader closed the book —
/// and answers null so the caller writes nothing. A pass that ran to the end
/// against a document that turned out to be unreadable answers null too: see
/// [_readAnyPage].
Future<ReanchorResult?> reanchorAnnotations({
  required List<ReaderAnnotation> annotations,
  required int pageCount,
  required int revision,
  required ReanchorPageLoader loadPage,
  bool Function()? isCancelled,
  int searchRadius = 3,
  int maxPagesScanned = 40,
}) async {
  final cache = <int, ReanchorPage?>{};
  // Whether any page of this document yielded text. A disposed document — the
  // reader left while the pass ran — answers every page with nothing rather
  // than failing, and reading that as "the words are gone" is how closing the
  // book orphaned all of its markup, with the new revision stamped on so
  // nothing ever looked again.
  var readAnyText = false;
  Future<ReanchorPage?> pageAt(int number) async {
    if (number < 1 || number > pageCount) {
      return null;
    }
    if (cache.containsKey(number)) {
      return cache[number];
    }
    final page = await loadPage(number);
    // An empty page is not a page: a passage cannot be looked for in it, and a
    // whole document of them is a document that is no longer there.
    final usable = page != null && page.fullText.isNotEmpty ? page : null;
    if (usable != null) readAnyText = true;
    return cache[number] = usable;
  }

  final updated = <ReaderAnnotation>[];
  var moved = 0;
  var orphaned = 0;
  var carried = 0;

  /// Orphans that came from a search coming up empty, rather than from a page
  /// the shorter book no longer has. Only these can be a lie told by a document
  /// that has gone away.
  var orphanedBySearch = 0;

  // Walked in page order so the outward searches of neighbouring annotations
  // hit the same cached pages.
  final ordered = [...annotations]..sort((a, b) => a.page.compareTo(b.page));

  for (final annotation in ordered) {
    if (isCancelled?.call() ?? false) {
      return null;
    }
    if (annotation.isDeleted || !annotation.isStaleFor(revision)) {
      updated.add(annotation);
      continue;
    }

    final quote = annotation.quote;
    final needle = quote == null
        ? ''
        : ReaderPageLocator.normalizeForMatch(quote);

    if (needle.length < _minimumNeedle) {
      // Nothing to search for. Ink and placed text keep their position; a
      // passage-anchored annotation whose page no longer exists cannot.
      final fits = annotation.page <= pageCount;
      updated.add(
        annotation.withAnchoring(revision: revision, orphaned: !fits),
      );
      if (fits) {
        carried++;
      } else {
        orphaned++;
      }
      continue;
    }

    final hit = await _findPassage(
      needle: needle,
      startPage: annotation.page,
      pageCount: pageCount,
      searchRadius: searchRadius,
      maxPagesScanned: maxPagesScanned,
      pageAt: pageAt,
    );

    if (hit == null) {
      // Given the new revision even though it was not found, so the next open
      // does not scan the whole book again for a passage that has been
      // rewritten. A later edit changes the revision again and re-tries it.
      updated.add(annotation.withAnchoring(revision: revision, orphaned: true));
      orphaned++;
      orphanedBySearch++;
      continue;
    }

    updated.add(
      annotation.withAnchoring(
        page: hit.page,
        revision: revision,
        rects: hit.rects,
        orphaned: false,
      ),
    );
    moved++;
  }

  // A search that found nothing anywhere, in a document that yielded no text
  // anywhere, is the document being gone rather than the book being rewritten.
  // The whole pass stands down together — ink and placed text are stamped with
  // the new revision in the same write, so half-landing would be worse.
  if (orphanedBySearch > 0 && !readAnyText) {
    return null;
  }

  updated.sort(_byPageThenCreation);
  return ReanchorResult(
    annotations: updated,
    moved: moved,
    orphaned: orphaned,
    carried: carried,
  );
}

class _PassageHit {
  const _PassageHit({required this.page, required this.rects});

  final int page;
  final List<NormRect> rects;
}

Future<_PassageHit?> _findPassage({
  required String needle,
  required int startPage,
  required int pageCount,
  required int searchRadius,
  required int maxPagesScanned,
  required Future<ReanchorPage?> Function(int) pageAt,
}) async {
  var scanned = 0;
  for (final page in _searchOrder(startPage, pageCount, searchRadius)) {
    if (scanned >= maxPagesScanned) {
      return null;
    }
    scanned++;
    final text = await pageAt(page);
    if (text == null) {
      continue;
    }
    final normalized = ReaderPageLocator.normalize(text.fullText);
    final range = normalized.sourceRangeOf(needle);
    if (range == null) {
      continue;
    }
    final rects = text.rectsForRange(range.start, range.end);
    if (rects.isEmpty) {
      continue;
    }
    return _PassageHit(page: page, rects: rects);
  }
  return null;
}

/// Pages to try, nearest to [startPage] first.
///
/// The near pages come first as a pair at a time — 12, 11, 13, 10, 14 — so a
/// paragraph that moved one page either way is found on the second or third
/// read. Once the radius is exhausted the rest of the book follows in order,
/// for the rarer case of a passage that moved a whole chapter.
Iterable<int> _searchOrder(int startPage, int pageCount, int radius) sync* {
  final seen = <int>{};

  bool inRange(int page) => page >= 1 && page <= pageCount;

  if (inRange(startPage) && seen.add(startPage)) {
    yield startPage;
  }
  for (var offset = 1; offset <= radius; offset++) {
    for (final page in [startPage - offset, startPage + offset]) {
      if (inRange(page) && seen.add(page)) {
        yield page;
      }
    }
  }
  for (var page = 1; page <= pageCount; page++) {
    if (seen.add(page)) {
      yield page;
    }
  }
}

int _byPageThenCreation(ReaderAnnotation a, ReaderAnnotation b) {
  final byPage = a.page.compareTo(b.page);
  return byPage != 0 ? byPage : a.createdAt.compareTo(b.createdAt);
}
