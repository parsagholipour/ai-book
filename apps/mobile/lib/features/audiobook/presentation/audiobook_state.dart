import '../domain/audiobook_models.dart';
import '../domain/audiobook_timeline.dart';

/// Everything the listening screen draws, as `AudiobookController` keeps it.
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
    this.offline = false,
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

  /// The server is out of reach and [audiobook] is the manifest kept on this
  /// phone: only chapters already downloaded play, and a narration that was
  /// still being made when it was kept is not shown as being made now.
  final bool offline;

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
    bool clearActiveTimeline = false,
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
    bool? offline,
  }) {
    return AudiobookState(
      loading: loading ?? this.loading,
      starting: starting ?? this.starting,
      audiobook: clearAudiobook ? null : (audiobook ?? this.audiobook),
      timeline: timeline ?? this.timeline,
      activeTimeline: clearActiveTimeline ? null : (activeTimeline ?? this.activeTimeline),
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
      offline: offline ?? this.offline,
    );
  }
}
