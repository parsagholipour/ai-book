/// A book's public link, as `/api/mobile/projects/:id/share` describes it.
///
/// One book has at most one share, updated in place. A share that was stopped
/// is still returned (`revoked`) so the sheet can offer its old settings back;
/// one an operator removed (`takenDown`) can never be shared again.
library;

import 'dart:math' as math;

enum BookShareMode {
  preview,
  full;

  String get wire => this == BookShareMode.full ? 'full' : 'preview';

  static BookShareMode fromWire(Object? value) =>
      value == 'full' ? BookShareMode.full : BookShareMode.preview;
}

/// What happened to the author's note. The server moderates a changed note
/// before it is shown; a note it could not decide on is held for a person.
enum BookShareCaptionStatus {
  none,
  allowed,
  pendingReview,
  removed;

  static BookShareCaptionStatus fromWire(Object? value) => switch (value) {
    'allowed' => BookShareCaptionStatus.allowed,
    'pending_review' => BookShareCaptionStatus.pendingReview,
    'removed' => BookShareCaptionStatus.removed,
    _ => BookShareCaptionStatus.none,
  };
}

enum BookShareStatus {
  active,
  revoked,
  takenDown;

  static BookShareStatus fromWire(Object? value) => switch (value) {
    'active' => BookShareStatus.active,
    'taken_down' => BookShareStatus.takenDown,
    _ => BookShareStatus.revoked,
  };
}

/// Why a book cannot be shared right now, when it cannot.
enum BookShareUnavailableReason {
  /// Never finished: nothing has been compiled to share.
  notFinished,

  /// Finished, but an edit's rebuild has taken its PDF away for a moment.
  beingUpdated;

  static BookShareUnavailableReason? fromWire(Object? value) => switch (value) {
    'not_finished' => BookShareUnavailableReason.notFinished,
    'being_updated' => BookShareUnavailableReason.beingUpdated,
    _ => null,
  };
}

class BookShare {
  const BookShare({
    required this.slug,
    required this.url,
    required this.mode,
    required this.status,
    this.previewPages,
    this.caption,
    this.captionStatus = BookShareCaptionStatus.none,
    this.showAuthorName = false,
    this.likenessConfirmed = false,
    this.takedownReason,
    this.viewCount = 0,
    this.createdAt,
    this.updatedAt,
  });

  final String slug;
  final String url;
  final BookShareMode mode;
  final BookShareStatus status;

  /// How many reading pages a preview shows; null for a full share.
  final int? previewPages;
  final String? caption;
  final BookShareCaptionStatus captionStatus;
  final bool showAuthorName;

  /// A live share whose "drawn from a real photo" confirmation is on record,
  /// so changing it does not ask again. Always false for a stopped share: a
  /// re-share asks the question afresh.
  final bool likenessConfirmed;

  /// The operator's sentence, only while [status] is taken down.
  final String? takedownReason;
  final int viewCount;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  bool get isActive => status == BookShareStatus.active;
  bool get isTakenDown => status == BookShareStatus.takenDown;

  factory BookShare.fromJson(Map<String, dynamic> json) {
    return BookShare(
      slug: json['slug'] as String,
      url: json['url'] as String,
      mode: BookShareMode.fromWire(json['mode']),
      status: BookShareStatus.fromWire(json['status']),
      previewPages: (json['previewPages'] as num?)?.toInt(),
      caption: json['caption'] as String?,
      captionStatus: BookShareCaptionStatus.fromWire(json['captionStatus']),
      showAuthorName: json['showAuthorName'] as bool? ?? false,
      likenessConfirmed: json['likenessConfirmed'] as bool? ?? false,
      takedownReason: json['takedownReason'] as String?,
      viewCount: (json['viewCount'] as num?)?.toInt() ?? 0,
      createdAt: DateTime.tryParse(json['createdAt'] as String? ?? ''),
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? ''),
    );
  }
}

/// What the server knows about the book behind a share.
class BookShareBook {
  const BookShareBook({
    required this.shareable,
    this.unavailableReason,
    this.kind = 'generated',
    this.readingPages,
    this.maxPreviewPages,
    this.likenessRequired = false,
    this.exportUnlocked = false,
    this.exportUnlockCredits = 0,
  });

  /// Whether a share can be made or changed right now.
  final bool shareable;
  final BookShareUnavailableReason? unavailableReason;

  /// `generated` or `written` (a Writing Studio book).
  final String kind;

  /// M in "N of M pages": reading pages, front matter excluded.
  final int? readingPages;

  /// The preview cap: half the reading pages, at least one. It is the whole
  /// reason a preview is free — a 29-of-30 preview would be the book.
  final int? maxPreviewPages;

  /// The book features someone drawn from a real photo, so a share has to
  /// be confirmed with that in mind.
  final bool likenessRequired;

  /// The book's PDF unlock, which a full share needs, is already bought.
  final bool exportUnlocked;

  /// The live unlock price; 0 once the book is unlocked.
  final int exportUnlockCredits;

  /// The preview cap the stepper runs to. A shareable book always has one;
  /// the floor keeps a stale answer from producing an empty range.
  int get previewCap => math.max(1, maxPreviewPages ?? 1);

  factory BookShareBook.fromJson(Map<String, dynamic> json) {
    return BookShareBook(
      shareable: json['shareable'] as bool? ?? false,
      unavailableReason: BookShareUnavailableReason.fromWire(
        json['unavailableReason'],
      ),
      kind: json['kind'] as String? ?? 'generated',
      readingPages: (json['readingPages'] as num?)?.toInt(),
      maxPreviewPages: (json['maxPreviewPages'] as num?)?.toInt(),
      likenessRequired: json['likenessRequired'] as bool? ?? false,
      exportUnlocked: json['exportUnlocked'] as bool? ?? false,
      exportUnlockCredits: (json['exportUnlockCredits'] as num?)?.toInt() ?? 0,
    );
  }
}

/// One read of a book's sharing: the share (if there ever was one) and the
/// book it points at.
class BookShareSnapshot {
  const BookShareSnapshot({required this.book, this.share});

  final BookShare? share;
  final BookShareBook book;

  /// The share that is live now, if any.
  BookShare? get activeShare => (share?.isActive ?? false) ? share : null;

  bool get takenDown => share?.isTakenDown ?? false;

  factory BookShareSnapshot.fromJson(Map<String, dynamic> json) {
    final share = json['share'];
    return BookShareSnapshot(
      share: share is Map<String, dynamic> ? BookShare.fromJson(share) : null,
      book: BookShareBook.fromJson(json['book'] as Map<String, dynamic>),
    );
  }
}

/// What a save answered: the new state, and whether it spent the unlock.
class BookShareSaved {
  const BookShareSaved({
    required this.snapshot,
    this.exportUnlockCharged = false,
  });

  final BookShareSnapshot snapshot;
  final bool exportUnlockCharged;

  factory BookShareSaved.fromJson(Map<String, dynamic> json) {
    return BookShareSaved(
      snapshot: BookShareSnapshot.fromJson(json),
      exportUnlockCharged: json['exportUnlockCharged'] as bool? ?? false,
    );
  }
}

/// The body of `PUT /api/mobile/projects/:id/share`.
class BookShareRequest {
  const BookShareRequest({
    required this.mode,
    this.previewPages,
    this.caption,
    this.showAuthorName = false,
    this.rightsConfirmed = false,
    this.likenessConfirmed = false,
    this.acceptExportUnlock = false,
  });

  final BookShareMode mode;
  final int? previewPages;

  /// Null or blank clears the note. The server trims.
  final String? caption;
  final bool showAuthorName;
  final bool rightsConfirmed;
  final bool likenessConfirmed;

  /// The author's yes to the unlock price, for a full share of a locked book.
  final bool acceptExportUnlock;

  /// This request, sent after the author agreed to the unlock price.
  BookShareRequest withUnlockAccepted() => BookShareRequest(
    mode: mode,
    previewPages: previewPages,
    caption: caption,
    showAuthorName: showAuthorName,
    rightsConfirmed: rightsConfirmed,
    likenessConfirmed: likenessConfirmed,
    acceptExportUnlock: true,
  );

  Map<String, dynamic> toJson() {
    final note = caption?.trim();
    return {
      'mode': mode.wire,
      if (mode == BookShareMode.preview) 'previewPages': ?previewPages,
      'caption': (note == null || note.isEmpty) ? null : note,
      'showAuthorName': showAuthorName,
      'rightsConfirmed': rightsConfirmed,
      'likenessConfirmed': likenessConfirmed,
      'acceptExportUnlock': acceptExportUnlock,
    };
  }
}

/// The longest note the server keeps, counted after trimming.
const bookShareCaptionMaxChars = 500;

/// "Shared · Preview 6 of 24" or "Shared · Full book".
String bookShareSummary(BookShare share, BookShareBook book) {
  if (share.mode == BookShareMode.full) {
    return 'Shared · Full book';
  }
  final shown = share.previewPages ?? 0;
  final total = book.readingPages;
  return total == null
      ? 'Shared · Preview ${bookSharePageCount(shown)}'
      : 'Shared · Preview $shown of $total';
}

String bookSharePageCount(int pages) => pages == 1 ? '1 page' : '$pages pages';

String bookShareViewCount(int views) => views == 1 ? '1 view' : '$views views';
