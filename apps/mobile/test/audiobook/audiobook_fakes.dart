/// Test doubles and fixtures shared by the audiobook suites.
///
/// Everything here stands in for something the widget tests cannot have: the
/// native player, the network, and the device filesystem — real file I/O does
/// not complete inside a widget test's fake clock, so the stores are in memory.
library;

import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/audiobook/data/audiobook_cache.dart';
import 'package:tomeza/features/audiobook/data/audiobook_progress_store.dart';
import 'package:tomeza/features/audiobook/data/audiobook_repository.dart';
import 'package:tomeza/features/audiobook/domain/audiobook_models.dart';
import 'package:tomeza/features/audiobook/presentation/audiobook_player.dart';

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

  /// Records the disposal without closing the streams.
  ///
  /// Starting a new narration disposes the queue and builds a player again,
  /// and the factory hands back this same instance — closed controllers would
  /// make the second life throw instead of behaving like the fresh player the
  /// controller thinks it asked for. Broadcast controllers left open cost a
  /// test nothing; the controller cancels its own subscriptions.
  @override
  Future<void> dispose() async {
    disposed = true;
    _engaged = false;
    _finished = false;
    _positionNow = Duration.zero;
    _indexNow = 0;
    tracks.clear();
  }
}

class FakeAudiobookRepository implements AudiobookRepository {
  FakeAudiobookRepository({this.audiobook});

  MobileAudiobook? audiobook;
  final List<({String voice, bool replace})> starts = [];

  /// Thrown instead of answering, so the screen can be tested against a server
  /// that cannot read or start a narration. `Object` rather than
  /// `ApiException`, because a decode error is one of the failures under test.
  Object? fetchError;
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

  /// When set, the next chapter-audio download parks on this until it is
  /// completed — how a suite holds a download loop mid-await.
  Completer<void>? audioGate;

  /// Thrown from the next chapter-audio download, once.
  Object? audioError;

  /// When set, the next cover-art fetch parks on this until it is completed.
  Completer<void>? coverGate;

  /// Every chapter audio handed out, as `audiobookId:chapterIndex`.
  final downloadedAudio = <String>[];

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
    final gate = audioGate;
    if (gate != null) {
      audioGate = null;
      await gate.future;
    }
    final error = audioError;
    if (error != null) {
      audioError = null;
      throw error;
    }
    downloadedAudio.add('$audiobookId:${chapter.index}');
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
  }) async {
    final gate = coverGate;
    if (gate != null) {
      coverGate = null;
      await gate.future;
    }
    return null;
  }

  @override
  Future<void> pruneOtherAudiobooks(
    String projectId,
    String keepAudiobookId,
  ) async {}
}

/// The listening position, in memory. Real file I/O never completes under the
/// widget test's fake clock, and the position is written on a timer, so a real
/// store would leave every test waiting on a save that cannot land.
class FakeAudiobookProgressStore implements AudiobookProgressStore {
  final Map<String, AudiobookListeningPosition> positions = {};
  final List<String> cleared = [];

  @override
  Future<AudiobookListeningPosition?> load(String projectId) async =>
      positions[projectId];

  @override
  Future<void> save(
    String projectId,
    AudiobookListeningPosition position,
  ) async {
    positions[projectId] = position;
  }

  @override
  Future<void> clear(String projectId) async {
    cleared.add(projectId);
    positions.remove(projectId);
  }
}

/// The overrides every audiobook widget test needs, in one place.
ProviderContainer audiobookContainer({
  required FakeAudiobookRepository repository,
  required FakeAudiobookCache cache,
  required FakeAudiobookPlayer player,
  required FakeAudiobookProgressStore progress,
}) {
  return ProviderContainer(
    overrides: [
      audiobookRepositoryProvider.overrideWithValue(repository),
      audiobookCacheProvider.overrideWithValue(cache),
      audiobookProgressStoreProvider.overrideWithValue(progress),
      audiobookPlayerFactoryProvider.overrideWithValue(() => player),
      // The narrator picker prices the narration against this; without it the
      // confirm button offers to top up rather than to start.
      billingProvider.overrideWith((ref) async => affordableBilling()),
    ],
  );
}

MobileAudiobook audiobookWith({
  String id = 'audiobook-1',
  AudiobookStatus status = AudiobookStatus.complete,
  List<MobileAudiobookChapter>? chapters,
  bool backupNarrationUsed = false,
}) {
  return MobileAudiobook(
    id: id,
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

/// A chapter long enough that most of its paragraphs are nowhere near the
/// viewport — which is the only way to exercise scrolling to one the lazy list
/// has never built.
AudiobookChapterTimeline longTimelineFixture({int paragraphs = 60}) {
  return AudiobookChapterTimeline(
    chapterIndex: 1,
    title: 'Low Tide',
    isRightToLeft: false,
    durationMs: paragraphs * 1000,
    segments: [
      for (var index = 0; index < paragraphs; index += 1)
        AudiobookSegment(
          index: index,
          isTitle: index == 0,
          paragraph: index,
          pageIndex: 1,
          startMs: index * 1000,
          endMs: index * 1000 + 900,
          text: 'Sentence $index.',
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
