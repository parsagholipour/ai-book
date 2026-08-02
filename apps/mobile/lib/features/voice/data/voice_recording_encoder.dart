import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Turns a call's raw PCM spool into a file the caller can keep.
///
/// Encoding happens once, at the moment the recording is asked for, rather than
/// streaming samples across the platform channel for the whole call: a call is
/// a couple of thousand chunks, and paying channel overhead on every one of them
/// to produce a file most calls never ask for is the wrong trade. Native gets a
/// path in and a path out and does the rest.
///
/// An interface rather than a bare call because the natives do not exist under
/// `flutter test` — the same reason `readerViewerBuilderProvider` exists for
/// pdfrx.
abstract interface class VoiceRecordingEncoder {
  /// Reads signed 16-bit little-endian mono PCM from [pcm] and writes AAC in an
  /// MPEG-4 container to [destination].
  Future<void> encode({
    required File pcm,
    required File destination,
    required int sampleRate,
  });
}

class PlatformVoiceRecordingEncoder implements VoiceRecordingEncoder {
  const PlatformVoiceRecordingEncoder({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(_channelName);

  static const _channelName = 'tomeza/voice_call_recorder';

  /// Speech, mono. Low enough that half an hour fits in a few megabytes, high
  /// enough that AAC-LC is transparent for a voice at this sample rate.
  static const _bitrate = 32000;

  final MethodChannel _channel;

  @override
  Future<void> encode({
    required File pcm,
    required File destination,
    required int sampleRate,
  }) async {
    await _channel.invokeMethod<void>('encodeAac', {
      'pcmPath': pcm.path,
      'outputPath': destination.path,
      'sampleRate': sampleRate,
      'bitrate': _bitrate,
    });
  }
}

final voiceRecordingEncoderProvider = Provider<VoiceRecordingEncoder>(
  (ref) => const PlatformVoiceRecordingEncoder(),
);
