import 'dart:async';

import 'package:tomeza/features/sharing/data/book_share_repository.dart';
import 'package:tomeza/features/sharing/domain/book_remix.dart';
import 'package:tomeza/features/sharing/domain/book_share_models.dart';

const shareSlug = 'abc123XYZ789';
const shareUrl = 'https://tomeza.test/s/abc123XYZ789';

/// The format a share of "The Lighthouse Cat", a 24-page short story, hands
/// to a new chat.
BookRemix lighthouseCat({String? bookTypeChoice}) =>
    BookRemix.fromJson('abc123', {
      'title': 'The Lighthouse Cat',
      'presets': {
        'bookType': 'short_story',
        'bookTypeChoice': ?bookTypeChoice,
        'lengthPreset': 'standard',
        'qualityPreset': 'premium',
        'coverEnabled': true,
        'illustrationsEnabled': false,
        'pageCountMode': 'custom',
        'targetPages': 24,
        'pageCountSource': 'settings',
      },
    });

/// The server's view of a book: 24 reading pages unless told otherwise, so
/// the preview cap is 12.
BookShareBook shareBook({
  bool shareable = true,
  BookShareUnavailableReason? unavailableReason,
  int readingPages = 24,
  bool likenessRequired = false,
}) {
  return BookShareBook(
    shareable: shareable,
    unavailableReason: unavailableReason,
    readingPages: readingPages,
    maxPreviewPages: readingPages ~/ 2 < 1 ? 1 : readingPages ~/ 2,
    likenessRequired: likenessRequired,
  );
}

BookShare bookShare({
  BookShareMode mode = BookShareMode.preview,
  int? previewPages = 6,
  String? caption,
  BookShareCaptionStatus? captionStatus,
  bool showAuthorName = false,
  bool likenessConfirmed = false,
  BookShareStatus status = BookShareStatus.active,
  String? takedownReason,
  String? stoppedReason,
  int viewCount = 3,
}) {
  return BookShare(
    slug: shareSlug,
    url: shareUrl,
    mode: mode,
    previewPages: mode == BookShareMode.preview ? previewPages : null,
    caption: caption,
    captionStatus:
        captionStatus ??
        (caption == null
            ? BookShareCaptionStatus.none
            : BookShareCaptionStatus.allowed),
    showAuthorName: showAuthorName,
    likenessConfirmed: status == BookShareStatus.active && likenessConfirmed,
    status: status,
    takedownReason: takedownReason,
    stoppedReason: stoppedReason,
    viewCount: viewCount,
  );
}

/// A scripted share server: records what the sheet asked for, and answers a
/// save with the share that request describes unless a test says otherwise.
class FakeBookShareRepository implements BookShareRepository {
  FakeBookShareRepository({
    BookShareSnapshot? snapshot,
    this.remix,
    this.remixError,
  }) : snapshot = snapshot ?? BookShareSnapshot(book: shareBook());

  BookShareSnapshot snapshot;
  final saves = <BookShareRequest>[];
  int stops = 0;
  final remixSlugs = <String>[];
  BookRemix? remix;
  Object? remixError;

  /// Holds a save until completed, so a test can see the sheet mid-save.
  Completer<void>? saveGate;

  /// Thrown by the next save, once.
  Object? saveError;

  /// The note status the server gives a note a save sends.
  BookShareCaptionStatus captionVerdict = BookShareCaptionStatus.allowed;

  @override
  Future<BookShareSnapshot> loadShare(String projectId) async => snapshot;

  @override
  Future<BookShareSnapshot> saveShare(
    String projectId,
    BookShareRequest request,
  ) async {
    saves.add(request);
    await saveGate?.future;
    final error = saveError;
    if (error != null) {
      saveError = null;
      throw error;
    }
    final note = request.caption?.trim();
    final hasNote = note != null && note.isNotEmpty;
    final live = snapshot.activeShare;
    snapshot = BookShareSnapshot(
      share: bookShare(
        mode: request.mode,
        previewPages: request.previewPages,
        caption: hasNote ? note : null,
        captionStatus: hasNote ? captionVerdict : BookShareCaptionStatus.none,
        showAuthorName: request.showAuthorName,
        // Recorded when this request confirms it, kept while the share
        // stays live; a stopped share's confirmation is not carried over.
        likenessConfirmed:
            snapshot.book.likenessRequired &&
            (request.likenessConfirmed || (live?.likenessConfirmed ?? false)),
        viewCount: snapshot.share?.viewCount ?? 0,
      ),
      book: snapshot.book,
    );
    return snapshot;
  }

  @override
  Future<BookShareSnapshot> stopSharing(String projectId) async {
    stops++;
    final share = snapshot.share;
    snapshot = BookShareSnapshot(
      book: snapshot.book,
      share: share == null
          ? null
          : bookShare(
              mode: share.mode,
              previewPages: share.previewPages,
              caption: share.caption,
              captionStatus: share.captionStatus,
              showAuthorName: share.showAuthorName,
              status: BookShareStatus.revoked,
            ),
    );
    return snapshot;
  }

  @override
  Future<BookRemix> loadRemix(String slug) async {
    remixSlugs.add(slug);
    final error = remixError;
    if (error != null) throw error;
    return remix!;
  }
}
