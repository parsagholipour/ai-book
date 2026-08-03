import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

/// The audio engine, behind an interface.
///
/// Widget tests cannot load the native player, and the reader solved the same
/// problem for PDFium by injecting its viewer builder. This follows that: the
/// screen and controller only ever see [AudiobookPlayer], and tests swap in a
/// fake through [audiobookPlayerFactoryProvider].
abstract interface class AudiobookPlayer {
  Stream<Duration> get positionStream;
  Stream<int?> get currentIndexStream;

  /// Whether audio is actually running — not whether play was pressed.
  ///
  /// The two differ at the end of the queue, and the play button renders this.
  Stream<bool> get playingStream;

  /// True while buffering or connecting — used to show a spinner on the button.
  Stream<bool> get busyStream;

  /// Fires when the queue runs dry, which is how the player learns it has
  /// caught up with a narration that is still being made.
  Stream<void> get completedStream;

  bool get playing;
  Duration get position;
  int? get currentIndex;

  /// Replaces the queue. Only ever called with chapters that are downloaded.
  Future<void> setQueue(List<AudiobookTrack> tracks, {int initialIndex, Duration initialPosition});

  /// Appends newly finished chapters without interrupting playback.
  Future<void> appendTracks(List<AudiobookTrack> tracks);

  Future<void> play();
  Future<void> pause();
  Future<void> seek(Duration position, {int? index});
  Future<void> setSpeed(double speed);
  Future<void> dispose();
}

class AudiobookTrack {
  const AudiobookTrack({
    required this.id,
    required this.file,
    required this.bookTitle,
    required this.chapterTitle,
    required this.narratorName,
    required this.artFile,
  });

  final String id;
  final File file;
  final String bookTitle;
  final String chapterTitle;
  final String narratorName;
  final File? artFile;
}

typedef AudiobookPlayerFactory = AudiobookPlayer Function();

class JustAudioAudiobookPlayer implements AudiobookPlayer {
  JustAudioAudiobookPlayer() : _player = AudioPlayer();

  final AudioPlayer _player;
  final List<AudiobookTrack> _tracks = [];

  @override
  Stream<Duration> get positionStream => _player.positionStream;

  @override
  Stream<int?> get currentIndexStream => _player.currentIndexStream;

  /// Deliberately not `_player.playingStream`: just_audio's `playing` means
  /// "the play button is engaged", and it stays true once the queue reaches its
  /// end — a finished player reports itself as playing. Folding the processing
  /// state in here is what keeps the button's icon and the sound in agreement,
  /// including when a seek back into the book resumes playback on its own
  /// without `playing` ever having changed.
  @override
  Stream<bool> get playingStream =>
      _player.playerStateStream.map(_isPlaying).distinct();

  @override
  Stream<bool> get busyStream => _player.playerStateStream.map(
    (state) =>
        state.processingState == ProcessingState.loading ||
        state.processingState == ProcessingState.buffering,
  );

  @override
  Stream<void> get completedStream => _player.playerStateStream
      .where((state) => state.processingState == ProcessingState.completed);

  @override
  bool get playing => _isPlaying(_player.playerState);

  static bool _isPlaying(PlayerState state) =>
      state.playing && state.processingState != ProcessingState.completed;

  @override
  Duration get position => _player.position;

  @override
  int? get currentIndex => _player.currentIndex;

  @override
  Future<void> setQueue(
    List<AudiobookTrack> tracks, {
    int initialIndex = 0,
    Duration initialPosition = Duration.zero,
  }) async {
    _tracks
      ..clear()
      ..addAll(tracks);
    if (tracks.isEmpty) {
      await _player.stop();
      return;
    }
    await _player.setAudioSources(
      tracks.map(_sourceFor).toList(growable: false),
      initialIndex: initialIndex.clamp(0, tracks.length - 1),
      initialPosition: initialPosition,
    );
  }

  @override
  Future<void> appendTracks(List<AudiobookTrack> tracks) async {
    if (tracks.isEmpty) {
      return;
    }
    _tracks.addAll(tracks);
    await _player.addAudioSources(tracks.map(_sourceFor).toList(growable: false));
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position, {int? index}) =>
      _player.seek(position, index: index);

  @override
  Future<void> setSpeed(double speed) => _player.setSpeed(speed);

  @override
  Future<void> dispose() => _player.dispose();

  /// The tag is what the lock screen and notification render. Artwork is a
  /// `file://` URI because the media session fetches it without our auth
  /// headers.
  AudioSource _sourceFor(AudiobookTrack track) {
    return AudioSource.file(
      track.file.path,
      tag: MediaItem(
        id: track.id,
        title: track.chapterTitle,
        album: track.bookTitle,
        artist: 'Narrated by ${track.narratorName}',
        artUri: track.artFile == null ? null : Uri.file(track.artFile!.path),
      ),
    );
  }
}

final audiobookPlayerFactoryProvider = Provider<AudiobookPlayerFactory>(
  (ref) => JustAudioAudiobookPlayer.new,
);
