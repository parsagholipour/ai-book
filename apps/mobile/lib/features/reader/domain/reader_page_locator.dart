import 'dart:math' as math;

import '../../projects/domain/project_models.dart';

/// An inclusive range of book page indexes.
///
/// A physical PDF page usually covers one to three book pages, so a span is
/// what a selection's search is narrowed to before matching.
class ReaderPageSpan {
  const ReaderPageSpan({required this.first, required this.last});

  final int first;
  final int last;

  bool contains(int index) => index >= first && index <= last;

  @override
  String toString() => 'ReaderPageSpan($first..$last)';

  @override
  bool operator ==(Object other) =>
      other is ReaderPageSpan && other.first == first && other.last == last;

  @override
  int get hashCode => Object.hash(first, last);
}

/// Resolves a passage selected in the rendered PDF back to the book page it
/// came from.
///
/// The PDF is a continuous render of the compiled Markdown, so its physical
/// pages have no relationship to `Page.index` in the database. Every reader
/// action that edits the book has to name a page, so the mapping is rebuilt
/// here by matching the selected text against each page's Markdown.
///
/// Matching is deliberately forgiving. Text extracted from a PDF differs from
/// its Markdown source in predictable ways: line wrapping becomes arbitrary
/// whitespace, hyphens are inserted at line breaks, quotes and dashes are
/// rendered as typographic variants, and Markdown syntax (`**`, `_`, `#`) never
/// appears in the output at all.
///
/// Matching the passage alone is not enough to place it. A phrase that recurs —
/// a refrain, a character's name in dialogue, a short selection — appears on
/// several pages, and picking the first would send an edit to the front of the
/// book while the reader is deep inside it. [spanForPage] fixes that by placing
/// the *rendered page* first, using text the reader never selected, so the
/// passage is then only looked for where the reader actually is.
class ReaderPageLocator {
  ReaderPageLocator(this.book)
    : _normalizedPages = book.pages
          .map(
            (page) => _NormalizedPage(
              index: page.index,
              text: normalizeForMatch('${page.title}\n${page.markdown}'),
            ),
          )
          .toList(growable: false);

  final MobileEditableBook book;
  final List<_NormalizedPage> _normalizedPages;
  final Map<int, ReaderPageSpan?> _anchorCache = {};

  late final int _lowestIndex = _normalizedPages.isEmpty
      ? 1
      : _normalizedPages.map((page) => page.index).reduce(math.min);
  late final int _highestIndex = _normalizedPages.isEmpty
      ? 1
      : _normalizedPages.map((page) => page.index).reduce(math.max);

  /// The book page a [selection] belongs to, or null when nothing matches.
  ///
  /// [within] narrows the search to the pages the rendered PDF page covers, so
  /// a passage that recurs elsewhere in the book resolves to the copy in front
  /// of the reader. Without it the earliest copy wins, which is only right when
  /// the passage happens to be unique.
  ///
  /// When a passage spans a page boundary, progressively shorter prefixes are
  /// tried so the action still lands on the page the selection started in.
  int? locate(String selection, {ReaderPageSpan? within}) {
    final needle = normalizeForMatch(selection);
    if (needle.length < _minimumNeedle) {
      return null;
    }

    final exact = _firstPageContaining(needle, within);
    if (exact != null) {
      return exact;
    }

    // A selection dragged across a page break contains text from two pages and
    // matches neither. Shrinking from the end keeps the start of the passage,
    // which is the page the reader was actually pointing at.
    var length = needle.length;
    while (length > _minimumNeedle) {
      length = (length * 3) ~/ 4;
      final prefix = needle.substring(0, length);
      final match = _firstPageContaining(prefix, within);
      if (match != null) {
        return match;
      }
    }
    return null;
  }

  /// The book pages a physical PDF page covers, or null when it cannot be
  /// placed.
  ///
  /// Memoized by [pdfPageNumber]. The locator itself is cached per project and
  /// export revision, so the memo lives exactly as long as the text it was
  /// computed from.
  ReaderPageSpan? spanForPage({
    required int pdfPageNumber,
    required String pageText,
  }) {
    return _widened(anchorSpanForPage(pdfPageNumber: pdfPageNumber, pageText: pageText));
  }

  /// The book pages a rendered page's text actually matched, unwidened.
  ///
  /// Memoized by [pdfPageNumber], and the source both [spanForPage] and any
  /// caller that needs the tighter answer read from. Seeking to a book page is
  /// the latter: the ±1 margin that keeps a selection from falling off the end
  /// of a span would send the reader to the page before the one they asked for.
  ReaderPageSpan? anchorSpanForPage({
    required int pdfPageNumber,
    required String pageText,
  }) {
    if (_anchorCache.containsKey(pdfPageNumber)) {
      return _anchorCache[pdfPageNumber];
    }
    final anchors = anchorSpanForPageText(pageText);
    _anchorCache[pdfPageNumber] = anchors;
    return anchors;
  }

  /// Places a whole rendered page in the book, or returns null when it cannot.
  ///
  /// Probes taken across the page are matched independently; only a probe that
  /// hits exactly one book page is trusted, so a passage shared with another
  /// page contributes nothing rather than dragging the answer with it. The
  /// surviving anchors are widened by a page either side, because a selection
  /// can start just above the first probe or run just past the last.
  ///
  /// Null is the safe answer and is returned generously — for the cover and the
  /// contents page, which have no prose to match, and whenever the anchors
  /// disagree badly enough that they cannot all describe one rendered page.
  /// The caller falls back to searching the whole book.
  ReaderPageSpan? spanForPageText(String pdfPageText) {
    return _widened(anchorSpanForPageText(pdfPageText));
  }

  /// The trusted anchors alone, without the page of margin [spanForPageText]
  /// adds. Null on exactly the same terms.
  ReaderPageSpan? anchorSpanForPageText(String pdfPageText) {
    final normalized = normalizeForMatch(pdfPageText);
    if (normalized.length < _minimumPageText) {
      return null;
    }

    final anchors = <int>[];
    for (final probe in _probes(normalized)) {
      final hits = _pagesContaining(probe, limit: 2);
      if (hits.length == 1) {
        anchors.add(hits.first);
      }
    }
    if (anchors.isEmpty) {
      return null;
    }

    final lowest = anchors.reduce(math.min);
    final highest = anchors.reduce(math.max);
    // Measured before widening and before clamping, so the check means "these
    // anchors disagree" rather than "this book is short".
    if (highest - lowest + 1 > _maximumAnchorSpread) {
      return null;
    }
    return ReaderPageSpan(first: lowest, last: highest);
  }

  ReaderPageSpan? _widened(ReaderPageSpan? anchors) {
    if (anchors == null) {
      return null;
    }
    return ReaderPageSpan(
      first: math.max(_lowestIndex, anchors.first - 1),
      last: math.min(_highestIndex, anchors.last + 1),
    );
  }

  /// Slices of a rendered page's text, spread from its first line to its last.
  Iterable<String> _probes(String normalized) sync* {
    final usable = normalized.length - _probeLength;
    if (usable <= 0) {
      yield normalized;
      return;
    }
    for (var probe = 0; probe < _probeCount; probe += 1) {
      final start = (usable * probe) ~/ (_probeCount - 1);
      yield normalized.substring(start, start + _probeLength);
    }
  }

  int? _firstPageContaining(String needle, [ReaderPageSpan? within]) {
    for (final page in _normalizedPages) {
      if (within != null && !within.contains(page.index)) {
        continue;
      }
      if (page.text.contains(needle)) {
        return page.index;
      }
    }
    return null;
  }

  /// Up to [limit] pages containing [needle]. Callers only need to tell "one"
  /// from "more than one", so the scan stops as soon as that is known.
  List<int> _pagesContaining(String needle, {required int limit}) {
    final matches = <int>[];
    for (final page in _normalizedPages) {
      if (page.text.contains(needle)) {
        matches.add(page.index);
        if (matches.length >= limit) {
          break;
        }
      }
    }
    return matches;
  }

  /// Shortest passage worth matching. Below this, common words collide across
  /// pages and the answer would be a coin flip.
  static const _minimumNeedle = 12;

  /// A rendered page with less text than this is furniture — the cover, the
  /// contents, a full-page illustration — and has nothing to place it by.
  static const _minimumPageText = _minimumNeedle * 2;

  /// How many probes are taken across a rendered page, and how long each is.
  /// Long enough to be unique in a book, short enough that several fit on the
  /// shortest page worth probing.
  static const _probeCount = 6;
  static const _probeLength = 60;

  /// How far apart trusted anchors may sit and still plausibly describe one
  /// rendered page. Beyond this the probes contradict each other.
  static const _maximumAnchorSpread = 5;

  /// Widens a selection into a passage long enough to place.
  ///
  /// A single word is not distinctive enough to find a page by — "the" appears
  /// everywhere — but the text around it on the same rendered page is. Taking a
  /// window of the page's own text centred on the selection keeps every reader
  /// action available no matter how little was highlighted.
  static String contextWindow(
    String pageText,
    int start,
    int end, {
    int radius = 160,
  }) {
    if (pageText.isEmpty) {
      return '';
    }
    final from = (start - radius).clamp(0, pageText.length);
    final to = (end + radius).clamp(from, pageText.length);
    return pageText.substring(from, to);
  }

  /// Reduces text to the form both sides of the comparison can agree on.
  static String normalizeForMatch(String value) => normalize(value).text;

  /// Normalizes [value] and records where each character came from.
  ///
  /// Normalizing deletes characters, collapses runs of them and expands
  /// ligatures, so a position in the result says nothing about a position in
  /// the source. Highlighting a passage found by matching needs both: the match
  /// happens in normalized space, but the rectangles have to be measured
  /// against the real extracted text. The index map is what bridges them.
  static NormalizedText normalize(String value) {
    final buffer = StringBuffer();
    final starts = <int>[];
    final ends = <int>[];
    var pendingSpace = false;
    var droppedHyphen = false;
    var lastEmitted = '';

    void emit(String text, int start, int end) {
      for (var i = 0; i < text.length; i++) {
        starts.add(start);
        ends.add(end);
      }
      buffer.write(text);
      lastEmitted = text;
    }

    // Iterated as runes rather than over `value.toLowerCase()` so every emitted
    // character can name its offset in the *original* string, which is what the
    // PDF's own text ranges are measured in.
    final iterator = value.runes.iterator;
    while (iterator.moveNext()) {
      final rune = iterator.current;
      final start = iterator.rawIndex;
      final end = start + (rune > 0xffff ? 2 : 1);
      final char = String.fromCharCode(rune).toLowerCase();

      if (_isDiscarded(rune)) {
        continue;
      }
      if (_isWhitespace(rune)) {
        // A hyphen that the renderer inserted at a line break is followed by
        // whitespace that must vanish with it, or "exam-\nple" would normalize
        // to "exam ple" and never match "example".
        if (!droppedHyphen) {
          pendingSpace = buffer.isNotEmpty;
        }
        continue;
      }
      droppedHyphen = false;

      final mapped = _foldings[char] ?? char;

      // Hyphens after a letter are dropped wherever they occur, so a word
      // broken across lines and a genuine compound normalize the same way on
      // both sides of the comparison.
      if (mapped == '-' &&
          !pendingSpace &&
          buffer.isNotEmpty &&
          _isLetter(lastEmitted)) {
        droppedHyphen = true;
        continue;
      }
      if (_foldings[char] == null && _isMarkdownSyntax(char)) {
        continue;
      }
      if (pendingSpace) {
        // The inserted space stands for whitespace that was collapsed away, so
        // it points at the character that follows rather than claiming a span
        // of its own.
        emit(' ', start, start);
        pendingSpace = false;
      }
      emit(mapped, start, end);
    }

    return NormalizedText(
      text: buffer.toString(),
      sourceStarts: starts,
      sourceEnds: ends,
    );
  }

  static bool _isLetter(String char) {
    final code = char.codeUnitAt(0);
    // Latin a-z after lowercasing, plus anything above ASCII, which covers the
    // accented and non-Latin scripts books are generated in.
    return (code >= 0x61 && code <= 0x7a) || code > 0x7f;
  }

  static bool _isWhitespace(int rune) {
    // Space, tab, newline, carriage return, non-breaking and thin spaces.
    return rune == 0x20 ||
        rune == 0x09 ||
        rune == 0x0a ||
        rune == 0x0d ||
        rune == 0xa0 ||
        rune == 0x2009 ||
        rune == 0x202f;
  }

  static bool _isDiscarded(int rune) {
    // Soft hyphen and zero-width joiners survive PDF extraction but never
    // appear in the Markdown source.
    return rune == 0xad || rune == 0x200b || rune == 0x200c || rune == 0x200d;
  }

  static bool _isMarkdownSyntax(String char) {
    return char == '*' ||
        char == '_' ||
        char == '#' ||
        char == '`' ||
        char == '~' ||
        char == '[' ||
        char == ']' ||
        char == '>' ||
        char == '\\';
  }

  /// Typographic characters the PDF renderer emits, folded back to the ASCII
  /// the Markdown source uses.
  static const _foldings = <String, String>{
    '‘': "'",
    '’': "'",
    '‚': "'",
    '“': '"',
    '”': '"',
    '„': '"',
    '–': '-',
    '—': '-',
    '−': '-',
    '…': '...',
    'ﬀ': 'ff',
    'ﬁ': 'fi',
    'ﬂ': 'fl',
    'ﬃ': 'ffi',
    'ﬄ': 'ffl',
  };
}

class _NormalizedPage {
  const _NormalizedPage({required this.index, required this.text});

  final int index;
  final String text;
}

/// Normalized text alongside the offsets it came from.
///
/// [sourceStarts] and [sourceEnds] have one entry per UTF-16 unit of [text],
/// giving the half-open range in the original string that produced it.
class NormalizedText {
  const NormalizedText({
    required this.text,
    required this.sourceStarts,
    required this.sourceEnds,
  });

  final String text;
  final List<int> sourceStarts;
  final List<int> sourceEnds;

  bool get isEmpty => text.isEmpty;

  /// Where [normalizedNeedle] sits in the original string, or null if absent.
  ///
  /// [from] resumes a scan past an earlier hit, so a passage that occurs more
  /// than once on a page can be walked rather than always resolving to the
  /// first copy.
  ({int start, int end})? sourceRangeOf(
    String normalizedNeedle, {
    int from = 0,
  }) {
    if (normalizedNeedle.isEmpty) {
      return null;
    }
    final at = text.indexOf(normalizedNeedle, from);
    if (at < 0) {
      return null;
    }
    final last = at + normalizedNeedle.length - 1;
    if (at >= sourceStarts.length || last >= sourceEnds.length) {
      return null;
    }
    return (start: sourceStarts[at], end: sourceEnds[last]);
  }
}
