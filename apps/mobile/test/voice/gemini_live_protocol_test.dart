import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/voice/data/gemini_live_socket.dart';

/// The Gemini Live wire format is the part of a call most likely to drift, and
/// the part hardest to notice breaking: a renamed field does not throw, it just
/// makes the character silent. These lock the shapes the client depends on.
void main() {
  test('relay termination is final', () {
    expect(isRetryableGeminiDisconnect('Call ended: connection_expired'), isFalse);
  });

  group('parseGeminiLiveMessage', () {
    test('decodes character audio out of a model turn', () {
      final events = parseGeminiLiveMessage({
        'serverContent': {
          'modelTurn': {
            'parts': [
              {
                'inlineData': {
                  'mimeType': 'audio/pcm;rate=24000',
                  'data': base64Encode([1, 2, 3, 4]),
                },
              },
            ],
          },
        },
      });

      final audio = events.whereType<GeminiLiveAudio>().single;
      expect(audio.pcm16, [1, 2, 3, 4]);
    });

    test('ignores non-audio parts', () {
      final events = parseGeminiLiveMessage({
        'serverContent': {
          'modelTurn': {
            'parts': [
              {
                'inlineData': {
                  'mimeType': 'image/png',
                  'data': base64Encode([9]),
                },
              },
              {'text': 'hello'},
            ],
          },
        },
      });

      expect(events.whereType<GeminiLiveAudio>(), isEmpty);
    });

    test('separates the caller from the character in transcripts', () {
      final events = parseGeminiLiveMessage({
        'serverContent': {
          'inputTranscription': {'text': 'who are you'},
          'outputTranscription': {'text': 'I keep the light.', 'finished': true},
        },
      });

      final transcripts = events.whereType<GeminiLiveTranscript>().toList();
      expect(transcripts, hasLength(2));
      expect(transcripts.first.speaker, GeminiSpeaker.user);
      expect(transcripts.first.finished, isFalse);
      expect(transcripts.last.speaker, GeminiSpeaker.model);
      expect(transcripts.last.text, 'I keep the light.');
      expect(transcripts.last.finished, isTrue);
    });

    test('reports the interruption that means the caller talked over the character', () {
      final events = parseGeminiLiveMessage({
        'serverContent': {'interrupted': true},
      });

      expect(events.whereType<GeminiLiveInterrupted>(), hasLength(1));
    });

    test('captures a resumption handle so a dropped call can pick up mid-conversation', () {
      final events = parseGeminiLiveMessage({
        'sessionResumptionUpdate': {'resumable': true, 'newHandle': 'handle-9'},
      });

      expect(events.whereType<GeminiLiveResumptionHandle>().single.handle, 'handle-9');
    });

    test('ignores a resumption update that is not resumable', () {
      final events = parseGeminiLiveMessage({
        'sessionResumptionUpdate': {'resumable': false, 'newHandle': 'handle-9'},
      });

      expect(events.whereType<GeminiLiveResumptionHandle>(), isEmpty);
    });

    test('surfaces goAway as its own event rather than as a failure', () {
      final events = parseGeminiLiveMessage({
        'goAway': {'timeLeft': '10s'},
      });

      expect(events.whereType<GeminiLiveGoAway>(), hasLength(1));
      expect(events.whereType<GeminiLiveError>(), isEmpty);
    });

    test('survives a frame it does not recognise', () {
      expect(parseGeminiLiveMessage({'somethingNew': 42}), isEmpty);
      expect(parseGeminiLiveMessage(const {}), isEmpty);
    });
  });

  group('isRetryableGeminiDisconnect', () {
    test('redials a routine session recycle', () {
      expect(isRetryableGeminiDisconnect('GoAway received'), isTrue);
      expect(isRetryableGeminiDisconnect('Maximum session duration reached'), isTrue);
      expect(isRetryableGeminiDisconnect('connection reset by peer'), isTrue);
    });

    test('does not redial a failure that will fail again', () {
      // Retrying these four times only makes the user wait longer for the same
      // bad news.
      expect(isRetryableGeminiDisconnect('RESOURCE_EXHAUSTED: quota exceeded'), isFalse);
      expect(isRetryableGeminiDisconnect('PERMISSION_DENIED'), isFalse);
      expect(isRetryableGeminiDisconnect('Invalid auth token'), isFalse);
      expect(isRetryableGeminiDisconnect('Your billing account is delinquent'), isFalse);
    });
  });
}
