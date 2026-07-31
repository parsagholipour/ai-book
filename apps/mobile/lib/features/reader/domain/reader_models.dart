import '../../projects/domain/project_models.dart';

/// A compiled export that has been downloaded to the device.
///
/// [revision] and [byteSize] come from the server's export availability and
/// together identify the exact file that was fetched, so a later open can tell
/// a usable cache hit from a book that has since been recompiled.
class CachedExport {
  const CachedExport({
    required this.path,
    required this.revision,
    required this.byteSize,
    required this.downloadedAt,
  });

  final String path;
  final int revision;
  final int byteSize;
  final DateTime downloadedAt;

  /// Whether this cached file still matches what the server is offering.
  ///
  /// An export that is currently unavailable (mid-recompile) never matches,
  /// but the reader deliberately keeps showing the stale file rather than
  /// blanking the page — see `BookReaderScreen`.
  ///
  /// A mismatch has to be positively established. A server that does not report
  /// a size leaves that check out rather than counting as a difference, or
  /// every open would re-download and the reader would permanently claim the
  /// book had just been edited.
  bool matches(MobileExportAvailability export) {
    if (!export.available || export.revision != revision) {
      return false;
    }
    final reported = export.byteSize;
    return reported == null || reported == byteSize;
  }

  Map<String, dynamic> toJson() {
    return {
      'revision': revision,
      'byteSize': byteSize,
      'downloadedAt': downloadedAt.toIso8601String(),
    };
  }

  static CachedExport? fromJson(Map<String, dynamic> json, String path) {
    final revision = json['revision'];
    final byteSize = json['byteSize'];
    if (revision is! int || byteSize is! int) {
      return null;
    }
    final downloadedAt = DateTime.tryParse(
      json['downloadedAt'] as String? ?? '',
    );
    return CachedExport(
      path: path,
      revision: revision,
      byteSize: byteSize,
      downloadedAt: downloadedAt ?? DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

/// A place in the book the reader remembers.
class ReaderBookmark {
  const ReaderBookmark({
    required this.page,
    required this.label,
    required this.createdAt,
    this.revision,
  });

  final int page;
  final String label;
  final DateTime createdAt;

  /// The content revision this bookmark was made against. A later recompile can
  /// repaginate the book, so a bookmark whose revision no longer matches is
  /// shown as approximate rather than silently trusted.
  final int? revision;

  bool isApproximateFor(int currentRevision) =>
      revision != null && revision != currentRevision;

  Map<String, dynamic> toJson() {
    return {
      'page': page,
      'label': label,
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
      label: json['label'] as String? ?? 'Page $page',
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
  /// shown but not tappable.
  final int? pageNumber;
}

/// A passage the reader selected, resolved against the book's pages.
class ReaderSelection {
  const ReaderSelection({
    required this.text,
    required this.pdfPageNumber,
    this.bookPageIndex,
    this.placed = false,
  });

  /// The selected text, already collapsed to single spaces.
  final String text;

  /// The physical PDF page the selection started on.
  final int pdfPageNumber;

  /// The book page (`Page.index`) the passage belongs to, when it could be
  /// resolved. Null disables the actions that need to name a page.
  final int? bookPageIndex;

  /// Whether placing the passage has finished.
  ///
  /// The menu opens the instant text is selected and the book page arrives a
  /// moment later, so a null [bookPageIndex] means "still looking" until this
  /// is set and "could not be placed" afterwards. Telling those apart is what
  /// keeps the menu from flashing a failure it has not established yet.
  final bool placed;

  /// How the resolved page reads in the menu and the action sheets.
  ///
  /// The page an edit will be aimed at is shown before the message is sent, so
  /// a passage placed on the wrong page is something the reader can see rather
  /// than something they discover in the proposal that comes back.
  String get placementLabel {
    if (!placed) {
      return 'Finding page…';
    }
    final index = bookPageIndex;
    return index == null ? 'Page not identified' : 'Page $index';
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
