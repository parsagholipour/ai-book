import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../billing/data/billing_repository.dart';
import '../data/audiobook_cache.dart';
import '../data/audiobook_repository.dart';
import '../domain/audiobook_models.dart';
import '../domain/audiobook_timeline.dart';
import 'audiobook_player.dart';

/// Drives listening: what exists, what is downloaded, what is playing, and which
/// sentence is being spoken right now.
///
/// The hard part is that a book can be narrated while it is being listened to.
/// Chapters arrive over minutes, so the controller polls the manifest while the
/// narration runs, downloads each chapter as it lands, and appends it to the
/// queue without interrupting playback. The listener only ever sees one book
/// with one timeline; the chapter files behind it are an implementation detail.
class AudiobookController extends Notifier<AudiobookState> {
  AudiobookController(this.projectId);

  final String projectId;

  static const _pollInterval = Duration(seconds: 4);
  static const skipInterval = Duration(seconds: 15);
  static const speedOptions = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

  AudiobookPlayer? _player;
  Timer? _pollTimer;
  Timer? _sleepTimer;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  final Map<int, AudiobookChapterTimeline> _timelines = {};
  final Set<int> _queuedChapters = {};
  bool _downloading = false;
  bool _disposed = false;

  @override
  AudiobookState build() {
    ref.onDispose(_teardown);
    scheduleMicrotask(_refresh);
    return const AudiobookState();
  }

  // ---------------------------------------------------------------- lifecycle

  Future<void> _refresh() async {
    try {
      final audiobook = await ref
          .read(audiobookRepositoryProvider)
          .fetch(projectId);
      if (_disposed) {
        return;
      }
      if (audiobook == null) {
        state = state.copyWith(loading: false, audiobook: null, clearAudiobook: true);
        _stopPolling();
        return;
      }

      state = state.copyWith(
        loading: false,
        audiobook: audiobook,
        timeline: AudiobookGlobalTimeline(audiobook.chapters),
        clearError: true,
      );

      if (audiobook.isGenerating) {
        _startPolling();
      } else {
        _stopPolling();
      }
      if (audiobook.hasFailed) {
        // The narration refunded itself server-side; nothing left to download.
        ref.invalidate(billingProvider);
        return;
      }
      unawaited(_syncDownloads());
    } on ApiException catch (error) {
      if (!_disposed) {
        state = state.copyWith(loading: false, error: userFacingError(error));
      }
    }
  }

  void _startPolling() {
    _pollTimer ??= Timer.periodic(_pollInterval, (_) => _refresh());
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  void _teardown() {
    _disposed = true;
    _stopPolling();
    _sleepTimer?.cancel();
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _subscriptions.clear();
    unawaited(_player?.dispose() ?? Future<void>.value());
    _player = null;
  }

  // ---------------------------------------------------------------- narration

  /// Starts (or replaces) a narration. Returns false when it could not start,
  /// with the reason in [AudiobookState.error].
  Future<bool> narrate({required String voice, bool replace = false}) async {
    state = state.copyWith(starting: true, clearError: true);
    try {
      final audiobook = await ref
          .read(audiobookRepositoryProvider)
          .start(projectId: projectId, voice: voice, replace: replace);
      ref.invalidate(billingProvider);
      if (_disposed) {
        return true;
      }
      // A replacement has a new id, so anything cached for the old one is dead
      // weight on the device.
      if (audiobook != null) {
        unawaited(
          ref.read(audiobookCacheProvider).pruneOtherAudiobooks(projectId, audiobook.id),
        );
      }
      state = state.copyWith(
        starting: false,
        audiobook: audiobook,
        timeline: audiobook == null ? null : AudiobookGlobalTimeline(audiobook.chapters),
      );
      _timelines.clear();
      _queuedChapters.clear();
      _startPolling();
      unawaited(_refresh());
      return true;
    } on ApiException catch (error) {
      if (!_disposed) {
        state = state.copyWith(starting: false, error: userFacingError(error));
      }
      return false;
    }
  }

  // ----------------------------------------------------------------- download

  /// Pulls down every ready chapter that is not already queued, in order.
  ///
  /// Order matters: the listener is at the front of the book, so chapter two is
  /// worth far more than chapter nine even though both are ready.
  Future<void> _syncDownloads() async {
    final audiobook = state.audiobook;
    if (_downloading || audiobook == null) {
      return;
    }
    _downloading = true;
    try {
      final cache = ref.read(audiobookCacheProvider);
      final pending = audiobook.readyChapters
          .where((chapter) => !_queuedChapters.contains(chapter.index))
          .toList(growable: false);

      for (final chapter in pending) {
        if (_disposed) {
          return;
        }
        final file = await cache.ensureChapterAudio(
          projectId: projectId,
          audiobookId: audiobook.id,
          chapter: chapter,
        );
        final timeline = await cache.ensureChapterTimeline(
          projectId: projectId,
          audiobookId: audiobook.id,
          chapter: chapter,
        );
        if (_disposed) {
          return;
        }
        _timelines[chapter.index] = timeline;
        _queuedChapters.add(chapter.index);

        final track = AudiobookTrack(
          id: '${audiobook.id}:${chapter.index}',
          file: file,
          bookTitle: state.bookTitle ?? 'Your book',
          chapterTitle: chapter.title.isEmpty ? 'Chapter ${chapter.index}' : chapter.title,
          narratorName: audiobook.narratorName,
          artFile: await _coverArt(audiobook),
        );

        if (_player == null) {
          await _startPlayer([track]);
        } else {
          await _player!.appendTracks([track]);
        }
        // Show the words as soon as they exist. Waiting for the first position
        // tick would leave the transcript blank until play is pressed, when it
        // could have been read straight away.
        final isFirstChapterReady = state.activeTimeline == null;
        state = state.copyWith(
          downloadedChapters: Set.of(_queuedChapters),
          activeTimeline: isFirstChapterReady ? timeline : null,
          chapterIndex: isFirstChapterReady ? chapter.index : null,
        );
      }
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(error: userFacingError(error));
      }
    } finally {
      _downloading = false;
    }
  }

  Future<void> _startPlayer(List<AudiobookTrack> tracks) async {
    final player = ref.read(audiobookPlayerFactoryProvider)();
    _player = player;
    await player.setQueue(tracks);
    await player.setSpeed(state.speed);

    _subscriptions.add(
      player.positionStream.listen((position) => _onPosition(position.inMilliseconds)),
    );
    _subscriptions.add(player.playingStream.listen((playing) {
      if (!_disposed) {
        state = state.copyWith(playing: playing);
      }
    }));
    _subscriptions.add(player.busyStream.listen((busy) {
      if (!_disposed) {
        state = state.copyWith(buffering: busy);
      }
    }));
    _subscriptions.add(player.currentIndexStream.listen((_) => _onPosition(player.position.inMilliseconds)));
    _subscriptions.add(player.completedStream.listen((_) {
      if (!_disposed) {
        state = state.copyWith(playing: false, caughtUp: !(state.timeline?.isFullyPlayable ?? true));
      }
    }));
  }

  Future<File?> _coverArt(MobileAudiobook audiobook) async {
    final coverUrl = state.coverUrl;
    if (coverUrl == null) {
      return null;
    }
    return ref.read(audiobookCacheProvider).ensureCoverArt(
          projectId: projectId,
          audiobookId: audiobook.id,
          coverUrl: coverUrl,
        );
  }

  // ----------------------------------------------------------------- playback

  void _onPosition(int chapterPositionMs) {
    final player = _player;
    final timeline = state.timeline;
    if (_disposed || player == null || timeline == null) {
      return;
    }
    final listPosition = player.currentIndex ?? 0;
    final chapters = timeline.chapters.where((chapter) => _queuedChapters.contains(chapter.index)).toList();
    if (listPosition >= chapters.length) {
      return;
    }
    final chapter = chapters[listPosition];
    final chapterTimeline = _timelines[chapter.index];
    final segment = chapterTimeline == null ? null : segmentAt(chapterTimeline, chapterPositionMs);

    state = state.copyWith(
      globalPositionMs: timeline.toGlobal(
        chapterIndex: chapter.index,
        chapterPositionMs: chapterPositionMs,
      ),
      chapterIndex: chapter.index,
      chapterPositionMs: chapterPositionMs,
      activeTimeline: chapterTimeline,
      activeSegmentIndex: segment?.index,
      clearActiveSegment: segment == null,
    );
  }

  Future<void> togglePlay() async {
    final player = _player;
    if (player == null) {
      return;
    }
    if (player.playing) {
      await player.pause();
    } else {
      await player.play();
    }
  }

  Future<void> skip(Duration offset) async {
    await seekGlobal(state.globalPositionMs + offset.inMilliseconds);
  }

  /// Seeks anywhere in the book, mapping a book position onto the right chapter.
  ///
  /// A target inside a chapter that is not narrated yet is clamped back to the
  /// end of what exists rather than refused: the listener asked to go forward,
  /// so going as far forward as possible is the honest answer.
  Future<void> seekGlobal(int positionMs) async {
    final player = _player;
    final timeline = state.timeline;
    if (player == null || timeline == null) {
      return;
    }
    final ceiling = timeline.playableUntilMs;
    final target = positionMs.clamp(0, ceiling > 0 ? ceiling - 1 : 0);
    final resolved = timeline.resolve(target);
    final queueIndex = timeline.chapters
        .where((chapter) => _queuedChapters.contains(chapter.index))
        .toList()
        .indexWhere((chapter) => chapter.index == resolved.chapterIndex);
    if (queueIndex < 0) {
      return;
    }
    await player.seek(Duration(milliseconds: resolved.chapterPosition), index: queueIndex);
  }

  /// Jumps to a sentence in the chapter currently on screen.
  Future<void> seekToSegment(AudiobookSegment segment) async {
    final timeline = state.timeline;
    if (timeline == null) {
      return;
    }
    await seekGlobal(
      timeline.toGlobal(
        chapterIndex: state.chapterIndex,
        chapterPositionMs: segment.startMs,
      ),
    );
    await _player?.play();
  }

  Future<void> setSpeed(double speed) async {
    state = state.copyWith(speed: speed);
    await _player?.setSpeed(speed);
  }

  /// Stops playback after [duration]; passing null cancels a pending timer.
  void setSleepTimer(Duration? duration) {
    _sleepTimer?.cancel();
    if (duration == null) {
      state = state.copyWith(sleepTimerEnd: null, clearSleepTimer: true);
      return;
    }
    state = state.copyWith(sleepTimerEnd: DateTime.now().add(duration));
    _sleepTimer = Timer(duration, () async {
      await _player?.pause();
      if (!_disposed) {
        state = state.copyWith(sleepTimerEnd: null, clearSleepTimer: true);
      }
    });
  }

  /// Lets the screen supply the book's title and cover once it has them; both
  /// only matter for the lock-screen notification.
  void attachBookDetails({String? title, String? coverUrl}) {
    if (state.bookTitle == title && state.coverUrl == coverUrl) {
      return;
    }
    state = state.copyWith(bookTitle: title, coverUrl: coverUrl);
  }

  Future<void> retry() => _refresh();
}

class AudiobookState {
  const AudiobookState({
    this.loading = true,
    this.starting = false,
    this.audiobook,
    this.timeline,
    this.activeTimeline,
    this.activeSegmentIndex,
    this.globalPositionMs = 0,
    this.chapterIndex = 0,
    this.chapterPositionMs = 0,
    this.playing = false,
    this.buffering = false,
    this.caughtUp = false,
    this.speed = 1.0,
    this.sleepTimerEnd,
    this.downloadedChapters = const {},
    this.bookTitle,
    this.coverUrl,
    this.error,
  });

  final bool loading;
  final bool starting;
  final MobileAudiobook? audiobook;
  final AudiobookGlobalTimeline? timeline;

  /// Timings for the chapter on screen, absent until it is downloaded.
  final AudiobookChapterTimeline? activeTimeline;
  final int? activeSegmentIndex;
  final int globalPositionMs;
  final int chapterIndex;
  final int chapterPositionMs;
  final bool playing;
  final bool buffering;

  /// True when playback reached the end of what has been narrated so far.
  final bool caughtUp;
  final double speed;
  final DateTime? sleepTimerEnd;
  final Set<int> downloadedChapters;
  final String? bookTitle;
  final String? coverUrl;
  final String? error;

  bool get hasAudiobook => audiobook != null;
  bool get canPlay => downloadedChapters.isNotEmpty;
  int get totalDurationMs => timeline?.totalDurationMs ?? 0;
  int get playableUntilMs => timeline?.playableUntilMs ?? 0;

  AudiobookState copyWith({
    bool? loading,
    bool? starting,
    MobileAudiobook? audiobook,
    bool clearAudiobook = false,
    AudiobookGlobalTimeline? timeline,
    AudiobookChapterTimeline? activeTimeline,
    int? activeSegmentIndex,
    bool clearActiveSegment = false,
    int? globalPositionMs,
    int? chapterIndex,
    int? chapterPositionMs,
    bool? playing,
    bool? buffering,
    bool? caughtUp,
    double? speed,
    DateTime? sleepTimerEnd,
    bool clearSleepTimer = false,
    Set<int>? downloadedChapters,
    String? bookTitle,
    String? coverUrl,
    String? error,
    bool clearError = false,
  }) {
    return AudiobookState(
      loading: loading ?? this.loading,
      starting: starting ?? this.starting,
      audiobook: clearAudiobook ? null : (audiobook ?? this.audiobook),
      timeline: timeline ?? this.timeline,
      activeTimeline: activeTimeline ?? this.activeTimeline,
      activeSegmentIndex: clearActiveSegment ? null : (activeSegmentIndex ?? this.activeSegmentIndex),
      globalPositionMs: globalPositionMs ?? this.globalPositionMs,
      chapterIndex: chapterIndex ?? this.chapterIndex,
      chapterPositionMs: chapterPositionMs ?? this.chapterPositionMs,
      playing: playing ?? this.playing,
      buffering: buffering ?? this.buffering,
      caughtUp: caughtUp ?? this.caughtUp,
      speed: speed ?? this.speed,
      sleepTimerEnd: clearSleepTimer ? null : (sleepTimerEnd ?? this.sleepTimerEnd),
      downloadedChapters: downloadedChapters ?? this.downloadedChapters,
      bookTitle: bookTitle ?? this.bookTitle,
      coverUrl: coverUrl ?? this.coverUrl,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

final audiobookControllerProvider =
    NotifierProvider.autoDispose.family<AudiobookController, AudiobookState, String>(
  AudiobookController.new,
);
