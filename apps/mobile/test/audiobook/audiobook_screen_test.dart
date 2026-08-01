import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/data/audiobook_repository.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_player.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_screen.dart';

/// A player with no native audio behind it, recording what it was asked to do.
class FakeAudiobookPlayer implements AudiobookPlayer {
  final _position = StreamController<Duration>.broadcast();
  final _index = StreamController<int?>.broadcast();
  final _playing = StreamController<bool>.broadcast();
  final _busy = StreamController<bool>.broadcast();
  final _completed = StreamController<void>.broadcast();

  final List<AudiobookTrack> tracks = [];
  final List<({Duration position, int? index})> seeks = [];
  final List<double> speeds = [];
  bool _playingNow = false;
  Duration _positionNow = Duration.zero;
  int? _indexNow = 0;
  bool disposed = false;

  @override
  Stream<Duration> get positionStream => _position.stream;
  @override
  Stream<int?> get currentIndexStream => _index.stream;
  @override
  Stream<bool> get playingStream => _playing.stream;
  @override
  Stream<bool> get busyStream => _busy.stream;
  @override
  Stream<void> get completedStream => _completed.stream;
  @override
  bool get playing => _playingNow;
  @override
  Duration get position => _positionNow;
  @override
  int? get currentIndex => _indexNow;

  void emitPosition(Duration position, {int? index}) {
    _positionNow = position;
    if (index != null) {
      _indexNow = index;
    }
    _position.add(position);
  }

  @override
  Future<void> setQueue(
    List<AudiobookTrack> next, {
    int initialIndex = 0,
    Duration initialPosition = Duration.zero,
  }) async {
    tracks
      ..clear()
      ..addAll(next);
    _indexNow = initialIndex;
  }

  @override
  Future<void> appendTracks(List<AudiobookTrack> next) async => tracks.addAll(next);

  @override
  Future<void> play() async {
    _playingNow = true;
    _playing.add(true);
  }

  @override
  Future<void> pause() async {
    _playingNow = false;
    _playing.add(false);
  }

  @override
  Future<void> seek(Duration position, {int? index}) async {
    seeks.add((position: position, index: index));
    _positionNow = position;
    if (index != null) {
      _indexNow = index;
    }
  }

  @override
  Future<void> setSpeed(double speed) async => speeds.add(speed);

  @override
  Future<void> dispose() async {
    disposed = true;
    await _position.close();
    await _index.close();
    await _playing.close();
    await _busy.close();
    await _completed.close();
  }
}

class FakeAudiobookRepository implements AudiobookRepository {
  FakeAudiobookRepository({this.audiobook});

  MobileAudiobook? audiobook;
  final List<({String voice, bool replace})> starts = [];

  @override
  Future<List<NarratorVoice>> listVoices() async => const [
    NarratorVoice(voice: 'Zephyr', name: 'Zephyr', blurb: 'Bright and warm.', sampleUrl: '/s/Zephyr'),
  ];

  @override
  Future<MobileAudiobook?> fetch(String projectId) async => audiobook;

  @override
  Future<MobileAudiobook?> start({
    required String projectId,
    required String voice,
    bool replace = false,
    String? requestId,
  }) async {
    starts.add((voice: voice, replace: replace));
    return audiobook;
  }
}

/// A cache that hands back local files without touching the network.
class FakeAudiobookCache implements AudiobookCache {
  FakeAudiobookCache(this.directory);

  final Directory directory;
  final timelinesByChapter = <int, AudiobookChapterTimeline>{};

  /// Never used: every method that would reach the network is overridden.
  @override
  ApiClient get apiClient => throw UnimplementedError();

  @override
  Future<Directory> audiobookDirectory(String projectId, String audiobookId) async => directory;

  @override
  Future<void> clearProject(String projectId) async {}

  @override
  Future<File> ensureChapterAudio({
    required String projectId,
    required String audiobookId,
    required MobileAudiobookChapter chapter,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) async {
    // Deliberately no real I/O: the fake player never opens the file, and real
    // filesystem work does not complete inside the widget test's fake clock.
    return File('${directory.path}/chapter-${chapter.index}.mp3');
  }

  @override
  Future<AudiobookChapterTimeline> ensureChapterTimeline({
    required String projectId,
    required String audiobookId,
    required MobileAudiobookChapter chapter,
    CancelToken? cancelToken,
  }) async {
    return timelinesByChapter[chapter.index]!;
  }

  @override
  Future<File?> ensureCoverArt({
    required String projectId,
    required String audiobookId,
    required String? coverUrl,
  }) async => null;

  @override
  Future<void> pruneOtherAudiobooks(String projectId, String keepAudiobookId) async {}
}

MobileAudiobook audiobookWith({
  AudiobookStatus status = AudiobookStatus.complete,
  List<MobileAudiobookChapter>? chapters,
}) {
  return MobileAudiobook(
    id: 'audiobook-1',
    projectId: 'project-1',
    status: status,
    voice: 'Zephyr',
    narratorName: 'Zephyr',
    isStale: false,
    totalDurationMs: 9000,
    totalEstimatedDurationMs: 9000,
    failureMessage: null,
    progress: null,
    chapters: chapters ??
        const [
          MobileAudiobookChapter(
            index: 1,
            title: 'Low Tide',
            status: AudiobookChapterStatus.ready,
            durationMs: 9000,
            estimatedDurationMs: 9000,
            byteSize: 10,
            segmentCount: 3,
            audioUrl: '/a/1',
            timelineUrl: '/t/1',
          ),
        ],
  );
}

AudiobookChapterTimeline timelineFixture() {
  return const AudiobookChapterTimeline(
    chapterIndex: 1,
    title: 'Low Tide',
    isRightToLeft: false,
    durationMs: 9000,
    segments: [
      AudiobookSegment(index: 0, isTitle: true, paragraph: 0, pageIndex: 1, startMs: 0, endMs: 2000, text: 'Chapter 1. Low Tide'),
      AudiobookSegment(index: 1, isTitle: false, paragraph: 1, pageIndex: 1, startMs: 3000, endMs: 5000, text: 'She waited.'),
      AudiobookSegment(index: 2, isTitle: false, paragraph: 1, pageIndex: 1, startMs: 5000, endMs: 7000, text: 'He did not come.'),
    ],
  );
}

Future<void> settle(WidgetTester tester) async {
  // Some states keep an indefinite animation running (the shimmer while a
  // narration is being prepared), so pumping a bounded number of frames is the
  // only way to reach a stable tree.
  for (var frame = 0; frame < 12; frame += 1) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

void main() {
  late Directory tempDir;
  late FakeAudiobookPlayer player;
  late FakeAudiobookRepository repository;
  late FakeAudiobookCache cache;
  ProviderContainer? activeContainer;

  /// Disposes the container inside the test body. A narration that is still
  /// being made leaves a polling timer running, and the widget-test framework
  /// checks for pending timers before `addTearDown` callbacks run.
  void disposeActive() {
    activeContainer?.dispose();
    activeContainer = null;
  }

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('tomeza-audiobook-test');
    player = FakeAudiobookPlayer();
    repository = FakeAudiobookRepository(audiobook: audiobookWith());
    cache = FakeAudiobookCache(tempDir)..timelinesByChapter[1] = timelineFixture();
  });

  tearDown(() {
    disposeActive();
    tempDir.deleteSync(recursive: true);
  });

  Future<ProviderContainer> pumpScreen(WidgetTester tester) async {
    final container = ProviderContainer(
      overrides: [
        audiobookRepositoryProvider.overrideWithValue(repository),
        audiobookCacheProvider.overrideWithValue(cache),
        audiobookPlayerFactoryProvider.overrideWithValue(() => player),
      ],
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

  testWidgets('offers to narrate a book that has none', (tester) async {
    repository.audiobook = null;
    await pumpScreen(tester);

    expect(find.text('Hear your book read aloud'), findsOneWidget);
    expect(find.text('Choose a narrator'), findsOneWidget);
  });

  testWidgets('downloads the finished chapter and shows its transcript', (tester) async {
    await pumpScreen(tester);

    expect(player.tracks, hasLength(1));
    expect(find.textContaining('She waited.', findRichText: true), findsOneWidget);
    expect(find.text('Narrated by Zephyr'), findsOneWidget);
  });

  testWidgets('play and pause drive the player', (tester) async {
    await pumpScreen(tester);

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    expect(player.playing, isTrue);

    await tester.tap(find.byIcon(Icons.pause_rounded));
    await settle(tester);
    expect(player.playing, isFalse);
  });

  testWidgets('skipping back asks the player to move by fifteen seconds', (tester) async {
    await pumpScreen(tester);
    player.emitPosition(const Duration(seconds: 8), index: 0);
    await settle(tester);

    // Two skip buttons share the replay glyph; the first is "back".
    await tester.tap(find.byIcon(Icons.replay).first);
    await settle(tester);

    expect(player.seeks.last.position.inMilliseconds, lessThan(8000));
  });

  testWidgets('changing the speed reaches the player', (tester) async {
    await pumpScreen(tester);

    await tester.tap(find.text('1x'));
    await settle(tester);
    await tester.tap(find.text('1.5x').last);
    await settle(tester);

    expect(player.speeds.last, 1.5);
  });

  testWidgets('shows a preparing state until the first chapter lands', (tester) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: const [
        MobileAudiobookChapter(
          index: 1,
          title: 'Low Tide',
          status: AudiobookChapterStatus.pending,
          durationMs: null,
          estimatedDurationMs: 9000,
          byteSize: null,
          segmentCount: null,
          audioUrl: null,
          timelineUrl: null,
        ),
      ],
    );
    await pumpScreen(tester);

    expect(find.text('Zephyr is warming up'), findsOneWidget);
    expect(player.tracks, isEmpty);
    disposeActive();
  });

  testWidgets('a failed narration says the credits came back', (tester) async {
    repository.audiobook = MobileAudiobook(
      id: 'audiobook-1',
      projectId: 'project-1',
      status: AudiobookStatus.failed,
      voice: 'Zephyr',
      narratorName: 'Zephyr',
      isStale: false,
      totalDurationMs: null,
      totalEstimatedDurationMs: null,
      failureMessage: 'Narration stopped before it finished. Your credits were refunded.',
      progress: null,
      chapters: const [],
    );
    await pumpScreen(tester);

    expect(find.textContaining('refunded'), findsOneWidget);
  });

  testWidgets('the transcript can be hidden', (tester) async {
    await pumpScreen(tester);
    expect(find.textContaining('She waited.', findRichText: true), findsOneWidget);

    await tester.tap(find.byIcon(Icons.subtitles));
    await settle(tester);

    expect(find.textContaining('She waited.', findRichText: true), findsNothing);
  });
}
