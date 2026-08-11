import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_controller.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';

import 'audiobook_fakes.dart';

/// Replacing a narration while its predecessor is still downloading.
///
/// The download loop lives across awaits, so a re-narration can land in the
/// middle of it. A stale loop must walk away — the one observed failure mode
/// was the old narration's audio being queued under the new timeline.
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
    tempDir = Directory.systemTemp.createTempSync('tomeza-race-test');
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

  testWidgets('a download loop overtaken by a new narration abandons '
      'instead of queueing the old audio', (tester) async {
    // Park the first narration's download mid-await.
    final gate = cache.audioGate = Completer<void>();
    final container = await pumpScreen(tester);
    expect(player.tracks, isEmpty);

    // Replace the narration while that download is still in flight.
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    await container
        .read(audiobookControllerProvider('project-1').notifier)
        .narrate(voice: 'Zephyr', replace: true);
    await settle(tester);

    gate.complete();
    await settle(tester);

    // Only the new narration's audio reaches the queue; the stale loop's
    // chapter was fetched but never queued, never became the player.
    expect(player.tracks, hasLength(2));
    expect(
      player.tracks.map((track) => track.id),
      everyElement(startsWith('audiobook-2:')),
    );
    final state = container.read(audiobookControllerProvider('project-1'));
    expect(state.downloadedChapters, {1, 2});
  });

  testWidgets('disposing mid cover-art await never builds a player', (
    tester,
  ) async {
    final container = audiobookContainer(
      repository: repository,
      cache: cache,
      player: player,
      progress: progress,
    );
    activeContainer = container;
    final subscription = container.listen(
      audiobookControllerProvider('project-1'),
      (_, _) {},
    );
    final controller = container.read(
      audiobookControllerProvider('project-1').notifier,
    );
    // A cover URL is what makes the loop await the art fetch at all.
    controller.attachBookDetails(title: 'Tides', coverUrl: '/covers/1.png');
    final gate = cache.coverGate = Completer<void>();
    await settle(tester);

    // The chapter is fetched and the loop is parked on the cover art.
    expect(cache.downloadedAudio, isNotEmpty);
    expect(player.tracks, isEmpty);

    subscription.close();
    disposeActive();
    gate.complete();
    await settle(tester);

    // No player was created for a screen that no longer exists — nothing
    // would ever have disposed it.
    expect(player.tracks, isEmpty);
  });
}
