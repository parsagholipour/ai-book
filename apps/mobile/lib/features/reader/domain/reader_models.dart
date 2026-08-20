import '../../projects/domain/project_models.dart';

/// Whether the page map the server currently reports describes these exact
/// downloaded bytes.
///
/// The single rule behind every use of a status `hasCoverPage`: the flag comes
/// off *a* map, and may only be read for — or stamped onto — a file that map
/// was measured from. A same-revision repair can publish different PDF bytes,
/// so the digest — the exact artifact identity — is decisive. This naturally
/// preserves an EDITING project's behind map when the open file is that exact
/// older publication, without using status or a descriptor revision as a
/// proxy. Missing identity on either side describes nothing.
bool coverPageMapDescribes({
  required String? fileDigest,
  required MobilePdfPageNumbering? pageNumbering,
}) {
  if (fileDigest == null || pageNumbering == null) {
    return false;
  }
  return fileDigest == pageNumbering.pdfDigest;
}

/// Whether chrome may skip the cover sheet for the PDF currently on screen.
///
/// Cover-skip is a property of the open file, not of whichever compile status
/// is offering. [cachedHasCoverPage] is that property when the download (or a
/// later matching open) stamped it onto [CachedExport]. After publish the
/// status flag follows the new map, which would otherwise force physical
/// numbers onto a still-open version-2 PDF whose footer already skips the
/// cover — sheet 2 labeled "Page 2" while the reader is looking at "Page 1".
///
/// An unstamped cache falls back to the map in force — [coverPageMapDescribes],
/// the same predicate that decides whether the flag may be stamped at all.
/// Unknown provenance answers false; displayed numbers then stay physical.
bool displayedHasCoverPage({
  bool? cachedHasCoverPage,
  required String? renderedDigest,
  required bool? statusHasCoverPage,
  required MobilePdfPageNumbering? pageNumbering,
}) {
  if (cachedHasCoverPage != null) {
    return cachedHasCoverPage;
  }
  if (statusHasCoverPage != true) {
    return false;
  }
  return coverPageMapDescribes(
    fileDigest: renderedDigest,
    pageNumbering: pageNumbering,
  );
}

/// The number printed on a physical PDF sheet.
///
/// When [hasCoverPage] is true, sheet 1 is the cover and has no printed number;
/// sheet 2 is printed page 1. Returns null for the cover (and for invalid
/// pages). Navigation, bookmarks and `readerContext.pdfPage` stay physical.
int? printedPageForPdfPage(int pdfPage, {required bool hasCoverPage}) {
  if (pdfPage < 1) {
    return null;
  }
  if (!hasCoverPage) {
    return pdfPage;
  }
  if (pdfPage == 1) {
    return null;
  }
  return pdfPage - 1;
}

/// How many numbers the footer / Contents / chrome actually print.
int printedPageCount(int pdfPageCount, {required bool hasCoverPage}) {
  if (!hasCoverPage) {
    return pdfPageCount;
  }
  return pdfPageCount > 0 ? pdfPageCount - 1 : 0;
}

/// Label for a physical PDF sheet in reader chrome: "Cover" or "Page N".
String printedPageLabel(int pdfPage, {required bool hasCoverPage}) {
  if (hasCoverPage && pdfPage == 1) {
    return 'Cover';
  }
  final printed = printedPageForPdfPage(pdfPage, hasCoverPage: hasCoverPage);
  return 'Page ${printed ?? pdfPage}';
}

/// Scroll bubble and bottom bar: "Cover" or "Page N of M".
String printedPagePositionLabel(
  int pdfPage,
  int pdfPageCount, {
  required bool hasCoverPage,
}) {
  if (hasCoverPage && pdfPage == 1) {
    return 'Cover';
  }
  final printed =
      printedPageForPdfPage(pdfPage, hasCoverPage: hasCoverPage) ?? pdfPage;
  final total = printedPageCount(pdfPageCount, hasCoverPage: hasCoverPage);
  return 'Page $printed of $total';
}

/// The number shown in the in-app Contents column — the same figures the PDF
/// Contents reprints. Cover has no printed number.
String printedPageContentsLabel(int pdfPage, {required bool hasCoverPage}) {
  if (hasCoverPage && pdfPage == 1) {
    return 'Cover';
  }
  return '${printedPageForPdfPage(pdfPage, hasCoverPage: hasCoverPage) ?? pdfPage}';
}

/// A compiled export that has been downloaded to the device.
///
/// [digest] identifies the exact file that was fetched; [revision] separately
/// controls manuscript mapping and markup provenance.
class CachedExport {
  /// A cover-skip stamp implies exact byte identity, enforced here.
  ///
  /// [hasCoverPage] is dropped unless [digest] is present, so a pre-digest
  /// manifest can never leave a permanent numbering decision on unidentified
  /// bytes. Revision exactness is deliberately separate: unknown provenance
  /// can still report the digest of the bytes in hand, while remaining unsafe
  /// for markup re-anchoring.
  const CachedExport({
    required this.path,
    required this.revision,
    required this.byteSize,
    required this.downloadedAt,
    this.revisionIsExact = false,
    this.digest,
    bool? hasCoverPage,
  }) : hasCoverPage = digest != null ? hasCoverPage : null;

  final String path;

  /// The content revision these bytes belong to, or null when nothing could be
  /// said about them at all.
  ///
  /// Every compile of a book is published over the same URL, so the descriptor
  /// a download was started from is only a claim about what that URL held when
  /// the status was read. The response settles it instead: the server resolves
  /// the bytes it sends against the digest their publication recorded, and the
  /// revision it names is [revisionIsExact]. When it can name none — an older
  /// file that no publication recorded — the descriptor stands in, guarded by
  /// its reported size. When it reports the file as being replaced under the
  /// read, this is null: a whole readable book is still handed back and shown,
  /// but `ExportCache` writes no manifest for it, so the next open fetches
  /// again, and the reader neither re-anchors nor re-stamps its markup.
  final int? revision;

  /// Whether [revision] is the compile the server tied these exact bytes to,
  /// rather than the descriptor standing in for one. Only an exact revision may
  /// be written onto the reader's own marks in bulk — see
  /// `ReaderView._reanchorMarkup`.
  final bool revisionIsExact;

  /// [revision] when it is a fact rather than a stand-in.
  int? get exactRevision => revisionIsExact ? revision : null;

  /// sha256 of these exact downloaded bytes, as the response reported it.
  ///
  /// This is persisted even when the server cannot tie the bytes to a compile;
  /// equality with the stored map digest is the cover-numbering gate.
  final String? digest;

  /// Whether this file's footer skips the cover sheet.
  ///
  /// Stamped from the map that described these bytes when they were filed —
  /// never from a later compile's flag, and never without a matching digest.
  /// The stamp is permanent, so neither revision equality nor a descriptor
  /// stand-in may decide it: both can describe different same-revision bytes.
  ///
  /// Null on manifests written before the digest existed and on any download
  /// whose digest disagreed with the map. Chrome then falls back through the
  /// same digest predicate and otherwise keeps physical numbers.
  final bool? hasCoverPage;

  final int byteSize;
  final DateTime downloadedAt;

  CachedExport copyWith({
    String? path,
    int? revision,
    bool? revisionIsExact,
    String? digest,
    int? byteSize,
    DateTime? downloadedAt,
    bool? hasCoverPage,
  }) {
    return CachedExport(
      path: path ?? this.path,
      revision: revision ?? this.revision,
      revisionIsExact: revisionIsExact ?? this.revisionIsExact,
      digest: digest ?? this.digest,
      byteSize: byteSize ?? this.byteSize,
      downloadedAt: downloadedAt ?? this.downloadedAt,
      hasCoverPage: hasCoverPage ?? this.hasCoverPage,
    );
  }

  /// Whether this cached file still matches what the server is offering.
  ///
  /// An export that is currently unavailable (mid-recompile) never matches,
  /// but the reader deliberately keeps showing the stale file rather than
  /// blanking the page — see `BookReaderScreen`.
  ///
  /// A mismatch has to be positively established. A server that does not report
  /// a size leaves that check out rather than counting as a difference, or
  /// every open would re-download and the reader would permanently claim the
  /// book had just been edited. Bytes filed under no revision at all — a file
  /// replaced under the read, or a transfer nothing could vouch for — are the
  /// one exception: they match nothing, because the only honest thing to say
  /// about them is that a fresh copy is worth fetching.
  ///
  /// A cached file may also be *newer* than the descriptor, which is what a
  /// download answered by a compile the status read had not seen yet leaves
  /// behind. It is not stale — nothing newer is being offered — and the size
  /// the descriptor reported describes the older compile, so it is not compared
  /// against these bytes. Treating it as a miss would re-download the file the
  /// reader already has and tell them their finished book had just changed.
  bool matches(
    MobileExportAvailability export, {
    MobilePdfPageNumbering? pageNumbering,
  }) {
    final known = revision;
    if (known == null || !export.available) {
      return false;
    }
    if (known > export.revision) {
      return true;
    }
    if (known != export.revision) {
      return false;
    }
    // A map stamped for the offered revision is a stronger descriptor than
    // size. Repairs intentionally keep contentRevision, and can keep byte size
    // too, while replacing the PDF and its pagination. Missing digest on an
    // older manifest is conservative here: fetch once and learn the bytes.
    if (pageNumbering?.contentRevision == export.revision) {
      return digest != null && digest == pageNumbering!.pdfDigest;
    }
    final reported = export.byteSize;
    return reported == null || reported == byteSize;
  }

  Map<String, dynamic> toJson() {
    return {
      if (revision != null) 'revision': revision,
      'revisionIsExact': revisionIsExact,
      if (digest != null) 'digest': digest,
      'byteSize': byteSize,
      'downloadedAt': downloadedAt.toIso8601String(),
      if (hasCoverPage != null) 'hasCoverPage': hasCoverPage,
    };
  }

  /// Reads a manifest back.
  ///
  /// A manifest written before the server reported provenance carries no
  /// `revisionIsExact`, and defaults to false. A manifest written before byte
  /// identity carries no `digest`; the constructor drops any old cover stamp
  /// on it, and the cache attempts a digest promotion before numbering it.
  static CachedExport? fromJson(Map<String, dynamic> json, String path) {
    final revision = json['revision'];
    final byteSize = json['byteSize'];
    if (revision is! int || byteSize is! int) {
      return null;
    }
    final downloadedAt = DateTime.tryParse(
      json['downloadedAt'] as String? ?? '',
    );
    final hasCoverPage = json['hasCoverPage'];
    final digest = json['digest'];
    return CachedExport(
      path: path,
      revision: revision,
      revisionIsExact: json['revisionIsExact'] == true,
      digest: digest is String && digest.isNotEmpty ? digest : null,
      byteSize: byteSize,
      downloadedAt: downloadedAt ?? DateTime.fromMillisecondsSinceEpoch(0),
      hasCoverPage: hasCoverPage is bool ? hasCoverPage : null,
    );
  }
}

/// A place in the book the reader remembers.
class ReaderBookmark {
  const ReaderBookmark({
    required this.page,
    required this.createdAt,
    this.revision,
  });

  final int page;
  final DateTime createdAt;

  /// The content revision this bookmark was made against. A later recompile can
  /// repaginate the book, so a bookmark whose revision no longer matches is
  /// shown as approximate rather than silently trusted.
  final int? revision;

  /// Label shown in the saved-places list.
  ///
  /// Always computed from [page], never stored: the cover offset can flip under
  /// a bookmark when the book is recompiled, so a label written at bookmark
  /// time would drift out of step with the footer and with the numbers chat
  /// parses. Older devices persisted one; it is read back and discarded.
  String displayedLabel({required bool hasCoverPage}) =>
      printedPageLabel(page, hasCoverPage: hasCoverPage);

  /// A bookmark is exact only when both sides name the same known compile.
  ///
  /// In particular, a bookmark made by an older app with no revision and a PDF
  /// whose provenance cannot be established are both approximate — absence is
  /// not evidence that the physical page number is still current.
  bool isApproximateFor(int? currentRevision) =>
      revision == null ||
      currentRevision == null ||
      revision != currentRevision;

  Map<String, dynamic> toJson() {
    return {
      'page': page,
      'createdAt': createdAt.toIso8601String(),
      if (revision != null) 'revision': revision,
    };
  }

  static ReaderBookmark? fromJson(Map<String, dynamic> json) {
    final page = json['page'];
    if (page is! int || page < 1) {
      return null;
    }
    return ReaderBookmark(
      page: page,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      revision: json['revision'] as int?,
    );
  }
}

/// Everything the reader remembers about one book, stored on the device.
class ReaderState {
  const ReaderState({
    this.revision = 0,
    this.lastPage = 1,
    this.bookmarks = const [],
  });

  final int revision;
  final int lastPage;
  final List<ReaderBookmark> bookmarks;

  bool get isEmpty => lastPage <= 1 && bookmarks.isEmpty;

  bool hasBookmarkOn(int page) =>
      bookmarks.any((bookmark) => bookmark.page == page);

  ReaderState copyWith({
    int? revision,
    int? lastPage,
    List<ReaderBookmark>? bookmarks,
  }) {
    return ReaderState(
      revision: revision ?? this.revision,
      lastPage: lastPage ?? this.lastPage,
      bookmarks: bookmarks ?? this.bookmarks,
    );
  }

  /// Clamps remembered positions into a document of [pageCount] pages.
  ///
  /// A recompiled book can be shorter than the one the positions were recorded
  /// against, and pdfrx throws on an out-of-range page.
  ReaderState clampedTo(int pageCount) {
    if (pageCount < 1) {
      return this;
    }
    final bounded = bookmarks
        .where((bookmark) => bookmark.page <= pageCount)
        .toList(growable: false);
    return ReaderState(
      revision: revision,
      lastPage: lastPage.clamp(1, pageCount),
      bookmarks: bounded,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'revision': revision,
      'lastPage': lastPage,
      'bookmarks': bookmarks
          .map((bookmark) => bookmark.toJson())
          .toList(growable: false),
    };
  }

  factory ReaderState.fromJson(Map<String, dynamic> json) {
    final rawBookmarks = json['bookmarks'] as List<dynamic>? ?? const [];
    final bookmarks = rawBookmarks
        .whereType<Map<String, dynamic>>()
        .map(ReaderBookmark.fromJson)
        .whereType<ReaderBookmark>()
        .toList();
    bookmarks.sort((a, b) => a.page.compareTo(b.page));
    final lastPage = json['lastPage'];
    return ReaderState(
      revision: json['revision'] as int? ?? 0,
      lastPage: lastPage is int && lastPage >= 1 ? lastPage : 1,
      bookmarks: bookmarks,
    );
  }
}

/// One entry in the reader's table of contents.
class ReaderOutlineEntry {
  const ReaderOutlineEntry({
    required this.title,
    required this.depth,
    this.pageNumber,
  });

  final String title;
  final int depth;

  /// Null when the source could not resolve a destination — the entry is then
  /// shown but not tappable. Physical pdfrx page; the sheet converts it for
  /// display.
  final int? pageNumber;

  /// Title shown in the Contents sheet. Recovered outlines name a row
  /// `Page N` after the physical destination; those follow printed numbering.
  String displayedTitle({required bool hasCoverPage}) {
    final page = pageNumber;
    if (page != null && title == 'Page $page') {
      return printedPageLabel(page, hasCoverPage: hasCoverPage);
    }
    return title;
  }

  /// Trailing Contents number, or null when the row has no destination.
  String? displayedPageText({required bool hasCoverPage}) {
    final page = pageNumber;
    if (page == null) return null;
    return printedPageContentsLabel(page, hasCoverPage: hasCoverPage);
  }
}

/// A passage the reader selected, resolved against the book's pages.
class ReaderSelection {
  const ReaderSelection({
    required this.text,
    required this.pdfPageNumber,
    this.bookPageIndex,
    this.exportRevision,
    this.pdfDigest,
    this.placed = false,
    this.hasCoverPage = false,
  });

  /// The selected text, already collapsed to single spaces.
  final String text;

  /// The physical PDF page the selection started on.
  final int pdfPageNumber;

  /// The book page (`Page.index`) the passage belongs to, when it could be
  /// resolved. Null disables the actions that need to name a page.
  final int? bookPageIndex;

  /// The exact content revision of the PDF this selection was made in, when
  /// the displayed file is the currently offered one. Null means the reader
  /// is on a stale or unverified cache, where a printed page number must not
  /// be translated through the server's current map.
  final int? exportRevision;

  /// The digest of the PDF this selection was made in, and only when the page
  /// map in force was measured from those same bytes. Null means the physical
  /// sheet number below identifies nothing the server can translate.
  ///
  /// [exportRevision] cannot stand in for it. A repair republishes the same
  /// revision over a different PDF, so the revisions still agree while
  /// [pdfPageNumber] has become a sheet of a file the server's map no longer
  /// describes — see `ReaderDocumentLoader.mappedPdfDigestFor`.
  final String? pdfDigest;

  /// Whether placing the passage has finished.
  ///
  /// The menu opens the instant text is selected and the book page arrives a
  /// moment later, so a null [bookPageIndex] means "still looking" until this
  /// is set and "could not be placed" afterwards. Telling those apart is what
  /// keeps the menu from flashing a failure it has not established yet.
  final bool placed;

  /// Whether PDF sheet 1 is an unnumbered cover, from the page map that
  /// describes the PDF this selection was made in. False when that map is
  /// missing or belongs to a different compile — displayed numbers then stay
  /// physical.
  final bool hasCoverPage;

  /// How the resolved page reads in the menu and the action sheets.
  ///
  /// The page an edit will be aimed at is shown before the message is sent, so
  /// a passage placed on the wrong page is something the reader can see rather
  /// than something they discover in the proposal that comes back. The number
  /// shown is the printed page — the same one the footer and Contents count —
  /// never the internal book page index, which no reader surface displays.
  String get placementLabel {
    if (!placed) {
      return 'Finding page…';
    }
    if (hasCoverPage && pdfPageNumber == 1) {
      return 'Cover';
    }
    if (bookPageIndex == null) {
      return 'Page not identified';
    }
    return printedPageLabel(pdfPageNumber, hasCoverPage: hasCoverPage);
  }

  /// The printed page to name in a composed chat message, or null on the cover.
  int? get displayPageNumber =>
      printedPageForPdfPage(pdfPageNumber, hasCoverPage: hasCoverPage);

  /// The structured position sent with a selection-composed chat message.
  ///
  /// `pageIndex` is the book page the locator resolved — authoritative for
  /// targeting, and a model-space answer that no republication can invalidate,
  /// so it travels on its own terms.
  ///
  /// `pdfPage` is the physical PDF sheet pdfrx reported, which the server looks
  /// up through the book's page map when no index resolved. A sheet number
  /// belongs to one file, so it only goes at all when the map in force was
  /// measured from the file on screen — [pdfDigest] — and it goes *with* that
  /// digest, because the server has to make the same check against whatever
  /// has been published since this screen last read the book's status.
  Map<String, Object> get chatReaderContext {
    final revision = exportRevision;
    final digest = pdfDigest;
    return {
      'pageIndex': ?bookPageIndex,
      // The sheet and the file it is a sheet of go together or not at all.
      if (revision != null && digest != null) ...{
        'pdfPage': pdfPageNumber,
        'pdfDigest': digest,
      },
      'contentRevision': ?revision,
    };
  }

  /// The excerpt as it goes into a chat message.
  ///
  /// Long selections are truncated because the server's quoted-text extraction
  /// caps a quote at 500 characters.
  String get excerpt {
    const limit = 400;
    if (text.length <= limit) {
      return text;
    }
    return '${text.substring(0, limit).trimRight()}…';
  }
}
