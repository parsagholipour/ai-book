import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/data/export_repair_watch.dart';
import 'package:tomeza/features/projects/data/projects_repository.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

void main() {
  for (final settledStatus in const ['complete', 'review_required']) {
    test(
      'status watching polls until a missing PDF is repaired for $settledStatus',
      () async {
        final repository = _RepairingProjectsRepository(
          streamed: _status(settledStatus, pdfAvailable: false),
          polled: _status(settledStatus, pdfAvailable: true),
        );
        final container = ProviderContainer(
          overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        final repaired = Completer<MobileProjectStatus>();

        final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
          projectStatusProvider('project-1'),
          (_, next) {
            final status = next.asData?.value;
            if (status?.exports.pdf.available == true &&
                !repaired.isCompleted) {
              repaired.complete(status);
            }
          },
          fireImmediately: true,
        );
        addTearDown(subscription.close);

        await repaired.future.timeout(const Duration(seconds: 1));

        expect(repository.pollCalls, 1);
      },
    );
  }

  test(
    'a settled book with its PDF does not poll only for a missing EPUB',
    () async {
      final repository = _RepairingProjectsRepository(
        streamed: _status('complete', pdfAvailable: true),
        polled: _status('complete', pdfAvailable: true, epubAvailable: true),
      );
      final container = ProviderContainer(
        overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      final settled = Completer<void>();

      final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
        projectStatusProvider('project-1'),
        (_, next) {
          if (next.asData?.value.exports.pdf.available == true &&
              !settled.isCompleted) {
            settled.complete();
          }
        },
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      await settled.future.timeout(const Duration(seconds: 1));
      await Future<void>.delayed(Duration.zero);

      expect(repository.pollCalls, 0);
    },
  );

  test('a requested EPUB is watched through the same shared flow', () async {
    // The EPUB download answers `EXPORT_NOT_READY` and queues its own repair,
    // but the button that reaches that route is disabled for as long as the
    // file is missing — so unless the shared watch picks the wait up, nothing
    // ever sees it land and the surface stays on "Preparing EPUB".
    final repository = _RepairingProjectsRepository(
      streamed: _status('complete', pdfAvailable: true, epubAvailable: false),
      polled: _status('complete', pdfAvailable: true, epubAvailable: true),
    );
    final container = ProviderContainer(
      overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);
    container
        .read(exportRepairWatchProvider('project-1'))
        .noteExportRequested(ExportRepairFormat.epub);
    final repaired = Completer<MobileProjectStatus>();

    final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
      projectStatusProvider('project-1'),
      (_, next) {
        final status = next.asData?.value;
        if (status?.exports.epub.available == true && !repaired.isCompleted) {
          repaired.complete(status);
        }
      },
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await repaired.future.timeout(const Duration(seconds: 1));
    // The listener runs on the yield; the watch decides on the turn after it.
    await _settle();

    expect(repository.pollCalls, 1);
    expect(
      container.read(exportRepairWatchProvider('project-1')).isAwaitingEpub,
      isFalse,
      reason: 'the file landed, so the wait it was asked to keep is over',
    );
  });

  test('a requested EPUB that never lands is bounded like any other', () async {
    // Asking for a file is not a licence to poll for it: an EPUB whose
    // conversion keeps failing has to stand down on the same window, or every
    // refusal would buy a compile per five-minute server window forever.
    final missingEpub = _status(
      'complete',
      pdfAvailable: true,
      epubAvailable: false,
    );
    final repository = _RepairingProjectsRepository(
      streamed: missingEpub,
      polled: missingEpub,
    );
    final clock = _FakeClock();
    final budget = ExportRepairWatchBudget(clock: clock.now);
    final container = ProviderContainer(
      overrides: [
        projectsRepositoryProvider.overrideWithValue(repository),
        exportRepairWatchProvider.overrideWith((ref, id) => budget),
      ],
    );
    addTearDown(container.dispose);
    budget.noteExportRequested(ExportRepairFormat.epub);

    final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
      projectStatusProvider('project-1'),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await _settle();
    expect(repository.pollCalls, 1);

    clock.advance(const Duration(minutes: 3));
    for (var refresh = 0; refresh < 10; refresh += 1) {
      container.invalidate(projectStatusProvider('project-1'));
      container.read(projectStatusProvider('project-1'));
      await _settle();
    }

    expect(repository.pollCalls, 1);
    // Standing down still leaves every refresh with a status to draw from.
    expect(
      container.read(projectStatusProvider('project-1')).asData?.value,
      isNotNull,
    );
  });

  test(
    'a repair that never lands cannot be handed a fresh watch by refreshes',
    () async {
      // The reported failure. The saved-export card refreshes the shared status
      // provider every four seconds, the reader re-checks on open, the book
      // screen on every edit — and each of those rebuilds the provider. While
      // the watch lived inside that stream, every refresh started a new
      // unbounded three-second poll loop, so a permanently failing repair kept
      // asking for a compile for as long as the screen was open. The card's own
      // two-minute allowance bounds the card, not the provider it invalidates.
      final missing = _status('complete', pdfAvailable: false);
      final repository = _RepairingProjectsRepository(
        streamed: missing,
        polled: missing,
      );
      final clock = _FakeClock();
      final budget = ExportRepairWatchBudget(clock: clock.now);
      final container = ProviderContainer(
        overrides: [
          projectsRepositoryProvider.overrideWithValue(repository),
          exportRepairWatchProvider.overrideWith((ref, id) => budget),
        ],
      );
      addTearDown(container.dispose);

      final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
        projectStatusProvider('project-1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      await _settle();
      expect(repository.pollCalls, 1);

      // The wait outlives its window: the repair is never coming.
      clock.advance(const Duration(minutes: 3));

      for (var refresh = 0; refresh < 10; refresh += 1) {
        container.invalidate(projectStatusProvider('project-1'));
        container.read(projectStatusProvider('project-1'));
        await _settle();
      }

      expect(repository.pollCalls, 1);
      // Standing down bounds the polling, not the screen: every one of those
      // refreshes still read a status, so nothing that watches this provider is
      // left on a spinner.
      expect(
        container.read(projectStatusProvider('project-1')).asData?.value,
        isNotNull,
      );
    },
  );

  test('one budget per project outlives the provider it bounds', () async {
    // The whole fix rests on this: `projectStatusProvider` is autoDispose and
    // is rebuilt constantly — every card refresh, every reader open, every
    // edit — so a budget owned by the stream is handed back in full several
    // times a minute. Making `exportRepairWatchProvider` autoDispose, or
    // moving the budget back into the stream, restores the unbounded poll with
    // every other test in this file still green.
    final missing = _status('complete', pdfAvailable: false);
    final repository = _RepairingProjectsRepository(
      streamed: missing,
      polled: missing,
    );
    final container = ProviderContainer(
      overrides: [projectsRepositoryProvider.overrideWithValue(repository)],
    );
    addTearDown(container.dispose);

    final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
      projectStatusProvider('project-1'),
      (_, _) {},
      fireImmediately: true,
    );
    await _settle();
    final budget = container.read(exportRepairWatchProvider('project-1'));

    container.invalidate(projectStatusProvider('project-1'));
    container.read(projectStatusProvider('project-1'));
    await _settle();
    expect(
      container.read(exportRepairWatchProvider('project-1')),
      same(budget),
      reason: 'a refresh must not hand back the allowance',
    );

    // The reader leaves the screen entirely: the status provider auto-disposes,
    // and coming back must not be a way to buy another window either.
    subscription.close();
    await _settle();
    expect(
      container.read(exportRepairWatchProvider('project-1')),
      same(budget),
      reason: 'leaving and returning must not hand back the allowance',
    );

    expect(
      container.read(exportRepairWatchProvider('project-2')),
      isNot(same(budget)),
      reason: 'one book standing down says nothing about another',
    );
  });

  test(
    'a status stream that never closes is bounded by the same window',
    () async {
      // The SSE route closes as soon as a book is settled, but a proxy holding
      // the connection open, or an older API build, leaves the stream half of
      // `_watchProjectStatus` yielding a settled book with no PDF forever — and
      // the server re-reads the project on every one of those ticks, which is
      // what queues the repair. Metering by wall clock rather than by poll count
      // is what bounds this path too.
      final clock = _FakeClock();
      final repository = _EndlessStreamProjectsRepository(
        status: _status('complete', pdfAvailable: false),
        onEmit: () => clock.advance(const Duration(seconds: 3)),
      );
      final container = ProviderContainer(
        overrides: [
          projectsRepositoryProvider.overrideWithValue(repository),
          exportRepairWatchProvider.overrideWith(
            (ref, id) => ExportRepairWatchBudget(clock: clock.now),
          ),
        ],
      );
      addTearDown(container.dispose);

      final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
        projectStatusProvider('project-1'),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      await _settle(_EndlessStreamProjectsRepository.limit * 2);

      // Two minutes of stream at three seconds a tick, and then it stops: the
      // first tick opens the window, the tick at two minutes closes it.
      expect(repository.emitted, 41);
      expect(
        repository.emitted,
        lessThan(_EndlessStreamProjectsRepository.limit),
      );
      expect(repository.pollCalls, 0);
    },
  );

  test('the watch resumes once the give-up cooldown is over', () async {
    // Standing down is not giving up on the book: the server's repair window
    // rolls, so a reader still on the screen — or back on it — gets another
    // attempt, just not one per poll.
    final missing = _status('complete', pdfAvailable: false);
    final repository = _RepairingProjectsRepository(
      streamed: missing,
      polled: missing,
    );
    final clock = _FakeClock();
    final budget = ExportRepairWatchBudget(clock: clock.now);
    final container = ProviderContainer(
      overrides: [
        projectsRepositoryProvider.overrideWithValue(repository),
        exportRepairWatchProvider.overrideWith((ref, id) => budget),
      ],
    );
    addTearDown(container.dispose);

    final subscription = container.listen<AsyncValue<MobileProjectStatus>>(
      projectStatusProvider('project-1'),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);

    await _settle();
    clock.advance(const Duration(minutes: 3));
    container.invalidate(projectStatusProvider('project-1'));
    container.read(projectStatusProvider('project-1'));
    await _settle();
    expect(repository.pollCalls, 1);

    clock.advance(exportRepairWatchCooldown);
    container.invalidate(projectStatusProvider('project-1'));
    container.read(projectStatusProvider('project-1'));
    await _settle();

    expect(repository.pollCalls, 2);
  });
}

/// Lets the stream's own microtasks run without letting its three-second poll
/// timer fire — real time is never advanced here.
Future<void> _settle([int turns = 8]) async {
  for (var turn = 0; turn < turns; turn += 1) {
    await Future<void>.delayed(Duration.zero);
  }
}

class _FakeClock {
  DateTime _now = DateTime.utc(2026, 8, 10, 12);

  DateTime now() => _now;

  void advance(Duration delta) => _now = _now.add(delta);
}

/// A status stream the server never closes, so the watch has to end it. Capped
/// so a regression fails the expectation instead of hanging the suite.
class _EndlessStreamProjectsRepository implements ProjectsRepository {
  _EndlessStreamProjectsRepository({
    required this.status,
    required this.onEmit,
  });

  static const limit = 400;

  final MobileProjectStatus status;
  final void Function() onEmit;
  int emitted = 0;
  int pollCalls = 0;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    while (emitted < limit) {
      emitted += 1;
      yield status;
      // Time only passes once the watcher has seen the tick, which is the order
      // a one-second-apart SSE stream arrives in.
      onEmit();
    }
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    pollCalls += 1;
    return status;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

class _RepairingProjectsRepository implements ProjectsRepository {
  _RepairingProjectsRepository({required this.streamed, required this.polled});

  final MobileProjectStatus streamed;
  final MobileProjectStatus polled;
  int pollCalls = 0;

  @override
  Stream<MobileProjectStatus> watchProjectStatus(String id) async* {
    yield streamed;
  }

  @override
  Future<MobileProjectStatus> getProjectStatus(String id) async {
    pollCalls += 1;
    return polled;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    throw UnimplementedError('Not used in this test.');
  }
}

MobileProjectStatus _status(
  String status, {
  required bool pdfAvailable,
  bool epubAvailable = false,
}) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: status,
    statusLabel: status == 'review_required' ? 'Review needed' : 'Complete',
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
