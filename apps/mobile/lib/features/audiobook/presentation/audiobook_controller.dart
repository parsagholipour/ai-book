import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../billing/data/billing_repository.dart';
import '../../projects/data/offline_library_store.dart';
import '../data/audiobook_cache.dart';
import '../data/audiobook_progress_store.dart';
import '../data/audiobook_repository.dart';
import '../domain/audiobook_models.dart';
import '../domain/audiobook_timeline.dart';
import 'audiobook_player.dart';
import 'audiobook_state.dart';

export 'audiobook_state.dart';

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

  /// How often a listener with no connection has the server asked again.
  static const _reconnectInterval = Duration(seconds: 30);
  static const skipInterval = Duration(seconds: 15);
  static const speedOptions = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

  /// How often the listening position is written down while playing.
  static const _saveInterval = Duration(seconds: 5);

  /// A saved position this close to the end of the book is treated as having
  /// finished it. Resuming a second from the end is a play button that makes
  /// no sound; starting again is what someone who reached the end meant.
  static const _finishedSlackMs = 5000;

  AudiobookPlayer? _player;
  Timer? _pollTimer;
  Timer? _reconnectTimer;
  Timer? _sleepTimer;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  final Map<int, AudiobookChapterTimeline> _timelines = {};
  final Set<int> _queuedChapters = {};
  late AudiobookProgressStore _progressStore;
  bool _downloading = false;
  bool _disposed = false;
  Future<void>? _playbackReset;
  int _refreshSequence = 0;
  int _acceptedRefreshSequence = 0;

  /// Advanced whenever the narration the downloads belong to is replaced
  /// (see [_resetPlayback], and [_refresh] when the server hands back a
  /// different audiobook). A download loop parked on an await compares the
  /// value it captured against this and abandons instead of queueing the old
  /// narration's audio under the new timeline — the same pattern as
  /// `VoiceCallController._connectionSequence`.
  int _syncGeneration = 0;

  /// True while the queue is parked on a finished last chapter. Playing from
  /// there makes no sound, so the play button has to mean something else.
  bool _atEndOfQueue = false;

  /// Where the last session left off, until the chapter holding it has been
  /// downloaded and the player can be put there. Null once it has been used,
  /// or as soon as the listener does anything themselves.
  int? _pendingResumeMs;
  bool _placeRestored = false;

  /// The position worth writing down, kept out of [state] so it can still be
  /// saved while the provider is being torn down.
  String? _placeAudiobookId;
  int _placeMs = 0;
  DateTime? _lastSaveAt;

  @override
  AudiobookState build() {
    _progressStore = ref.read(audiobookProgressStoreProvider);
    ref.onDispose(_teardown);
    scheduleMicrotask(_refresh);
    return const AudiobookState();
  }

  // ---------------------------------------------------------------- lifecycle

  Future<void> _refresh() async {
    final sequence = ++_refreshSequence;
    var generation = _syncGeneration;
    bool superseded() => _disposed || sequence < _acceptedRefreshSequence;
    bool abandoned() =>
        superseded() || generation != _syncGeneration;
    try {
      final audiobook = await ref
          .read(audiobookRepositoryProvider)
          .fetch(projectId);
      if (superseded()) {
        return;
      }
      // Order accepted responses, not requests: polls can take longer than the
      // poll interval, and starting another must not starve the pending one.
      _acceptedRefreshSequence = sequence;
      generation = _syncGeneration;
      // The server answered: whatever kept this screen offline is over, and
      // the manifest is kept for the next time it is not.
      _stopReconnecting();
      if (audiobook != null) {
        unawaited(ref.read(audiobookCacheProvider).saveManifest(audiobook));
      }
      final previous = state.audiobook;
      if (previous != null && audiobook != null && previous.id != audiobook.id) {
        // Replacement elsewhere has the same effect as narrate(): the queue,
        // transcript and listening position all belong to the old audio.
        unawaited(_resetPlayback());
        generation = _syncGeneration;
        _forgetPlace();
        state = state.copyWith(
          starting: false,
          downloadedChapters: const {},
          globalPositionMs: 0,
          chapterIndex: 0,
          chapterPositionMs: 0,
          playing: false,
          buffering: false,
          caughtUp: false,
          clearActiveTimeline: true,
          clearActiveSegment: true,
        );
      }
      if (audiobook == null) {
        // clearError matters here: "never narrated" is the state a retry after a
        // failed load lands in, and a stale error would keep the screen on the
        // error page with no way back to the picker.
        state = state.copyWith(
          loading: false,
          audiobook: null,
          clearAudiobook: true,
          clearError: true,
          offline: false,
        );
        _stopPolling();
        return;
      }

      state = state.copyWith(
        loading: false,
        audiobook: audiobook,
        timeline: AudiobookGlobalTimeline(audiobook.chapters),
        clearError: true,
        offline: false,
      );

      // Publish the replacement before yielding, and keep every refresh behind
      // disposal. Neither an old download nor a concurrent refresh may build a
      // queue until the previous player has gone away.
      await _playbackReset;
      if (abandoned()) {
        return;
      }

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
      await _restorePlace(audiobook);
      if (abandoned()) {
        return;
      }
      unawaited(_syncDownloads());
    } catch (error) {
      if (abandoned()) return;
      if (isOfflineFailure(error)) {
        await _openOffline(error, superseded);
        return;
      }
      // Deliberately not just ApiException: a decode error escaping here left
      // `loading` true forever, a spinner with no error and no retry.
      state = state.copyWith(loading: false, error: userFacingError(error));
    }
  }

  /// The server is out of reach: play what this phone holds.
  ///
  /// A narration already on screen keeps playing; one opened offline is read
  /// from the manifest kept beside its audio (`AudiobookCache.loadManifest`).
  /// Either way only chapters already downloaded are queued — see
  /// [_syncDownloads] — and the server is asked again every
  /// [_reconnectInterval], never at a narrating book's pace. With no manifest
  /// kept there is nothing to be offline with, and the failure is reported
  /// like any other.
  Future<void> _openOffline(Object error, bool Function() superseded) async {
    final current = state.audiobook;
    final kept =
        current ?? await ref.read(audiobookCacheProvider).loadManifest(projectId);
    if (superseded()) return;
    if (kept == null) {
      state = state.copyWith(loading: false, error: userFacingError(error));
      return;
    }
    _goOffline();
    if (current == null) {
      state = state.copyWith(
        audiobook: kept,
        timeline: AudiobookGlobalTimeline(kept.chapters),
      );
      await _restorePlace(kept);
      if (superseded()) return;
    }
    state = state.copyWith(loading: false, clearError: true);
    unawaited(_syncDownloads());
  }

  void _goOffline() {
    _stopPolling();
    _reconnectTimer ??= Timer.periodic(_reconnectInterval, (_) => _refresh());
    state = state.copyWith(offline: true);
  }

  void _stopReconnecting() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
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
    _rememberPlace(force: true);
    _stopPolling();
    _stopReconnecting();
    _sleepTimer?.cancel();
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _subscriptions.clear();
    unawaited(_player?.dispose() ?? Future<void>.value());
    _player = null;
  }

  // -------------------------------------------------------------- saved place

  /// Reads back where this narration was last left off. Runs once per screen.
  ///
  /// A position saved against a *different* narration is deleted rather than
  /// used: re-narrating a book replaces the audio, so the old number would land
  /// somewhere plausible and wrong.
  Future<void> _restorePlace(MobileAudiobook audiobook) async {
    if (_placeRestored) {
      return;
    }
    _placeRestored = true;
    final generation = _syncGeneration;
    try {
      final saved = await _progressStore.load(projectId);
      if (_disposed || generation != _syncGeneration || saved == null) {
        return;
      }
      final total = state.timeline?.totalDurationMs ?? 0;
      final finished = total > 0 && saved.positionMs >= total - _finishedSlackMs;
      if (saved.audiobookId != audiobook.id || finished) {
        await _progressStore.clear(projectId);
        return;
      }
      _pendingResumeMs = saved.positionMs;
      _placeAudiobookId = saved.audiobookId;
      _placeMs = saved.positionMs;
    } catch (_) {
      // Device storage is a convenience here. Failing to read it means starting
      // the book from the top, never failing to open it.
    }
  }

  /// Writes the listening position down: at most every [_saveInterval] while
  /// playing, and always when playback stops or the screen goes away.
  ///
  /// Saving on a timer rather than only on the way out is what makes this
  /// survive the ordinary end of a listening session — the app is swiped away
  /// or killed in the background, and nothing gets a chance to run.
  void _rememberPlace({bool force = false}) {
    final audiobookId = _placeAudiobookId;
    if (audiobookId == null || _placeMs <= 0) {
      return;
    }
    final now = DateTime.now();
    final last = _lastSaveAt;
    if (!force && last != null && now.difference(last) < _saveInterval) {
      return;
    }
    _lastSaveAt = now;
    unawaited(
      _progressStore
          .save(
            projectId,
            AudiobookListeningPosition(
              audiobookId: audiobookId,
              positionMs: _placeMs,
              updatedAt: now,
            ),
          )
          .catchError((Object _) {
            // Losing a place is never worth interrupting playback over.
          }),
    );
  }

  /// Forgets the position, on the device and in memory. Used when the narration
  /// this position pointed into stops being the book's narration.
  void _forgetPlace() {
    _placeRestored = true;
    _pendingResumeMs = null;
    _placeAudiobookId = null;
    _placeMs = 0;
    _lastSaveAt = null;
    unawaited(_progressStore.clear(projectId).catchError((Object _) {}));
  }

  /// Puts the player back where the listener left off, as soon as the chapter
  /// holding that position is on the device.
  ///
  /// Chapters download in book order, so a position deep in the book waits for
  /// the ones in front of it. Nothing is playing while it waits, which is what
  /// makes the reposition silent when it finally happens.
  Future<void> _applyResumeIfReady() async {
    final target = _pendingResumeMs;
    final timeline = state.timeline;
    if (target == null || timeline == null || _player == null) {
      return;
    }
    if (!_queuedChapters.contains(timeline.resolve(target).chapterIndex)) {
      return;
    }
    _pendingResumeMs = null;
    await seekGlobal(target);
  }

  // ---------------------------------------------------------------- narration

  /// Starts (or replaces) a narration. Returns null once it is under way, or
  /// the reason it could not start.
  ///
  /// The reason is returned rather than stored in [AudiobookState.error]: the
  /// picker sheet is covering the screen, so it reports this itself, and that
  /// leaves `error` meaning only "the narration could not be loaded".
  Future<String?> narrate({required String voice, bool replace = false}) async {
    state = state.copyWith(starting: true, clearError: true);
    final requestId = 'audiobook-${DateTime.now().microsecondsSinceEpoch}';
    try {
      final audiobook = await ref
          .read(audiobookRepositoryProvider)
          .start(
            projectId: projectId,
            voice: voice,
            replace: replace,
            requestId: requestId,
          );
      ref.invalidate(billingProvider);
      if (_disposed) {
        return null;
      }
      // A replacement has a new id, so anything cached for the old one is dead
      // weight on the device.
      if (audiobook != null) {
        unawaited(
          ref.read(audiobookCacheProvider).pruneOtherAudiobooks(projectId, audiobook.id),
        );
      }
      // Different audio for the same book: the old queue, the old transcript
      // and the old position all point into a narration that is gone.
      // Fetches started before this result must not roll back a local change.
      _acceptedRefreshSequence = ++_refreshSequence;
      final reset = _resetPlayback();
      final generation = _syncGeneration;
      _forgetPlace();
      await reset;
      if (_disposed || generation != _syncGeneration) {
        return null;
      }
      state = state.copyWith(
        starting: false,
        audiobook: audiobook,
        timeline: audiobook == null ? null : AudiobookGlobalTimeline(audiobook.chapters),
        downloadedChapters: const {},
        globalPositionMs: 0,
        chapterIndex: 0,
        chapterPositionMs: 0,
        playing: false,
        caughtUp: false,
        clearActiveTimeline: true,
        clearActiveSegment: true,
      );
      _startPolling();
      unawaited(_refresh());
      return null;
    } catch (error) {
      // Deliberately not just ApiException: anything that escapes here leaves
      // the confirm button spinning on "Starting…" with no way back.
      if (!_disposed) {
        state = state.copyWith(starting: false);
      }
      return userFacingError(error);
    }
  }

  // ----------------------------------------------------------------- download

  /// Pulls down every ready chapter that is not already queued, in order.
  ///
  /// Order matters: the listener is at the front of the book, so chapter two is
  /// worth far more than chapter nine even though both are ready.
  Future<void> _syncDownloads() async {
    final audiobook = state.audiobook;
    if (_downloading || _playbackReset != null || audiobook == null) {
      return;
    }
    _downloading = true;
    // Checked after every await below: past any of them the narration may have
    // been replaced, and a stale loop must walk away without touching the
    // queue, the timelines, the player or the state.
    final generation = _syncGeneration;
    bool abandoned() => _disposed || generation != _syncGeneration;
    try {
      final cache = ref.read(audiobookCacheProvider);
      final pending = audiobook.readyChapters
          .where((chapter) => !_queuedChapters.contains(chapter.index))
          .toList(growable: false);

      for (final chapter in pending) {
        if (abandoned()) {
          return;
        }
        File file;
        AudiobookChapterTimeline timeline;
        if (state.offline) {
          // Nothing is downloaded offline. The queue is read positionally, so
          // the first chapter not on this phone ends what can be played.
          final stored = await cache.storedChapter(
            projectId: projectId,
            audiobookId: audiobook.id,
            chapter: chapter,
          );
          if (abandoned()) {
            return;
          }
          if (stored == null) {
            break;
          }
          (file, timeline) = stored;
        } else {
          file = await cache.ensureChapterAudio(
            projectId: projectId,
            audiobookId: audiobook.id,
            chapter: chapter,
          );
          if (abandoned()) {
            return;
          }
          timeline = await cache.ensureChapterTimeline(
            projectId: projectId,
            audiobookId: audiobook.id,
            chapter: chapter,
          );
          if (abandoned()) {
            return;
          }
        }
        _timelines[chapter.index] = timeline;
        _queuedChapters.add(chapter.index);

        final artFile = await _coverArt(audiobook);
        // Also the dispose fence: a player built past this point would have no
        // teardown left to dispose it.
        if (abandoned()) {
          return;
        }
        final track = AudiobookTrack(
          id: '${audiobook.id}:${chapter.index}',
          file: file,
          bookTitle: state.bookTitle ?? 'Your book',
          chapterTitle: chapter.title.isEmpty ? 'Chapter ${chapter.index}' : chapter.title,
          narratorName: audiobook.narratorName,
          artFile: artFile,
        );

        if (_player == null) {
          await _startPlayer([track]);
        } else {
          await _player!.appendTracks([track]);
        }
        if (abandoned()) {
          return;
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
        await _applyResumeIfReady();
      }
    } catch (error) {
      if (!abandoned()) {
        // The connection went mid-download: what is queued keeps playing, and
        // the rest follows once the server answers again.
        if (isOfflineFailure(error)) {
          _goOffline();
        } else {
          state = state.copyWith(error: userFacingError(error));
        }
      }
    } finally {
      _downloading = false;
      // While this loop held `_downloading`, the replacing narration's own
      // sync returned empty-handed — so starting the fresh loop is this one's
      // last job on the way out.
      if (!_disposed && generation != _syncGeneration) {
        unawaited(_syncDownloads());
      }
    }
  }

  /// Drops the queue and everything derived from it, so the next chapter to
  /// land builds a fresh player.
  ///
  /// A new narration is different audio for the same book. Appending its
  /// chapters to the old queue would leave the player holding tracks that are
  /// no longer in the manifest, and the position mapping reads that queue
  /// positionally — it would not fail, it would play the wrong chapter.
  Future<void> _resetPlayback() {
    // Fences any download loop still in flight for the old queue.
    _syncGeneration += 1;
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _subscriptions.clear();
    final player = _player;
    _player = null;
    _timelines.clear();
    _queuedChapters.clear();
    _atEndOfQueue = false;
    // A stale download's finalizer may try to start the new loop while the
    // old player is still disposing. Overlapping resets share that barrier.
    late final Future<void> reset;
    reset = Future.wait<void>([
      ?_playbackReset,
      ?player?.dispose(),
    ]).then<void>((_) {}).whenComplete(() {
      if (identical(_playbackReset, reset)) {
        _playbackReset = null;
      }
    });
    _playbackReset = reset;
    return reset;
  }

  Future<void> _startPlayer(List<AudiobookTrack> tracks) async {
    final player = ref.read(audiobookPlayerFactoryProvider)();
    _player = player;
    await player.setQueue(tracks);
    await player.setSpeed(state.speed);
    // A reset during those awaits already disposed this player; subscribing to
    // it now would resurrect it into a queue it is no longer part of.
    if (!identical(_player, player)) {
      return;
    }

    _subscriptions.add(
      player.positionStream.listen((position) => _onPosition(position.inMilliseconds)),
    );
    _subscriptions.add(player.playingStream.listen((playing) {
      if (_disposed) {
        return;
      }
      // Sound means the queue moved off its end, whichever way it got there —
      // a seek back into the book resumes without anyone asking it to.
      if (playing) {
        _atEndOfQueue = false;
      } else {
        // Stopping is the moment a place is most likely to be wanted back, and
        // the one moment the throttle must not swallow.
        _rememberPlace(force: true);
      }
      state = state.copyWith(
        playing: playing,
        caughtUp: playing ? false : state.caughtUp,
      );
    }));
    _subscriptions.add(player.busyStream.listen((busy) {
      if (!_disposed) {
        state = state.copyWith(buffering: busy);
      }
    }));
    _subscriptions.add(player.currentIndexStream.listen((_) => _onPosition(player.position.inMilliseconds)));
    _subscriptions.add(player.completedStream.listen((_) {
      if (!_disposed) {
        // Deliberately no `playing: false`: the player reports that itself from
        // the same state change. Forcing it here is what once left the button
        // showing Play over audible narration — the player never stopped
        // considering itself playing, so it had nothing left to announce when a
        // seek back into the book resumed it.
        _atEndOfQueue = true;
        state = state.copyWith(
          caughtUp: !(state.timeline?.isFullyPlayable ?? true),
        );
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
    final globalPositionMs = timeline.toGlobal(
      chapterIndex: chapter.index,
      chapterPositionMs: chapterPositionMs,
    );

    state = state.copyWith(
      globalPositionMs: globalPositionMs,
      chapterIndex: chapter.index,
      chapterPositionMs: chapterPositionMs,
      activeTimeline: chapterTimeline,
      activeSegmentIndex: segment?.index,
      clearActiveSegment: segment == null,
    );

    _placeAudiobookId = state.audiobook?.id;
    _placeMs = globalPositionMs;
    _rememberPlace();
  }

  Future<void> togglePlay() async {
    final player = _player;
    if (player == null) {
      return;
    }
    // Play means "from here". A resume that has not landed yet would otherwise
    // pull the listener somewhere else moments later.
    _pendingResumeMs = null;
    if (player.playing) {
      await player.pause();
      return;
    }
    // Playing a queue that already finished makes no sound — the position is
    // sitting at the end of the last chapter. If a later chapter has landed
    // since, Play means "carry on into it".
    if (_atEndOfQueue && await _playNextQueuedChapter()) {
      return;
    }
    await player.play();
  }

  /// Moves onto the chapter after the one the queue stopped on, if it has been
  /// downloaded since. False when there is nothing new to play.
  Future<bool> _playNextQueuedChapter() async {
    final player = _player;
    final timeline = state.timeline;
    if (player == null || timeline == null) {
      return false;
    }
    final queued = timeline.chapters
        .where((chapter) => _queuedChapters.contains(chapter.index))
        .length;
    final next = (player.currentIndex ?? 0) + 1;
    if (next >= queued) {
      return false;
    }
    await player.seek(Duration.zero, index: next);
    await player.play();
    return true;
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
    // Whoever asked for this position owns it now, including when that is
    // _applyResumeIfReady handing over its own target.
    _pendingResumeMs = null;
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
    _atEndOfQueue = false;
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

final audiobookControllerProvider =
    NotifierProvider.autoDispose.family<AudiobookController, AudiobookState, String>(
  AudiobookController.new,
);
