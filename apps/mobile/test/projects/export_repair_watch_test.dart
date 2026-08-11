import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/export_repair_watch.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

/// Runs the budget the way the status stream does — one call per status seen,
/// three seconds of clock between polls — and reports how many polls it allowed
/// before it stood down.
int _pollsAllowed(
  ExportRepairWatchBudget budget,
  _FakeClock clock,
  MobileProjectStatus status, {
  int limit = 500,
}) {
  var polls = 0;
  while (polls < limit) {
    if (!budget.shouldKeepWatching(status)) return polls;
    polls += 1;
    clock.advance(const Duration(seconds: 3));
  }
  return polls;
}

void main() {
  group('ExportRepairWatchBudget', () {
    test('watches a settled book whose PDF is missing', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      expect(
        budget.shouldKeepWatching(_status('complete', pdfAvailable: false)),
        isTrue,
      );
      expect(budget.isWatching, isTrue);
    });

    test('stops as soon as the repair lands', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      budget.shouldKeepWatching(_status('complete', pdfAvailable: false));
      expect(
        budget.shouldKeepWatching(_status('complete', pdfAvailable: true)),
        isFalse,
      );
      expect(budget.isWatching, isFalse);
    });

    test('a review_required book is repairable too', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      expect(
        budget.shouldKeepWatching(
          _status('review_required', pdfAvailable: false),
        ),
        isTrue,
      );
    });

    test('a missing EPUB alone does not hold the stream open', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      expect(
        budget.shouldKeepWatching(
          _status('complete', pdfAvailable: true, epubAvailable: false),
        ),
        isFalse,
      );
    });

    test('a requested EPUB is watched until it lands', () {
      // The reported failure: the EPUB download answered `EXPORT_NOT_READY`
      // — which queues the repair — and nothing ever looked again, because the
      // watch stood down the moment the PDF was on disk. The button stayed
      // "Preparing EPUB" over a file that had landed seconds later.
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missingEpub = _status(
        'complete',
        pdfAvailable: true,
        epubAvailable: false,
      );

      budget.noteExportRequested(ExportRepairFormat.epub);
      expect(budget.shouldKeepWatching(missingEpub), isTrue);
      expect(budget.isAwaitingEpub, isTrue);

      expect(
        budget.shouldKeepWatching(
          _status('complete', pdfAvailable: true, epubAvailable: true),
        ),
        isFalse,
      );
      expect(budget.isWatching, isFalse);
      // The wait is over, so a later status must not re-open it: only a fresh
      // refusal from the download route may.
      expect(budget.isAwaitingEpub, isFalse);
      expect(budget.shouldKeepWatching(missingEpub), isFalse);
    });

    test('a requested EPUB is metered by the same window', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missingEpub = _status(
        'complete',
        pdfAvailable: true,
        epubAvailable: false,
      );

      budget.noteExportRequested(ExportRepairFormat.epub);
      expect(_pollsAllowed(budget, clock, missingEpub), 40);
      expect(budget.hasGivenUp, isTrue);

      // And the cooldown is served before the server's window is asked again.
      clock.advance(exportRepairWatchCooldown - const Duration(seconds: 1));
      expect(budget.shouldKeepWatching(missingEpub), isFalse);
      clock.advance(const Duration(seconds: 1));
      expect(budget.shouldKeepWatching(missingEpub), isTrue);
    });

    test('a book missing both files is one wait, not two', () {
      // Both formats share the window: a compile publishes both, so waiting for
      // the pair may not cost twice the polling — or twice the repairs.
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      budget.noteExportRequested(ExportRepairFormat.epub);
      expect(
        _pollsAllowed(
          budget,
          clock,
          _status('complete', pdfAvailable: false, epubAvailable: false),
        ),
        40,
      );
      expect(budget.hasGivenUp, isTrue);
    });

    test('asking for the PDF adds nothing: it is always watched', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      budget.noteExportRequested(ExportRepairFormat.pdf);
      expect(budget.isAwaitingEpub, isFalse);
      // A book with both files is finished business whoever asked for what.
      expect(
        budget.shouldKeepWatching(
          _status('complete', pdfAvailable: true, epubAvailable: true),
        ),
        isFalse,
      );
      expect(
        budget.shouldKeepWatching(_status('complete', pdfAvailable: false)),
        isTrue,
      );
    });

    test('an EPUB deleted while the PDF wait is spent starts a new one', () {
      // The same rule the PDF has, on the format that reaches the download
      // route at all: the button is only tappable while the app believes the
      // file is there, so a refusal means it went missing under the reader —
      // a rebuild, not the wait this budget already gave up on.
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      _pollsAllowed(
        budget,
        clock,
        _status('complete', pdfAvailable: false, epubAvailable: true),
      );
      expect(budget.hasGivenUp, isTrue);

      // The reader taps Open EPUB, is refused, and the next status shows the
      // compile has taken that file away too.
      budget.noteExportRequested(ExportRepairFormat.epub);
      expect(
        _pollsAllowed(
          budget,
          clock,
          _status('complete', pdfAvailable: false, epubAvailable: false),
        ),
        40,
      );
    });

    test('a live book is always watched, and is never metered', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missing = _status('complete', pdfAvailable: false);

      _pollsAllowed(budget, clock, missing);
      expect(budget.hasGivenUp, isTrue);

      // The reader edits the book: it goes back to EDITING, and the wait that
      // follows is a new one.
      expect(
        budget.shouldKeepWatching(_status('editing', pdfAvailable: false)),
        isTrue,
      );
      expect(budget.hasGivenUp, isFalse);
      expect(_pollsAllowed(budget, clock, missing), 40);
    });

    test(
      'a repair that never lands stops polling once the window runs out',
      () {
        // The reported failure: a permanently failed repair kept the shared
        // status watcher polling every three seconds forever, and because the
        // server's repair keys roll every five minutes, each roll bought
        // another full Chromium compile of the same manuscript.
        final clock = _FakeClock();
        final budget = ExportRepairWatchBudget(clock: clock.now);

        // Two minutes at the status stream's three-second poll.
        expect(
          _pollsAllowed(
            budget,
            clock,
            _status('complete', pdfAvailable: false),
          ),
          40,
        );
        expect(budget.hasGivenUp, isTrue);
      },
    );

    test('stays stopped for the whole cooldown', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missing = _status('complete', pdfAvailable: false);
      _pollsAllowed(budget, clock, missing);

      // Anything short of the cooldown gets nothing — including the moment the
      // server's own five-minute repair window would otherwise have rolled.
      clock.advance(exportRepairWatchCooldown - const Duration(seconds: 1));
      expect(budget.shouldKeepWatching(missing), isFalse);
    });

    test('opens a fresh window once the cooldown is over', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missing = _status('complete', pdfAvailable: false);
      _pollsAllowed(budget, clock, missing);

      clock.advance(exportRepairWatchCooldown);
      expect(_pollsAllowed(budget, clock, missing), 40);
    });

    test('an edit that deletes a present PDF gets the whole allowance', () {
      // A failing EPUB is not the only way to reach the cooldown, so a genuine
      // rebuild must not be charged for the previous wait: the file was on disk
      // a moment ago, and the compile that removed it is one the server queued.
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missing = _status('complete', pdfAvailable: false);
      _pollsAllowed(budget, clock, missing);
      expect(budget.hasGivenUp, isTrue);

      budget.shouldKeepWatching(_status('complete', pdfAvailable: true));
      expect(_pollsAllowed(budget, clock, missing), 40);
    });

    test('a clock corrected backwards mid-wait still closes the window', () {
      // The device clock is not monotonic: an NTP sync after a cold boot or a
      // hand-set date can move it under a wait in progress. An unclamped
      // difference goes negative, and the window then never runs out — which is
      // the unbounded poll this budget exists to stop, restored by an hour.
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missing = _status('complete', pdfAvailable: false);

      expect(budget.shouldKeepWatching(missing), isTrue);
      clock.advance(const Duration(hours: -1));
      expect(budget.shouldKeepWatching(missing), isTrue);

      // The wait restarts from the corrected reading rather than running for
      // the hour the clock moved.
      expect(_pollsAllowed(budget, clock, missing), 40);
      expect(budget.hasGivenUp, isTrue);
    });

    test('a clock corrected backwards mid-cooldown still expires it', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final missing = _status('complete', pdfAvailable: false);
      _pollsAllowed(budget, clock, missing);

      clock.advance(const Duration(hours: -1));
      expect(budget.shouldKeepWatching(missing), isFalse);

      // One more cooldown from the corrected reading, not an hour of silence.
      clock.advance(exportRepairWatchCooldown);
      expect(budget.shouldKeepWatching(missing), isTrue);
    });

    test('a failed book is not watched at all', () {
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);

      expect(
        budget.shouldKeepWatching(_status('failed', pdfAvailable: false)),
        isFalse,
      );
    });
  });
}

class _FakeClock {
  DateTime _now = DateTime.utc(2026, 8, 10, 12);

  DateTime now() => _now;

  void advance(Duration delta) => _now = _now.add(delta);
}

MobileProjectStatus _status(
  String status, {
  required bool pdfAvailable,
  bool epubAvailable = false,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: status,
    progressPercent: 100,
    currentAction: 'Your book is ready.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 10, target: 10),
    imageCount: 0,
    exports: MobileExportSet(
      pdf: _export('pdf', pdfAvailable),
      epub: _export('epub', epubAvailable),
    ),
    updatedAt: DateTime.utc(2026, 8, 10),
  );
}

MobileExportAvailability _export(String format, bool available) {
  return MobileExportAvailability(
    format: format,
    available: available,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/$format',
    filename: 'book.$format',
    contentType: format == 'pdf' ? 'application/pdf' : 'application/epub+zip',
  );
}
