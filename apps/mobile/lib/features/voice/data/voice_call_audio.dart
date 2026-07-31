import 'dart:async';

import 'package:flutter/services.dart';
import 'package:record/record.dart';

/// Microphone and speaker for a live character call.
///
/// Capture goes through `record`, which owns the permission prompt, the Android
/// audio source and the iOS session category. Playback goes through a small
/// platform channel of our own rather than an off-the-shelf PCM plugin, because
/// every published one renders on the media audio path: that puts the call on
/// the wrong volume rocker, and — the part that actually breaks calls — leaves
/// the character's voice out of the reference signal the platform echo canceller
/// subtracts from the mic. Without that, Gemini hears itself through the
/// speaker, decides the user has started talking, and cuts its own reply off.
abstract interface class VoiceCallAudio {
  Future<bool> ensurePermission();

  /// Starts capture and playback. Yields mic PCM16 mono at [inputSampleRate].
  Future<Stream<Uint8List>> start({
    required int inputSampleRate,
    required int outputSampleRate,
    required bool speakerphone,
  });

  /// Queues character audio: PCM16 mono at the output rate given to [start].
  Future<void> play(Uint8List pcm16);

  /// Drops queued audio that has not been heard yet, so an interruption lands.
  Future<void> flushPlayback();

  Future<void> setMuted(bool muted);

  Future<void> setSpeakerphone(bool enabled);

  Future<void> stop();
}

class PlatformVoiceCallAudio implements VoiceCallAudio {
  PlatformVoiceCallAudio({AudioRecorder? recorder, MethodChannel? playback})
    : _recorder = recorder ?? AudioRecorder(),
      _playback = playback ?? const MethodChannel(_playbackChannel);

  static const _playbackChannel = 'tomeza/voice_call_audio';

  /// Small enough that a barge-in reaches Gemini quickly, large enough not to
  /// spend the call in platform-channel overhead. ~64 ms at 16 kHz.
  static const _captureBufferBytes = 2048;

  final AudioRecorder _recorder;
  final MethodChannel _playback;
  bool _muted = false;
  bool _started = false;

  @override
  Future<bool> ensurePermission() => _recorder.hasPermission();

  @override
  Future<Stream<Uint8List>> start({
    required int inputSampleRate,
    required int outputSampleRate,
    required bool speakerphone,
  }) async {
    await _playback.invokeMethod<void>('start', {
      'sampleRate': outputSampleRate,
      'speakerphone': speakerphone,
    });
    final stream = await _recorder.startStream(
      RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: inputSampleRate,
        numChannels: 1,
        echoCancel: true,
        noiseSuppress: true,
        autoGain: true,
        streamBufferSize: _captureBufferBytes,
        // `pauseResume` so an incoming phone call suspends the mic and hands it
        // back afterwards without the caller having to redial.
        audioInterruption: AudioInterruptionMode.pauseResume,
        androidConfig: AndroidRecordConfig(
          audioSource: AndroidAudioSource.voiceCommunication,
          audioManagerMode: AudioManagerMode.modeInCommunication,
          speakerphone: speakerphone,
        ),
        iosConfig: const IosRecordConfig(
          categoryOptions: [
            IosAudioCategoryOption.defaultToSpeaker,
            IosAudioCategoryOption.allowBluetooth,
            IosAudioCategoryOption.allowBluetoothA2DP,
          ],
        ),
      ),
    );
    _started = true;
    // Muting drops frames here rather than disabling the track, so the socket
    // sees a clean silence instead of a stream that stops and restarts.
    return stream.where((_) => !_muted);
  }

  @override
  Future<void> play(Uint8List pcm16) async {
    if (!_started || pcm16.isEmpty) return;
    await _playback.invokeMethod<bool>('write', {'bytes': pcm16});
  }

  @override
  Future<void> flushPlayback() async {
    if (!_started) return;
    await _playback.invokeMethod<void>('flush');
  }

  @override
  Future<void> setMuted(bool muted) async {
    _muted = muted;
  }

  @override
  Future<void> setSpeakerphone(bool enabled) async {
    if (!_started) return;
    await _playback.invokeMethod<void>('setSpeakerphone', {'enabled': enabled});
  }

  @override
  Future<void> stop() async {
    _started = false;
    _muted = false;
    await _recorder.cancel().catchError((_) {});
    await _playback.invokeMethod<void>('stop').catchError((_) {});
  }
}
