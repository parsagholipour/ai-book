import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/audiobook/data/audiobook_progress_store.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_controller.dart';

import 'audiobook_fakes.dart';

void main() {
  late Directory tempDir;
  late _GatedPlayer player;
  late _GatedRepository repository;
  late FakeAudiobookCache cache;
  late _GatedProgressStore progress;
  ProviderContainer? container;
  final provider = audiobookControllerProvider('project-1');

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-refresh-test');
    player = _GatedPlayer();
    repository = _GatedRepository(
      audiobook: audiobookWith(chapters: fullyNarratedChapters()),
    );
    cache = FakeAudiobookCache(tempDir)
      ..timelinesByChapter[1] = timelineFixture()
      ..timelinesByChapter[2] = timelineFixture();
    progress = _GatedProgressStore();
  });

  tearDown(() {
    container?.dispose();
    tempDir.deleteSync(recursive: true);
  });

  Future<AudiobookController> start(WidgetTester tester) async {
    container = audiobookContainer(
      repository: repository,
      cache: cache,
      player: player,
      progress: progress,
    );
    container!.listen(provider, (_, _) {});
    await settle(tester);
    return container!.read(provider.notifier);
  }

  testWidgets('refresh replaces queued audio and forgets the old position', (
    tester,
  ) async {
    final controller = await start(tester);
    expect(player.tracks, hasLength(2));
    await controller.togglePlay();
    player.emitPosition(const Duration(milliseconds: 4000), index: 1);
    await settle(tester);
    expect(container!.read(provider).globalPositionMs, 13000);
    expect(progress.positions['project-1']?.positionMs, 13000);

    final newTimeline = longTimelineFixture();
    cache.timelinesByChapter[1] = newTimeline;
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    await controller.retry();
    await settle(tester);

    expect(player.tracks.map((track) => track.id), [
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
    expect(player.position, Duration.zero);
    expect(player.playing, isFalse);
    expect(player.seeks, isEmpty);
    final state = container!.read(provider);
    expect(state.globalPositionMs, 0);
    expect(state.chapterPositionMs, 0);
    expect(state.chapterIndex, 1);
    expect(state.playing, isFalse);
    expect(state.activeSegmentIndex, isNull);
    expect(state.activeTimeline, same(newTimeline));
    expect(state.downloadedChapters, {1, 2});
    expect(progress.positions, isEmpty);
    container!.dispose();
    container = null;
    expect(progress.positions, isEmpty);
  });

  testWidgets('an old download finishing during disposal cannot rebuild '
      'the replaced queue', (tester) async {
    repository.audiobook = audiobookWith(chapters: halfNarratedChapters());
    final controller = await start(tester);
    expect(player.tracks.map((track) => track.id), ['audiobook-1:1']);

    repository.audiobook = audiobookWith(chapters: fullyNarratedChapters());
    final download = cache.audioGate = Completer<void>();
    await controller.retry();
    await settle(tester);

    final disposal = player.disposeGate = Completer<void>();
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    final replacement = controller.retry();
    await settle(tester);
    download.complete();
    await settle(tester);
    disposal.complete();
    await replacement;
    await settle(tester);

    expect(player.tracks.map((track) => track.id), [
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
    expect(cache.downloadedAudio, [
      'audiobook-1:1',
      'audiobook-1:2',
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
  });

  testWidgets('a newer refresh wins while the old queue is disposing', (
    tester,
  ) async {
    final controller = await start(tester);
    final disposal = player.disposeGate = Completer<void>();
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    final first = controller.retry();
    await settle(tester);
    repository.audiobook = audiobookWith(
      id: 'audiobook-3',
      chapters: fullyNarratedChapters(),
    );
    final second = controller.retry();
    await settle(tester);
    disposal.complete();
    await Future.wait([first, second]);
    await settle(tester);

    expect(container!.read(provider).audiobook?.id, 'audiobook-3');
    expect(player.tracks.map((track) => track.id), [
      'audiobook-3:1',
      'audiobook-3:2',
    ]);
    expect(cache.downloadedAudio, isNot(contains('audiobook-2:1')));
  });

  testWidgets('a late fetch cannot replace a newer refresh result', (
    tester,
  ) async {
    final controller = await start(tester);
    final staleFetch = repository.fetchGate = Completer<MobileAudiobook?>();
    final first = controller.retry();
    repository.audiobook = audiobookWith(
      id: 'audiobook-3',
      chapters: fullyNarratedChapters(),
    );
    await controller.retry();
    await settle(tester);
    staleFetch.complete(
      audiobookWith(id: 'audiobook-2', chapters: fullyNarratedChapters()),
    );
    await first;
    await settle(tester);

    expect(container!.read(provider).audiobook?.id, 'audiobook-3');
    expect(player.tracks.map((track) => track.id), [
      'audiobook-3:1',
      'audiobook-3:2',
    ]);
  });

  testWidgets('a saved position read before replacement cannot resume '
      'the new narration', (tester) async {
    final restore = progress.loadGate =
        Completer<AudiobookListeningPosition?>();
    final controller = await start(tester);
    expect(player.tracks, isEmpty);

    final download = cache.audioGate = Completer<void>();
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    await controller.retry();
    await settle(tester);
    restore.complete(
      AudiobookListeningPosition(
        audiobookId: 'audiobook-1',
        positionMs: 12000,
        updatedAt: DateTime(2026),
      ),
    );
    await settle(tester);
    download.complete();
    await settle(tester);

    expect(player.tracks.map((track) => track.id), [
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
    expect(player.seeks, isEmpty);
    expect(container!.read(provider).globalPositionMs, 0);
    container!.dispose();
    container = null;
    expect(progress.positions, isEmpty);
  });

  testWidgets('another refresh of the same replacement waits for disposal', (
    tester,
  ) async {
    final controller = await start(tester);
    final disposal = player.disposeGate = Completer<void>();
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    final first = controller.retry();
    await settle(tester);
    final second = controller.retry();
    await settle(tester);
    expect(cache.downloadedAudio, ['audiobook-1:1', 'audiobook-1:2']);

    disposal.complete();
    await Future.wait([first, second]);
    await settle(tester);
    expect(player.tracks.map((track) => track.id), [
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
    expect(container!.read(provider).downloadedChapters, {1, 2});
  });

  testWidgets('closing during replacement disposal cannot recreate playback '
      'or save the old position', (tester) async {
    final controller = await start(tester);
    player.emitPosition(const Duration(milliseconds: 4000));
    await settle(tester);
    expect(progress.positions, isNotEmpty);

    final disposal = player.disposeGate = Completer<void>();
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    final replacement = controller.retry();
    await settle(tester);
    container!.dispose();
    container = null;
    disposal.complete();
    await replacement;
    await settle(tester);

    expect(player.tracks, isEmpty);
    expect(cache.downloadedAudio, ['audiobook-1:1', 'audiobook-1:2']);
    expect(progress.positions, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('polling adopts replacement audio as new chapters arrive', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    await start(tester);
    expect(player.tracks.map((track) => track.id), ['audiobook-1:1']);
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    await tester.pump(const Duration(seconds: 4));
    await settle(tester);

    expect(player.tracks.map((track) => track.id), [
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
    expect(container!.read(provider).audiobook?.id, 'audiobook-2');
  });

  testWidgets('slow overlapping polls make progress and then accept '
      'the newer response', (tester) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    await start(tester);
    final first = repository.fetchGate = Completer<MobileAudiobook?>();
    await tester.pump(const Duration(seconds: 4));
    final second = repository.fetchGate = Completer<MobileAudiobook?>();
    await tester.pump(const Duration(seconds: 4));

    first.complete(
      audiobookWith(
        id: 'audiobook-2',
        status: AudiobookStatus.generating,
        chapters: fullyNarratedChapters(),
      ),
    );
    await settle(tester);
    final firstResult = container!.read(provider).audiobook?.id;
    second.complete(
      audiobookWith(id: 'audiobook-3', chapters: fullyNarratedChapters()),
    );
    await settle(tester);

    expect(firstResult, 'audiobook-2');
    expect(container!.read(provider).audiobook?.id, 'audiobook-3');
    expect(player.tracks.map((track) => track.id), [
      'audiobook-3:1',
      'audiobook-3:2',
    ]);
  });

  testWidgets('a fetch started before local narration cannot roll it back', (
    tester,
  ) async {
    final controller = await start(tester);
    final stale = repository.fetchGate = Completer<MobileAudiobook?>();
    final refresh = controller.retry();
    repository.audiobook = audiobookWith(
      id: 'audiobook-2',
      chapters: fullyNarratedChapters(),
    );
    final afterNarration = repository.fetchGate = Completer<MobileAudiobook?>();
    await controller.narrate(voice: 'Zephyr', replace: true);
    stale.complete(audiobookWith(chapters: fullyNarratedChapters()));
    await refresh;
    final result = container!.read(provider).audiobook?.id;
    afterNarration.complete(repository.audiobook);
    await settle(tester);

    expect(result, 'audiobook-2');
    expect(player.tracks.map((track) => track.id), [
      'audiobook-2:1',
      'audiobook-2:2',
    ]);
  });
}

class _GatedPlayer extends FakeAudiobookPlayer {
  Completer<void>? disposeGate;

  @override
  Future<void> dispose() async {
    final gate = disposeGate;
    disposeGate = null;
    await gate?.future;
    await super.dispose();
  }
}

class _GatedRepository extends FakeAudiobookRepository {
  _GatedRepository({super.audiobook});

  Completer<MobileAudiobook?>? fetchGate;

  @override
  Future<MobileAudiobook?> fetch(String projectId) {
    final gate = fetchGate;
    fetchGate = null;
    return gate?.future ?? super.fetch(projectId);
  }
}

class _GatedProgressStore extends FakeAudiobookProgressStore {
  Completer<AudiobookListeningPosition?>? loadGate;

  @override
  Future<AudiobookListeningPosition?> load(String projectId) {
    final gate = loadGate;
    loadGate = null;
    return gate?.future ?? super.load(projectId);
  }
}
