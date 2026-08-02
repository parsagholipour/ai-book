import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/data/voice_call_recorder.dart';
import 'package:tomeza/features/voice/data/voice_recording_encoder.dart';

/// Copies the spool through instead of encoding it, so the assertions below can
/// read the samples the recorder laid down. The real encoder is a platform
/// channel, and the natives are not there under `flutter test`.
class CopyingEncoder implements VoiceRecordingEncoder {
  int calls = 0;
  int? sawSampleRate;

  @override
  Future<void> encode({
    required File pcm,
    required File destination,
    required int sampleRate,
  }) async {
    calls += 1;
    sawSampleRate = sampleRate;
    await destination.writeAsBytes(await pcm.readAsBytes());
  }
}

class FailingEncoder implements VoiceRecordingEncoder {
  @override
  Future<void> encode({
    required File pcm,
    required File destination,
    required int sampleRate,
  }) async {
    // Half a file, then a failure — the case a `.part` rename exists to catch.
    await destination.writeAsBytes(Uint8List(64));
    throw StateError('no codec');
  }
}

Uint8List pcm(List<int> samples) {
  final bytes = Uint8List(samples.length * 2);
  final view = ByteData.sublistView(bytes);
  for (var i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i], Endian.little);
  }
  return bytes;
}

/// A run of [samples] identical samples, which is what a constant tone looks
/// like once it has been through the resampler.
Uint8List tone(int value, int samples) => pcm(List.filled(samples, value));

List<int> samplesOf(Uint8List bytes) {
  final view = ByteData.sublistView(bytes);
  return [
    for (var i = 0; i < bytes.lengthInBytes ~/ 2; i += 1) view.getInt16(i * 2, Endian.little),
  ];
}

void main() {
  late Directory root;
  late CopyingEncoder encoder;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('voice-recorder-test');
    encoder = CopyingEncoder();
  });

  tearDown(() async {
    if (await root.exists()) {
      await root.delete(recursive: true);
    }
  });

  VoiceCallRecorder build({VoiceRecordingEncoder? using}) => VoiceCallRecorder(
    encoder: using ?? encoder,
    spoolRoot: Directory('${root.path}/spool'),
    exportRoot: Directory('${root.path}/documents'),
  );

  Future<List<int>> exportedSamples(VoiceCallRecorder recorder) async {
    final file = await recorder.export(filename: 'call.m4a');
    return samplesOf(await file.readAsBytes());
  }

  test('writes the character through at its own rate', () async {
    final recorder = build();
    expect(await recorder.start('call-1'), isTrue);

    recorder.writeCharacter(pcm([100, -100, 200]), 0);

    expect(await exportedSamples(recorder), [100, -100, 200]);
    expect(encoder.sawSampleRate, VoiceCallRecorder.sampleRate);
    await recorder.dispose();
  });

  test('resamples the microphone up to the spool rate', () async {
    final recorder = build();
    await recorder.start('call-1');

    // 16 kHz in, 24 kHz out: three samples for every two.
    recorder.writeCaller(tone(1000, 160), 0);

    final samples = await exportedSamples(recorder);
    expect(samples.length, closeTo(240, 2));
    // A constant tone must stay constant — interpolation between two equal
    // samples is the same sample, so anything else here is a resampler bug.
    expect(samples.every((value) => value == 1000), isTrue);
    await recorder.dispose();
  });

  test('carries the resampler across chunk boundaries', () async {
    final recorder = build();
    await recorder.start('call-1');

    // One long chunk against the same audio split in two: the join must not
    // change the output, or every chunk boundary is an audible click.
    recorder.writeCaller(tone(500, 320), 0);
    final whole = await exportedSamples(recorder);
    await recorder.dispose();

    final split = build();
    await split.start('call-2');
    split.writeCaller(tone(500, 160), 0);
    split.writeCaller(tone(500, 160), 10);
    final joined = await exportedSamples(split);
    await split.dispose();

    expect(joined.length, whole.length);
    expect(joined.every((value) => value == 500), isTrue);
  });

  test('fills the gap when nothing was said', () async {
    final recorder = build();
    await recorder.start('call-1');

    recorder.writeCharacter(pcm([700]), 0);
    // Ten milliseconds later, which at 24 kHz is 240 samples along.
    recorder.writeCharacter(pcm([900]), 10);

    final samples = await exportedSamples(recorder);
    expect(samples.length, 241);
    expect(samples[0], 700);
    expect(samples[240], 900);
    // A muted stretch, or a reconnect, comes out as the silence it was.
    expect(samples.sublist(1, 240).every((value) => value == 0), isTrue);
    await recorder.dispose();
  });

  test('mixes both speakers where they overlap', () async {
    final recorder = build();
    await recorder.start('call-1');

    // The reply is already on disk ahead of the live edge when the caller
    // talks over it, so the caller's audio has to add rather than overwrite.
    recorder.writeCharacter(pcm([1000, 1000, 1000, 1000, 1000, 1000]), 0);
    recorder.writeCaller(tone(250, 4), 0);

    final samples = await exportedSamples(recorder);
    expect(samples[0], 1250);
    expect(samples[1], 1250);
    await recorder.dispose();
  });

  test('clamps a mix instead of wrapping it', () async {
    final recorder = build();
    await recorder.start('call-1');

    recorder.writeCharacter(pcm([32000, -32000, 32000, -32000, 0, 0]), 0);
    recorder.writeCaller(tone(30000, 4), 0);

    final samples = await exportedSamples(recorder);
    // Two loud voices at once must sound clipped, not inverted — a wrap would
    // put a full-scale crack in the file.
    expect(samples[0], 32767);
    expect(samples[1], -2000);
    await recorder.dispose();
  });

  test('queues a reply after the previous one rather than at arrival time', () async {
    final recorder = build();
    await recorder.start('call-1');

    // Gemini streams a reply faster than it is spoken: three chunks that all
    // arrive at offset 0 are three chunks laid end to end, not on top of
    // each other.
    recorder.writeCharacter(pcm([1, 2, 3]), 0);
    recorder.writeCharacter(pcm([4, 5, 6]), 0);

    expect(await exportedSamples(recorder), [1, 2, 3, 4, 5, 6]);
    await recorder.dispose();
  });

  test('drops the reply the caller talked over', () async {
    final recorder = build();
    await recorder.start('call-1');

    // A whole second of reply, queued ahead of the live edge.
    recorder.writeCharacter(tone(800, VoiceCallRecorder.sampleRate), 0);
    expect(recorder.recordedMs, 1000);

    // The caller cuts in 10 ms after it started, and the speaker throws away
    // everything past that. The file has to agree.
    recorder.truncateAt(10);
    expect(recorder.recordedMs, 10);

    // And the next reply resumes from the cut, not from where the discarded
    // one had reached.
    recorder.writeCharacter(pcm([900]), 10);
    final samples = await exportedSamples(recorder);
    expect(samples.length, 241);
    expect(samples[240], 900);
    await recorder.dispose();
  });

  test('refuses to export a call with nothing in it', () async {
    final recorder = build();
    await recorder.start('call-1');

    await expectLater(recorder.export(filename: 'call.m4a'), throwsStateError);
    await recorder.dispose();
  });

  test('leaves nothing behind when the encoder fails', () async {
    final recorder = build(using: FailingEncoder());
    await recorder.start('call-1');
    recorder.writeCharacter(pcm([1, 2, 3]), 0);

    await expectLater(recorder.export(filename: 'call.m4a'), throwsStateError);

    // Neither the half-written file nor anything that looks like a finished
    // recording survives a failed encode.
    final exports = Directory(
      '${root.path}/documents/${VoiceCallRecorder.exportDirectoryName}',
    );
    expect(exports.listSync(), isEmpty);
    await recorder.dispose();
  });

  test('deletes the spool when the screen is left', () async {
    final recorder = build();
    await recorder.start('call-1');
    recorder.writeCharacter(pcm([1, 2, 3]), 0);
    expect(recorder.isRecording, isTrue);

    await recorder.dispose();

    expect(recorder.isRecording, isFalse);
    expect(
      Directory(
        '${root.path}/spool/${VoiceCallRecorder.spoolDirectoryName}/call-1',
      ).existsSync(),
      isFalse,
    );
  });

  test('sweeps spools a crashed call left behind', () async {
    final stale = Directory(
      '${root.path}/spool/${VoiceCallRecorder.spoolDirectoryName}/call-0',
    );
    await stale.create(recursive: true);
    await File('${stale.path}/call.pcm').writeAsBytes(Uint8List(4096));

    final recorder = build();
    await recorder.start('call-1');
    // The sweep runs unawaited so it never delays a call connecting.
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(stale.existsSync(), isFalse);
    expect(recorder.isRecording, isTrue);
    await recorder.dispose();
  });

  test('sweeps recordings old enough to have been saved elsewhere', () async {
    final exports = Directory(
      '${root.path}/documents/${VoiceCallRecorder.exportDirectoryName}',
    );
    await exports.create(recursive: true);
    final old = File('${exports.path}/old-call.m4a');
    final recent = File('${exports.path}/recent-call.m4a');
    await old.writeAsBytes(Uint8List(16));
    await recent.writeAsBytes(Uint8List(16));
    await old.setLastModified(
      DateTime.now().subtract(VoiceCallRecorder.exportRetention * 2),
    );

    final recorder = build();
    await recorder.start('call-1');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(old.existsSync(), isFalse);
    expect(recent.existsSync(), isTrue);
    await recorder.dispose();
  });

  test('ignores audio once the call is over', () async {
    final recorder = build();
    await recorder.start('call-1');
    await recorder.dispose();

    // A socket event can land after teardown. It must be dropped rather than
    // reopening a spool nobody is going to delete.
    recorder.writeCharacter(pcm([1, 2, 3]), 0);
    recorder.writeCaller(tone(100, 16), 0);
    recorder.truncateAt(0);

    expect(recorder.recordedMs, 0);
  });
}
