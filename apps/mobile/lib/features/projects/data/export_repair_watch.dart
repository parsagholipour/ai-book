import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/project_status_models.dart';

/// How long one "preparing" episode may keep re-reading the status, and how
/// long the app stands down once it has.
///
/// A settled book with a compiled file missing is a repair the server has to
/// run, and the only surface that can ask for one is the status read itself —
/// so watching a missing file is what queues the rebuild. That makes the watch
/// a *cost*: the
/// server collapses repairs into a five-minute window, and every window a
/// watcher is still awake for buys another full Chromium compile of the same
/// manuscript. A repair that keeps failing therefore has to be bounded on the
/// client, because nothing about it settles on its own.
///
/// Two minutes of watching, then five minutes of silence: one "preparing"
/// episode queues one repair, and a book whose compile is permanently broken
/// costs at most one compile per cooldown instead of one every time its
/// dedupe window rolls. Recovery is preserved on both ends — the ordinary
/// repair lands in seconds, and a wait that outlives the window is picked up
/// again by the next episode.
const exportRepairWatchWindow = Duration(minutes: 2);
const exportRepairWatchCooldown = Duration(minutes: 5);

/// A compiled file the watch can be waiting for.
///
/// The wire name is `MobileExportAvailability.format`, which is what every
/// surface holds. Parsing answers null for anything else, so a format a newer
/// API invents cannot register a wait nothing here would ever satisfy.
enum ExportRepairFormat {
  pdf,
  epub;

  static ExportRepairFormat? fromFormat(String format) => switch (format) {
    'pdf' => ExportRepairFormat.pdf,
    'epub' => ExportRepairFormat.epub,
    _ => null,
  };
}

/// Decides whether the status stream keeps watching, for one project.
///
/// It is deliberately *shared* and outlives `projectStatusProvider`. That
/// provider is `autoDispose` and is invalidated constantly — the saved-export
/// card refreshes every four seconds while a file is missing, the reader
/// re-checks on open, the book screen on every edit — and each invalidation
/// builds a brand new stream. A budget owned by the stream would therefore be
/// handed back in full several times a minute, which is exactly the shape of
/// the bug: a card that gives up after two minutes could not stop a poll loop
/// that started over on every one of its own refreshes.
///
/// Call [shouldKeepWatching] once per status the stream yields; it is what
/// notices a wait ending, a new wait starting, and the window running out.
/// Call [noteExportRequested] when a download is refused as not-ready, which is
/// the only way the EPUB — a file no screen holds a listener open for — becomes
/// something this watch is waiting on.
class ExportRepairWatchBudget {
  /// The clock defaults to [DateTime.timestamp] — UTC, not local time. Both
  /// durations here are measured as the difference between two readings, and a
  /// DST change or a flight moves local time by an hour underneath one: forward
  /// ends a wait early, backward makes the window never expire, which is the
  /// unbounded poll this class exists to stop.
  ExportRepairWatchBudget({
    this.watchWindow = exportRepairWatchWindow,
    this.cooldown = exportRepairWatchCooldown,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.timestamp;

  /// How long one episode may keep the status stream alive.
  final Duration watchWindow;

  /// How long after giving up before a new episode may start.
  final Duration cooldown;

  final DateTime Function() _clock;

  DateTime? _watchStartedAt;
  DateTime? _gaveUpAt;
  bool? _pdfWasAvailable;
  bool? _epubWasAvailable;
  bool _epubRequested = false;

  /// Whether an episode is currently running.
  @visibleForTesting
  bool get isWatching => _watchStartedAt != null;

  /// Whether the last episode ran out and the cooldown is being served.
  @visibleForTesting
  bool get hasGivenUp => _gaveUpAt != null;

  /// Whether a surface has asked for the EPUB and has not been given one yet.
  @visibleForTesting
  bool get isAwaitingEpub => _epubRequested;

  /// Records that a surface asked the server for [format] and was answered
  /// `EXPORT_NOT_READY` — the file is missing and a repair has been queued for
  /// it, whatever the status the app is holding still says.
  ///
  /// The PDF needs no asking: a settled book without one cannot be read, opened
  /// or shared at all, so it is watched on sight. The EPUB is the format this
  /// exists for. It is a companion file — a book whose PDF is on disk is a
  /// finished, usable book — so watching every project's missing EPUB would buy
  /// a whole Chromium compile per cooldown for a file nobody is waiting for.
  /// A download that answered `EXPORT_NOT_READY` is exactly the signal that
  /// somebody *is*: only then does the EPUB join the wait, and only until it
  /// lands.
  void noteExportRequested(ExportRepairFormat format) {
    if (format == ExportRepairFormat.epub) {
      _epubRequested = true;
    }
  }

  /// Whether to keep the status stream open after [status].
  ///
  /// A live book is always watched: that is generation progress, it ends by
  /// itself, and a status read for a book that is not finished queues no
  /// repair. Only the settled-with-a-file-missing case is metered.
  bool shouldKeepWatching(MobileProjectStatus status) {
    final pdfAvailable = status.exports.pdf.available;
    final epubAvailable = status.exports.epub.available;
    final pdfWasAvailable = _pdfWasAvailable;
    final epubWasAvailable = _epubWasAvailable;
    _pdfWasAvailable = pdfAvailable;
    _epubWasAvailable = epubAvailable;
    // The requested file landing is the end of that wait, wherever the book is
    // in its own lifecycle. Clearing it above the live check rather than inside
    // the settled branch is what stops an EPUB that arrived during an edit from
    // still being waited for when the edit finishes.
    if (epubAvailable) {
      _epubRequested = false;
    }

    if (status.isLive) {
      // Planning, generating, editing or a scheduled retry. Whatever this book
      // is about to compile has not been waited for yet, so nothing that
      // happened before it counts against the wait that follows.
      _reset();
      return true;
    }

    // What this project is still short of. The PDF always counts; the EPUB
    // counts only once something asked for it — see [noteExportRequested].
    // Both are metered by the one window below, so a book missing both files
    // is one episode rather than two, and the format that lands first simply
    // leaves the other one waiting.
    final awaitingPdf = !pdfAvailable;
    final awaitingEpub = _epubRequested && !epubAvailable;
    if (!status.isSettled || !(awaitingPdf || awaitingEpub)) {
      _reset();
      return false;
    }

    // A file that was on disk a moment ago and is gone now is an edit's
    // rebuild, not the wait this budget may already have given up on. It gets
    // the whole allowance — this is the case the watch exists for. Either file
    // disappearing says the same thing, because one compile publishes both.
    if ((awaitingPdf && pdfWasAvailable == true) ||
        (awaitingEpub && epubWasAvailable == true)) {
      _reset();
    }

    final now = _clock();
    final gaveUpAt = _gaveUpAt;
    if (gaveUpAt != null) {
      // A mark in the future is the device clock having been corrected
      // backwards under a wait in progress (an NTP sync after a cold boot, a
      // hand-set date). Re-stamping it costs one more cooldown; trusting the
      // negative difference costs however far the clock moved — hours of
      // standing down here, and hours of three-second polling below.
      if (gaveUpAt.isAfter(now)) {
        _gaveUpAt = now;
        return false;
      }
      if (now.difference(gaveUpAt) < cooldown) {
        return false;
      }
      // The cooldown is over: the server's repair window has rolled, so a
      // fresh episode can queue a genuinely new attempt.
      _reset();
    }

    var startedAt = _watchStartedAt ??= now;
    if (startedAt.isAfter(now)) {
      startedAt = _watchStartedAt = now;
    }
    if (now.difference(startedAt) >= watchWindow) {
      _watchStartedAt = null;
      _gaveUpAt = now;
      return false;
    }
    return true;
  }

  void _reset() {
    _watchStartedAt = null;
    _gaveUpAt = null;
  }
}

/// One budget per project, shared by every listener and every rebuild.
///
/// Not `autoDispose`: leaving the screen and coming straight back must not hand
/// a failing repair a fresh two minutes, and neither must an invalidation. The
/// object is a few fields, and only projects that have actually been watched
/// get one.
final exportRepairWatchProvider =
    Provider.family<ExportRepairWatchBudget, String>(
      (ref, projectId) => ExportRepairWatchBudget(),
    );
