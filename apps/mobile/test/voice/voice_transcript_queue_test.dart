import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/domain/voice_models.dart';
import 'package:tomeza/features/voice/domain/voice_transcript_queue.dart';

/// What survives a bad network on the way to the character's memory.
///
/// The queue is the only record of a call the server ever gets — audio never
/// reaches it — so each rule about what is kept and what is dropped is pinned
/// here rather than left to the call controller to get right by accident.
VoiceCallCaption line(String text, {bool fromCaller = true}) => VoiceCallCaption(
  speaker: fromCaller ? VoiceCallSpeaker.caller : VoiceCallSpeaker.character,
  text: text,
);

List<String> textsOf(List<VoiceCallCaption> lines) =>
    lines.map((line) => line.text).toList();

void main() {
  test('hands out lines oldest first', () {
    final queue = VoiceTranscriptQueue()
      ..add(line('first'))
      ..add(line('second'));

    expect(textsOf(queue.take()), ['first', 'second']);
    expect(queue.isEmpty, isTrue);
  });

  test('sends no more than one request will carry', () {
    final queue = VoiceTranscriptQueue();
    for (var index = 0; index < VoiceTranscriptQueue.batchSize + 10; index += 1) {
      queue.add(line('line $index'));
    }

    expect(queue.take(), hasLength(VoiceTranscriptQueue.batchSize));
    expect(queue.isEmpty, isFalse);
  });

  test('puts a batch that never landed back at the front', () {
    // A heartbeat that fails must cost a delay, not a memory — and the lines
    // have to go back in the order they were spoken.
    final queue = VoiceTranscriptQueue()..add(line('first'));
    final batch = queue.take();
    queue.add(line('second'));

    queue.restore(batch);

    expect(textsOf(queue.take()), ['first', 'second']);
  });

  test('spends its last request on the end of the call', () {
    // After a run of failed heartbeats there is more queued than one request
    // carries, and the server keeps the tail of a call anyway.
    final queue = VoiceTranscriptQueue();
    for (var index = 0; index < VoiceTranscriptQueue.batchSize + 5; index += 1) {
      queue.add(line('line $index'));
    }

    final drained = queue.drain();

    expect(drained, hasLength(VoiceTranscriptQueue.batchSize));
    expect(drained.last.text, 'line ${VoiceTranscriptQueue.batchSize + 4}');
    expect(queue.isEmpty, isTrue);
  });

  test('drops the oldest rather than growing without limit offline', () {
    final queue = VoiceTranscriptQueue();
    for (var index = 0; index < 400; index += 1) {
      queue.add(line('line $index'));
    }

    // Whatever the cap is, the newest line is still the one on the way out.
    expect(queue.drain().last.text, 'line 399');
  });

  test('truncates a line the API would reject outright', () {
    // A 400 on the heartbeat stalls the meter, and a stalled meter ends the
    // call — a monologue must lose its tail, not the call.
    final queue = VoiceTranscriptQueue()..add(line('x' * 5000));

    final sent = queue.take().single.text;
    expect(sent.length, 2000);
    expect(sent.endsWith('…'), isTrue);
  });

  test('ignores a line with nothing in it', () {
    final queue = VoiceTranscriptQueue()
      ..add(line('   '))
      ..add(line(''));

    expect(queue.isEmpty, isTrue);
  });

  test('keeps who said what', () {
    final queue = VoiceTranscriptQueue()
      ..add(line('Are you there?'))
      ..add(line('I am.', fromCaller: false));

    expect(queue.take().map((line) => line.toJson()), [
      {'speaker': 'caller', 'text': 'Are you there?'},
      {'speaker': 'character', 'text': 'I am.'},
    ]);
  });
}
