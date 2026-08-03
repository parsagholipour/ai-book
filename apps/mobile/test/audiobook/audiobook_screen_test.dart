import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/data/audiobook_repository.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_controller.dart';
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

  /// The two flags the real player keeps apart: `_engaged` is just_audio's own
  /// `playing` — the play button, which stays pressed when the queue runs out —
  /// and `_finished` is its completed processing state. Playing is both.
  bool _engaged = false;
  bool _finished = false;
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
  bool get playing => _engaged && !_finished;
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

  /// The queue reaches the end of the last track it holds. Note what does *not*
  /// happen: `_engaged` stays true, so the player has no change of its own to
  /// announce beyond the one derived from the processing state.
  void emitCompleted() {
    _finished = true;
    _emitPlaying();
    _completed.add(null);
  }

  void _emitPlaying() => _playing.add(playing);

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
  Future<void> appendTracks(List<AudiobookTrack> next) async =>
      tracks.addAll(next);

  @override
  Future<void> play() async {
    _engaged = true;
    _emitPlaying();
  }

  @override
  Future<void> pause() async {
    _engaged = false;
    _emitPlaying();
  }

  @override
  Future<void> seek(Duration position, {int? index}) async {
    seeks.add((position: position, index: index));
    _positionNow = position;
    if (index != null) {
      _indexNow = index;
    }
    // Leaving the end of the queue puts the player back to ready, which resumes
    // it when the play button was never released.
    _finished = false;
    _emitPlaying();
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

  /// Thrown instead of answering, so the screen can be tested against a server
  /// that cannot read or start a narration.
  ApiException? fetchError;
  ApiException? startError;

  @override
  Future<List<NarratorVoice>> listVoices() async => const [
    NarratorVoice(
      voice: 'Zephyr',
      name: 'Zephyr',
      blurb: 'Bright and warm.',
      sampleUrl: '/s/Zephyr',
    ),
  ];

  @override
  Future<MobileAudiobook?> fetch(String projectId) async {
    final error = fetchError;
    if (error != null) {
      throw error;
    }
    return audiobook;
  }

  @override
  Future<MobileAudiobook?> start({
    required String projectId,
    required String voice,
    bool replace = false,
    String? requestId,
  }) async {
    starts.add((voice: voice, replace: replace));
    final error = startError;
    if (error != null) {
      throw error;
    }
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
  Future<Directory> audiobookDirectory(
    String projectId,
    String audiobookId,
  ) async => directory;

  @override
  Future<File> ensureNarratorSample(NarratorVoice voice) async =>
      File('${directory.path}/${voice.voice}.mp3');

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
  Future<void> pruneOtherAudiobooks(
    String projectId,
    String keepAudiobookId,
  ) async {}
}

MobileAudiobook audiobookWith({
  AudiobookStatus status = AudiobookStatus.complete,
  List<MobileAudiobookChapter>? chapters,
  bool backupNarrationUsed = false,
}) {
  return MobileAudiobook(
    id: 'audiobook-1',
    projectId: 'project-1',
    status: status,
    voice: 'Zephyr',
    narratorName: 'Zephyr',
    backupNarrationUsed: backupNarrationUsed,
    isStale: false,
    totalDurationMs: 9000,
    totalEstimatedDurationMs: 9000,
    failureMessage: null,
    progress: null,
    chapters:
        chapters ??
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

/// Two chapters, of which only the first has been narrated — the state a book
/// is in for as long as it is being read aloud.
List<MobileAudiobookChapter> halfNarratedChapters() {
  return const [
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
    MobileAudiobookChapter(
      index: 2,
      title: 'High Tide',
      status: AudiobookChapterStatus.pending,
      durationMs: null,
      estimatedDurationMs: 9000,
      byteSize: null,
      segmentCount: null,
      audioUrl: null,
      timelineUrl: null,
    ),
  ];
}

List<MobileAudiobookChapter> fullyNarratedChapters() {
  return [
    halfNarratedChapters().first,
    const MobileAudiobookChapter(
      index: 2,
      title: 'High Tide',
      status: AudiobookChapterStatus.ready,
      durationMs: 9000,
      estimatedDurationMs: 9000,
      byteSize: 10,
      segmentCount: 3,
      audioUrl: '/a/2',
      timelineUrl: '/t/2',
    ),
  ];
}

AudiobookChapterTimeline timelineFixture() {
  return const AudiobookChapterTimeline(
    chapterIndex: 1,
    title: 'Low Tide',
    isRightToLeft: false,
    durationMs: 9000,
    segments: [
      AudiobookSegment(
        index: 0,
        isTitle: true,
        paragraph: 0,
        pageIndex: 1,
        startMs: 0,
        endMs: 2000,
        text: 'Chapter 1. Low Tide',
      ),
      AudiobookSegment(
        index: 1,
        isTitle: false,
        paragraph: 1,
        pageIndex: 1,
        startMs: 3000,
        endMs: 5000,
        text: 'She waited.',
      ),
      AudiobookSegment(
        index: 2,
        isTitle: false,
        paragraph: 1,
        pageIndex: 1,
        startMs: 5000,
        endMs: 7000,
        text: 'He did not come.',
      ),
    ],
  );
}

/// Enough credits that the picker offers to start rather than to top up.
MobileBilling affordableBilling() {
  return const MobileBilling(
    credits: CreditBalance(
      available: 5000,
      reserved: 0,
      lifetimeGranted: 5000,
      lifetimeSpent: 0,
    ),
    entitlements: [],
    products: [],
    creditCosts: {},
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
    cache = FakeAudiobookCache(tempDir)
      ..timelinesByChapter[1] = timelineFixture();
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
        // The narrator picker prices the narration against this; without it the
        // confirm button offers to top up rather than to start.
        billingProvider.overrideWith((ref) async => affordableBilling()),
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

  testWidgets('a narration that cannot start says why', (tester) async {
    repository.audiobook = null;
    repository.startError = const ApiException(
      code: 'BOOK_NOT_READY',
      message: 'Finish the book before narrating it.',
      statusCode: 409,
    );
    await pumpScreen(tester);

    await tester.tap(find.text('Choose a narrator'));
    await settle(tester);
    await tester.tap(find.text('Zephyr').first);
    await settle(tester);
    await tester.tap(find.text('Start narrating'));
    await settle(tester);

    // The picker stays up with its button back on offer, and the reason is
    // said out loud — a silent return to "Start narrating" reads as the button
    // being broken.
    expect(find.text('Finish the book before narrating it.'), findsOneWidget);
    expect(find.text('Start narrating'), findsOneWidget);
  });

  testWidgets('a narration that cannot be loaded does not offer to sell one', (
    tester,
  ) async {
    repository.audiobook = null;
    repository.fetchError = const ApiException(
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
      statusCode: 500,
    );
    await pumpScreen(tester);

    expect(find.text('Narration unavailable'), findsOneWidget);
    expect(find.text('Hear your book read aloud'), findsNothing);

    // And the error is not a dead end: once the server answers again the screen
    // finds its way back to the picker.
    repository.fetchError = null;
    await tester.tap(find.text('Try again'));
    await settle(tester);

    expect(find.text('Choose a narrator'), findsOneWidget);
  });

  testWidgets('downloads the finished chapter and shows its transcript', (
    tester,
  ) async {
    await pumpScreen(tester);

    expect(player.tracks, hasLength(1));
    expect(
      find.textContaining('She waited.', findRichText: true),
      findsOneWidget,
    );
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

  testWidgets('the button follows the sound back from the end of the queue', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    final container = await pumpScreen(tester);
    final controller = container.read(
      audiobookControllerProvider('project-1').notifier,
    );

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);

    // Seeking past what has been narrated lands on the last millisecond that
    // exists, so the queue runs out and playback stops.
    await controller.seekGlobal(15000);
    player.emitCompleted();
    await settle(tester);
    expect(find.byIcon(Icons.play_arrow_rounded), findsOneWidget);
    expect(find.text('waiting for the next chapter'), findsOneWidget);

    // Back into narrated audio the player resumes on its own — play was never
    // released — and the button has to notice.
    await controller.seekGlobal(2000);
    await settle(tester);
    expect(player.playing, isTrue);
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
    disposeActive();
  });

  testWidgets('play carries on into a chapter that landed while waiting', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      chapters: halfNarratedChapters(),
    );
    final container = await pumpScreen(tester);
    final controller = container.read(
      audiobookControllerProvider('project-1').notifier,
    );

    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);
    player.emitCompleted();
    await settle(tester);

    repository.audiobook = audiobookWith(chapters: fullyNarratedChapters());
    cache.timelinesByChapter[2] = const AudiobookChapterTimeline(
      chapterIndex: 2,
      title: 'High Tide',
      isRightToLeft: false,
      durationMs: 9000,
      segments: [
        AudiobookSegment(
          index: 0,
          isTitle: true,
          paragraph: 0,
          pageIndex: 2,
          startMs: 0,
          endMs: 2000,
          text: 'Chapter 2. High Tide',
        ),
      ],
    );
    await controller.retry();
    await settle(tester);
    expect(player.tracks, hasLength(2));

    // Playing from where the queue stopped would be silence, so Play means the
    // chapter that has since arrived.
    await tester.tap(find.byIcon(Icons.play_arrow_rounded));
    await settle(tester);

    expect(player.seeks.last.index, 1);
    expect(player.playing, isTrue);
    expect(find.byIcon(Icons.pause_rounded), findsOneWidget);
  });

  testWidgets('skipping back asks the player to move by fifteen seconds', (
    tester,
  ) async {
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

  testWidgets('shows a preparing state until the first chapter lands', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(
      status: AudiobookStatus.generating,
      backupNarrationUsed: true,
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
    expect(find.text('Generated with backup narration'), findsOneWidget);
    expect(player.tracks, isEmpty);
    disposeActive();
  });

  testWidgets('shows the backup narration note during playback', (
    tester,
  ) async {
    repository.audiobook = audiobookWith(backupNarrationUsed: true);
    await pumpScreen(tester);

    expect(find.text('Generated with backup narration'), findsOneWidget);
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
      failureMessage:
          'Narration stopped before it finished. Your credits were refunded.',
      progress: null,
      chapters: const [],
    );
    await pumpScreen(tester);

    expect(find.textContaining('refunded'), findsOneWidget);
  });

  testWidgets('the transcript can be hidden', (tester) async {
    await pumpScreen(tester);
    expect(
      find.textContaining('She waited.', findRichText: true),
      findsOneWidget,
    );

    await tester.tap(find.byIcon(Icons.subtitles));
    await settle(tester);

    expect(
      find.textContaining('She waited.', findRichText: true),
      findsNothing,
    );
  });
}
