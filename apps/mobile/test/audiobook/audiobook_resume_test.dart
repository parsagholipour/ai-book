import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/data/audiobook_progress_store.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_controller.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';

import 'audiobook_fakes.dart';

/// Coming back to a book you were half-way through.
///
/// The position is saved on the device rather than on the server, so all of
/// this is about one JSON file: when it is written, when it is trusted, and
/// when it has to be thrown away because it points into narration that no
/// longer exists.
void main() {
  late Directory tempDir;
  late FakeAudiobookPlayer player;
  late FakeAudiobookRepository repository;
  late FakeAudiobookCache cache;
  late FakeAudiobookProgressStore progress;
  ProviderContainer? activeContainer;

  void disposeActive() {
    activeContainer?.dispose();
    activeContainer = null;
  }

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-resume-test');
    player = FakeAudiobookPlayer();
    repository = FakeAudiobookRepository(
      audiobook: audiobookWith(chapters: fullyNarratedChapters()),
    );
    cache = FakeAudiobookCache(tempDir)
      ..timelinesByChapter[1] = timelineFixture()
      ..timelinesByChapter[2] = timelineFixture();
    progress = FakeAudiobookProgressStore();
  });

  tearDown(() {
    disposeActive();
    tempDir.deleteSync(recursive: true);
  });

  void savedAt(int positionMs, {String audiobookId = 'audiobook-1'}) {
    progress.positions['project-1'] = AudiobookListeningPosition(
      audiobookId: audiobookId,
      positionMs: positionMs,
      updatedAt: DateTime.now(),
    );
  }

  Future<ProviderContainer> pumpScreen(WidgetTester tester) async {
    final container = audiobookContainer(
      repository: repository,
      cache: cache,
      player: player,
      progress: progress,
    );
    activeContainer = container;
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: AudiobookScreen(projectId: 'project-1')),
      ),
    );
    await settle(tester);
    return container;
  }

  testWidgets('picks the book up where the last session stopped', (
    tester,
  ) async {
    // Two nine-second chapters, so this is three seconds into the second one —
    // a position only a book-wide timeline can resolve to a queue entry.
    savedAt(12000);
    await pumpScreen(tester);

    expect(player.seeks, hasLength(1));
    expect(player.seeks.last.index, 1);
    expect(player.seeks.last.position.inMilliseconds, 3000);

    // Silently: coming back to a book should not start it talking.
    expect(player.playing, isFalse);
  });

  testWidgets('waits for the chapter holding the position to download', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    savedAt(12000);
    final container = await pumpScreen(tester);

    // Chapter two is where they were, and it is not narrated yet. Landing them
    // at the end of chapter one instead would be a lie about where they were.
    expect(player.seeks, isEmpty);

    repository.audiobook = audiobookWith(chapters: fullyNarratedChapters());
    await container
        .read(audiobookControllerProvider('project-1').notifier)
        .retry();
    await settle(tester);

    expect(player.seeks.last.index, 1);
    expect(player.seeks.last.position.inMilliseconds, 3000);
  });

  testWidgets('play means from here, not from where the resume was going', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    savedAt(12000);
    final container = await pumpScreen(tester);

    // Pressing play while the resume is still waiting on chapter two hands the
    // position over to the listener — being yanked elsewhere moments later is
    // the one thing a play button must never do.
    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);

    repository.audiobook = audiobookWith(chapters: fullyNarratedChapters());
    await container
        .read(audiobookControllerProvider('project-1').notifier)
        .retry();
    await settle(tester);

    expect(player.seeks, isEmpty);
    expect(player.playing, isTrue);
  });

  testWidgets('a position saved against another narration is discarded', (
    tester,
  ) async {
    savedAt(12000, audiobookId: 'audiobook-0');
    await pumpScreen(tester);

    expect(player.seeks, isEmpty);
    expect(progress.cleared, contains('project-1'));
    expect(progress.positions, isEmpty);
  });

  testWidgets('a book that was finished starts again rather than at the end', (
    tester,
  ) async {
    // Eighteen seconds of book, and they stopped in the last second of it.
    savedAt(17800);
    await pumpScreen(tester);

    expect(player.seeks, isEmpty);
    expect(progress.positions, isEmpty);
  });

  testWidgets('writes the place down while playing and again on pause', (
    tester,
  ) async {
    await pumpScreen(tester);

    player.emitPosition(const Duration(milliseconds: 4000), index: 0);
    await settle(tester);
    expect(progress.positions['project-1']?.positionMs, 4000);
    expect(progress.positions['project-1']?.audiobookId, 'audiobook-1');

    // Positions arrive several times a second, so most of them are dropped.
    player.emitPosition(const Duration(milliseconds: 8000), index: 0);
    await settle(tester);
    expect(progress.positions['project-1']?.positionMs, 4000);

    // Stopping is exactly when the real position matters, so it goes down
    // whatever the throttle thinks.
    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    await tester.tap(find.byIcon(Icons.pause_rounded));
    await settle(tester);
    expect(progress.positions['project-1']?.positionMs, 8000);
  });

  testWidgets('saves the place when the listening screen goes away', (
    tester,
  ) async {
    await pumpScreen(tester);

    player.emitPosition(const Duration(milliseconds: 4000), index: 0);
    await settle(tester);
    player.emitPosition(const Duration(milliseconds: 7500), index: 0);
    await settle(tester);

    disposeActive();

    expect(progress.positions['project-1']?.positionMs, 7500);
  });

  testWidgets('a new narration forgets where the listener was', (tester) async {
    savedAt(12000);
    final container = await pumpScreen(tester);
    expect(player.seeks, hasLength(1));

    repository.audiobook = audiobookWith(chapters: fullyNarratedChapters());
    await container
        .read(audiobookControllerProvider('project-1').notifier)
        .narrate(voice: 'Zephyr', replace: true);
    await settle(tester);

    // The position is gone from the device, and nothing put the player back at
    // it — the old number points into audio that has been replaced.
    expect(progress.cleared, contains('project-1'));
    expect(progress.positions, isEmpty);
    expect(player.seeks, hasLength(1));

    // And the queue was rebuilt rather than appended to. Two chapters narrated
    // twice would otherwise be four tracks, and the position mapping reads the
    // queue by position.
    expect(player.tracks, hasLength(2));
  });
}
