import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import 'voice_recording_encoder.dart';

/// Keeps a call's audio on the device so the caller can take it away.
///
/// Nothing about this reaches the server: the app already holds both halves of
/// the conversation — mic chunks on their way to Gemini and reply chunks on
/// their way to the speaker — and a recording is those two written onto one
/// timeline. Uploading them would undo the whole point of the app holding its
/// own socket.
///
/// The two halves arrive at different rates, 16 kHz from the microphone and
/// 24 kHz from Gemini. The spool runs at 24 kHz so the synthesised voice is
/// written through untouched and only the microphone is resampled; it is the
/// leg that was already band-limited by the phone.
///
/// One file, mixed in place, rather than a track each. The only reason to keep
/// them apart would be to trim one of them, and the only trim that happens —
/// dropping the reply the caller talked over — always cuts at the live edge,
/// where the microphone has not written anything yet.
class VoiceCallRecorder {
  VoiceCallRecorder({
    required this.encoder,
    Directory? spoolRoot,
    Directory? exportRoot,
  }) : _spoolOverride = spoolRoot,
       _exportOverride = exportRoot;

  /// The rate Gemini speaks at, and so the rate the spool runs at.
  static const sampleRate = 24000;

  static const spoolDirectoryName = 'tomeza_voice_spool';

  /// Alongside `tomeza_exports/<projectId>/`, which holds book files. A
  /// recording belongs to a call rather than to a book, so it gets its own
  /// subdirectory instead of a project's.
  static const exportDirectoryName = 'tomeza_exports/voice-calls';

  /// Recordings left on the device are swept after this. They are large, and a
  /// file the caller shared a week ago has been saved wherever they wanted it.
  static const exportRetention = Duration(days: 7);

  /// Past this the spool stops growing. The server caps a call at 30 minutes,
  /// so anything beyond is a clock that has jumped rather than a long call —
  /// and seeking to a bad offset would zero-fill the gap all the way there.
  static const _maxRecordedSeconds = 35 * 60;

  static const _bytesPerSample = 2;
  static const _samplesPerMs = sampleRate ~/ 1000;
  static const _zeroFillChunk = 64 * 1024;

  final VoiceRecordingEncoder encoder;
  final Directory? _spoolOverride;
  final Directory? _exportOverride;

  RandomAccessFile? _spool;
  File? _spoolFile;
  Directory? _spoolDirectory;

  /// Where the character's audio has been written up to, in samples.
  ///
  /// Gemini streams a reply faster than it is spoken, so arrival time is not
  /// playback time. Laying each chunk down after the previous one is what keeps
  /// a long reply from collapsing into the instant it arrived.
  int _characterCursor = 0;

  /// Where the microphone has been written up to, in samples.
  int _callerCursor = 0;

  /// How far ahead of [_callerCursor] a chunk has to land before it counts as a
  /// gap rather than as the next chunk of the same continuous capture.
  ///
  /// Capture is unbroken, but 16 kHz into 24 kHz does not divide evenly across
  /// a chunk, so the arrival offset and the samples actually written disagree
  /// by up to one sample per chunk. Trusting the offset each time would leave a
  /// hole at every join — sixteen single-sample dropouts a second, which is a
  /// buzz rather than a rounding error. Anything genuinely interrupted (mute, a
  /// reconnect) is hundreds of milliseconds, far past this.
  static const _callerGapMs = 200;

  final _Pcm16Upsampler _micUpsampler = _Pcm16Upsampler(from: 16000, to: sampleRate);

  bool get isRecording => _spool != null;

  /// Milliseconds of audio on disk, which is the length of the file the caller
  /// would get if they asked for it now.
  int get recordedMs {
    final spool = _spool;
    if (spool == null) {
      return 0;
    }
    return spool.lengthSync() ~/ (_samplesPerMs * _bytesPerSample);
  }

  static String safeSegment(String value) {
    final safe = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '-');
    return safe.isEmpty ? 'unknown' : safe;
  }

  /// Opens the spool for a call. Returns false when the device would not have
  /// it, which the caller shows by hiding the download rather than by failing
  /// the call — a recording is not worth losing a conversation over.
  Future<bool> start(String callId) async {
    await dispose();
    try {
      final root = _spoolOverride ?? await getTemporaryDirectory();
      final directory = Directory(
        '${root.path}/$spoolDirectoryName/${safeSegment(callId)}',
      );
      await directory.create(recursive: true);
      final file = File('${directory.path}/call.pcm');
      _spool = file.openSync(mode: FileMode.write);
      _spoolFile = file;
      _spoolDirectory = directory;
      _characterCursor = 0;
      _callerCursor = 0;
      _micUpsampler.reset();
      // Best effort, and deliberately not awaited into the failure path: a
      // sweep that cannot run is not a reason to refuse to record.
      unawaited(_sweep(callId));
      return true;
    } catch (_) {
      await dispose();
      return false;
    }
  }

  /// Writes the caller's microphone at [offsetMs], resampled up to the spool
  /// rate.
  ///
  /// Called downstream of the mute filter, so a muted stretch is a real gap
  /// here and comes out as silence — it was not part of the conversation and
  /// Gemini never heard it either.
  void writeCaller(Uint8List pcm16, int offsetMs) {
    if (_spool == null || pcm16.isEmpty) {
      return;
    }
    final resampled = _micUpsampler.convert(pcm16);
    if (resampled.isEmpty) {
      return;
    }
    final requested = offsetMs * _samplesPerMs;
    final start = requested > _callerCursor + _callerGapMs * _samplesPerMs
        ? requested
        : _callerCursor;
    _mixInto(start, resampled);
    _callerCursor = start + resampled.length;
  }

  /// Writes the character's reply, queued after whatever is already down.
  void writeCharacter(Uint8List pcm16, int offsetMs) {
    if (_spool == null || pcm16.isEmpty) {
      return;
    }
    final samples = _readSamples(pcm16);
    final start = max(offsetMs * _samplesPerMs, _characterCursor);
    _mixInto(start, samples);
    _characterCursor = start + samples.length;
  }

  /// Drops the queued reply the caller has just talked over.
  ///
  /// The speaker does the same thing at the same moment — `flushPlayback()`
  /// throws away everything `AudioTrack` has not reached yet — so keeping it
  /// here would put words in the recording that nobody in the call heard.
  void truncateAt(int offsetMs) {
    final spool = _spool;
    if (spool == null) {
      return;
    }
    final target = max(0, offsetMs) * _samplesPerMs * _bytesPerSample;
    try {
      if (spool.lengthSync() > target) {
        spool.truncateSync(target);
      }
    } catch (_) {
      return;
    }
    final edge = max(0, offsetMs) * _samplesPerMs;
    _characterCursor = min(_characterCursor, edge);
    // The microphone runs a sample or two either side of the wall clock, so it
    // can have written just past the cut. Pulling it back keeps the next chunk
    // flush against the truncation instead of leaving a hole at it.
    _callerCursor = min(_callerCursor, edge);
  }

  /// Encodes everything recorded so far and returns the file to hand over.
  ///
  /// Written to a `.part` and renamed, the same way a download is, so a failed
  /// encode never leaves something that looks like a finished recording.
  Future<File> export({required String filename}) async {
    final spool = _spool;
    final spoolFile = _spoolFile;
    if (spool == null || spoolFile == null) {
      throw StateError('This call is not being recorded.');
    }
    spool.flushSync();
    if (spool.lengthSync() <= 0) {
      throw StateError('There is nothing recorded yet.');
    }

    final root = _exportOverride ?? await getApplicationDocumentsDirectory();
    final directory = Directory('${root.path}/$exportDirectoryName');
    await directory.create(recursive: true);

    final destination = File('${directory.path}/${safeSegment(filename)}');
    final partial = File('${destination.path}.part');
    if (await partial.exists()) {
      await partial.delete();
    }
    try {
      await encoder.encode(
        pcm: spoolFile,
        destination: partial,
        sampleRate: sampleRate,
      );
    } catch (_) {
      if (await partial.exists()) {
        await partial.delete().catchError((_) => partial);
      }
      rethrow;
    }
    if (await destination.exists()) {
      await destination.delete();
    }
    return partial.rename(destination.path);
  }

  /// Closes the spool and deletes it.
  ///
  /// Only the end of the screen calls this, not the end of the call: hanging up
  /// tears the audio stack down while the caller is still looking at a screen
  /// that offers them the recording.
  Future<void> dispose() async {
    final spool = _spool;
    _spool = null;
    final directory = _spoolDirectory;
    _spoolDirectory = null;
    _spoolFile = null;
    _characterCursor = 0;
    try {
      spool?.closeSync();
    } catch (_) {
      // A handle that will not close is still a handle we are done with.
    }
    if (directory != null && await directory.exists()) {
      await directory.delete(recursive: true).catchError((_) => directory);
    }
  }

  /// Adds [samples] to whatever is already at [offsetSamples].
  ///
  /// Additive rather than overwriting because the two speakers overlap: the
  /// character's reply is usually already on disk ahead of the live edge when
  /// the caller talks over it, and the recording should hold both.
  void _mixInto(int offsetSamples, Int16List samples) {
    final spool = _spool;
    if (spool == null || samples.isEmpty || offsetSamples < 0) {
      return;
    }
    if (offsetSamples + samples.length > _maxRecordedSeconds * sampleRate) {
      return;
    }

    try {
      final offset = offsetSamples * _bytesPerSample;
      final length = spool.lengthSync();
      if (offset > length) {
        _zeroFill(spool, length, offset - length);
      }

      final overlapBytes = max(0, min(samples.lengthInBytes, length - offset));
      if (overlapBytes >= _bytesPerSample) {
        spool.setPositionSync(offset);
        final existing = spool.readSync(overlapBytes - (overlapBytes % _bytesPerSample));
        final view = ByteData.sublistView(existing);
        for (var i = 0; i < view.lengthInBytes ~/ _bytesPerSample; i += 1) {
          samples[i] = _clampSample(samples[i] + view.getInt16(i * _bytesPerSample, Endian.little));
        }
      }

      spool.setPositionSync(offset);
      spool.writeFromSync(_writeSamples(samples));
    } catch (_) {
      // A device that has run out of room stops recording rather than taking
      // the call down with it.
      unawaited(dispose().catchError((_) {}));
    }
  }

  static void _zeroFill(RandomAccessFile spool, int from, int bytes) {
    spool.setPositionSync(from);
    final silence = Uint8List(min(bytes, _zeroFillChunk));
    var written = 0;
    while (written < bytes) {
      final take = min(silence.length, bytes - written);
      spool.writeFromSync(silence, 0, take);
      written += take;
    }
  }

  /// Drops spools left behind by a call that died with the app, and recordings
  /// old enough that the caller has already put them where they wanted them.
  Future<void> _sweep(String callId) async {
    final keep = safeSegment(callId);
    try {
      final spoolRoot = _spoolOverride ?? await getTemporaryDirectory();
      final spools = Directory('${spoolRoot.path}/$spoolDirectoryName');
      if (await spools.exists()) {
        await for (final entry in spools.list()) {
          if (entry is Directory && entry.path.split('/').last != keep) {
            await entry.delete(recursive: true).catchError((_) => entry);
          }
        }
      }
    } catch (_) {
      // Nothing here is load-bearing.
    }

    try {
      final exportRoot = _exportOverride ?? await getApplicationDocumentsDirectory();
      final exports = Directory('${exportRoot.path}/$exportDirectoryName');
      if (!await exports.exists()) {
        return;
      }
      final cutoff = DateTime.now().subtract(exportRetention);
      await for (final entry in exports.list()) {
        if (entry is! File) {
          continue;
        }
        final stat = await entry.stat();
        if (stat.modified.isBefore(cutoff)) {
          await entry.delete().catchError((_) => entry);
        }
      }
    } catch (_) {
      // Same.
    }
  }

  static Int16List _readSamples(Uint8List bytes) {
    final view = ByteData.sublistView(bytes);
    final samples = Int16List(bytes.lengthInBytes ~/ _bytesPerSample);
    for (var i = 0; i < samples.length; i += 1) {
      samples[i] = view.getInt16(i * _bytesPerSample, Endian.little);
    }
    return samples;
  }

  static Uint8List _writeSamples(Int16List samples) {
    final bytes = Uint8List(samples.length * _bytesPerSample);
    final view = ByteData.sublistView(bytes);
    for (var i = 0; i < samples.length; i += 1) {
      view.setInt16(i * _bytesPerSample, samples[i], Endian.little);
    }
    return bytes;
  }

  static int _clampSample(int value) => value < -32768
      ? -32768
      : value > 32767
          ? 32767
          : value;
}

/// Linear resampler for one continuous PCM16 stream.
///
/// Between 16 kHz and 24 kHz the ratio is exactly 2:3, so the read position is
/// carried as an integer over a denominator of 3 rather than as a double — a
/// half-hour call is a couple of million steps, and a rational cursor cannot
/// drift across them.
///
/// The last sample of every chunk is held back as [_carry] so the first output
/// of the next chunk interpolates across the join instead of restarting from
/// it, which is audible as a click once per chunk — about sixteen times a
/// second at the capture buffer this call uses.
class _Pcm16Upsampler {
  _Pcm16Upsampler({required int from, required int to})
    : _stepNumerator = from ~/ _gcd(from, to),
      _denominator = to ~/ _gcd(from, to);

  /// Input samples consumed per output sample, as [_stepNumerator] over
  /// [_denominator] — 2/3 going from 16 kHz to 24 kHz.
  final int _stepNumerator;
  final int _denominator;

  int _cursor = 0;
  int _carry = 0;
  bool _hasCarry = false;

  void reset() {
    _cursor = 0;
    _carry = 0;
    _hasCarry = false;
  }

  Int16List convert(Uint8List pcm16) {
    final input = VoiceCallRecorder._readSamples(pcm16);
    if (input.isEmpty) {
      return Int16List(0);
    }

    final base = _hasCarry ? 1 : 0;
    final virtual = input.length + base;
    final last = (virtual - 1) * _denominator;

    final output = <int>[];
    var cursor = _cursor;
    while (cursor <= last) {
      final index = cursor ~/ _denominator;
      final remainder = cursor % _denominator;
      final current = _sampleAt(index, input, base);
      output.add(
        remainder == 0
            ? current
            : current + ((_sampleAt(index + 1, input, base) - current) * remainder) ~/ _denominator,
      );
      cursor += _stepNumerator;
    }

    _cursor = cursor - last;
    _carry = input[input.length - 1];
    _hasCarry = true;
    return Int16List.fromList(output);
  }

  int _sampleAt(int index, Int16List input, int base) {
    if (base == 1 && index == 0) {
      return _carry;
    }
    final real = index - base;
    return input[real < input.length ? real : input.length - 1];
  }

  static int _gcd(int a, int b) => b == 0 ? a : _gcd(b, a % b);
}
