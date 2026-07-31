import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:web_socket_channel/web_socket_channel.dart';

/// One connection to the Gemini Live API.
///
/// The app talks to Gemini directly with a single-use ephemeral token the API
/// minted. The persona, voice, transcription and session-resumption settings are
/// locked into that token server-side, so nothing here can widen what the call
/// is allowed to do — the only thing this sends is the model and the audio.
///
/// This is the mobile counterpart of `apps/web/src/features/voice/
/// BrowserVoiceCallClient.ts`, which uses the JS SDK for the same protocol.
class GeminiLiveSocket {
  GeminiLiveSocket._(this._channel, this._events);

  static const _host = 'generativelanguage.googleapis.com';
  static const _path =
      '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

  /// The socket address for an ephemeral-token call.
  ///
  /// Two details here are not incidental. The scheme must be `wss`: Dart's
  /// `WebSocket.connect` rejects anything else outright, so building this with
  /// `Uri.https` fails every attempt before a packet is sent. And the token is
  /// placed in the query string raw rather than through `queryParameters`,
  /// which would percent-encode the `/` in `auth_tokens/…`. A slash is legal
  /// unencoded in a query, and sending it raw is what the official SDK does.
  static Uri geminiLiveUri(String token) {
    return Uri(
      scheme: 'wss',
      host: _host,
      path: _path,
      query: 'access_token=$token',
    );
  }

  final WebSocketChannel _channel;
  final Stream<GeminiLiveEvent> _events;
  bool _closed = false;

  Stream<GeminiLiveEvent> get events => _events;

  bool get isClosed => _closed;

  /// Opens the socket and sends the setup frame.
  ///
  /// Returns once the socket is up; the first `serverContent` may still be a
  /// moment away. [connect] can be given a [channelFactory] so tests can drive
  /// the protocol without a network.
  static Future<GeminiLiveSocket> connect({
    required String token,
    required String model,
    String? sessionHandle,
    WebSocketChannel Function(Uri uri)? channelFactory,
  }) async {
    final uri = geminiLiveUri(token);
    final channel = (channelFactory ?? WebSocketChannel.connect)(uri);
    await channel.ready;

    final controller = StreamController<GeminiLiveEvent>.broadcast();
    channel.stream.listen(
      (message) => _decode(message, controller),
      onError: (Object error) => controller.add(GeminiLiveError(error.toString())),
      onDone: () {
        controller.add(
          GeminiLiveClosed(
            channel.closeCode,
            channel.closeReason?.trim().isNotEmpty == true
                ? channel.closeReason!.trim()
                : 'Gemini Live connection closed (${channel.closeCode ?? 0}).',
          ),
        );
        controller.close();
      },
      cancelOnError: false,
    );

    final socket = GeminiLiveSocket._(channel, controller.stream);
    socket._send({
      'setup': {
        'model': model.startsWith('models/') ? model : 'models/$model',
        'generationConfig': {
          'responseModalities': ['AUDIO'],
        },
        if (sessionHandle != null && sessionHandle.isNotEmpty)
          'sessionResumption': {'handle': sessionHandle},
      },
    });
    return socket;
  }

  /// Streams a chunk of microphone audio.
  void sendAudio(Uint8List pcm16, int sampleRate) {
    _send({
      'realtimeInput': {
        'audio': {
          'data': base64Encode(pcm16),
          'mimeType': 'audio/pcm;rate=$sampleRate',
        },
      },
    });
  }

  /// Marks the end of the caller's audio, so Gemini stops waiting on a turn it
  /// will not get. Sent when the mic is muted.
  void sendAudioStreamEnd() {
    _send({
      'realtimeInput': {'audioStreamEnd': true},
    });
  }

  void close() {
    if (_closed) return;
    _closed = true;
    unawaited(_channel.sink.close());
  }

  void _send(Map<String, Object?> message) {
    if (_closed) return;
    try {
      _channel.sink.add(jsonEncode(message));
    } catch (_) {
      // A send on a socket the platform has already torn down surfaces through
      // the close event; there is nothing useful to do with it twice.
    }
  }

  static void _decode(Object? message, StreamController<GeminiLiveEvent> controller) {
    final text = switch (message) {
      String value => value,
      List<int> bytes => utf8.decode(bytes, allowMalformed: true),
      _ => null,
    };
    if (text == null || text.isEmpty) return;

    Object? decoded;
    try {
      decoded = jsonDecode(text);
    } catch (_) {
      return;
    }
    if (decoded is! Map<String, dynamic>) return;

    for (final event in parseGeminiLiveMessage(decoded)) {
      controller.add(event);
    }
  }
}

/// Turns one server frame into the events the call controller acts on.
///
/// Pulled out of the socket so the message shapes can be tested directly —
/// they are the part of this protocol most likely to drift.
List<GeminiLiveEvent> parseGeminiLiveMessage(Map<String, dynamic> message) {
  final events = <GeminiLiveEvent>[];

  final setupComplete = message['setupComplete'];
  if (setupComplete != null) {
    events.add(const GeminiLiveReady());
  }

  final serverContent = _mapOf(message['serverContent']);
  if (serverContent != null) {
    if (serverContent['interrupted'] == true) {
      events.add(const GeminiLiveInterrupted());
    }

    final input = _transcript(serverContent['inputTranscription']);
    if (input != null) {
      events.add(GeminiLiveTranscript(speaker: GeminiSpeaker.user, text: input.$1, finished: input.$2));
    }
    final output = _transcript(serverContent['outputTranscription']);
    if (output != null) {
      events.add(GeminiLiveTranscript(speaker: GeminiSpeaker.model, text: output.$1, finished: output.$2));
    }

    final parts = _mapOf(serverContent['modelTurn'])?['parts'];
    if (parts is List) {
      for (final part in parts) {
        final inlineData = _mapOf(_mapOf(part)?['inlineData']);
        final data = inlineData?['data'];
        final mimeType = inlineData?['mimeType'];
        if (data is String && data.isNotEmpty && mimeType is String && mimeType.startsWith('audio/')) {
          events.add(GeminiLiveAudio(base64Decode(data)));
        }
      }
    }

    if (serverContent['turnComplete'] == true) {
      events.add(const GeminiLiveTurnComplete());
    }
  }

  final resumption = _mapOf(message['sessionResumptionUpdate']);
  if (resumption != null && resumption['resumable'] == true) {
    final handle = resumption['newHandle'];
    if (handle is String && handle.isNotEmpty) {
      events.add(GeminiLiveResumptionHandle(handle));
    }
  }

  // `goAway` is Gemini telling the client the session is about to be recycled.
  // It is a routine part of a long call, not a failure.
  if (message['goAway'] != null) {
    events.add(const GeminiLiveGoAway());
  }

  return events;
}

Map<String, dynamic>? _mapOf(Object? value) => value is Map<String, dynamic> ? value : null;

(String, bool)? _transcript(Object? value) {
  final map = _mapOf(value);
  final text = map?['text'];
  if (text is! String || text.isEmpty) return null;
  return (text, map?['finished'] == true);
}

sealed class GeminiLiveEvent {
  const GeminiLiveEvent();
}

class GeminiLiveReady extends GeminiLiveEvent {
  const GeminiLiveReady();
}

class GeminiLiveAudio extends GeminiLiveEvent {
  const GeminiLiveAudio(this.pcm16);

  final Uint8List pcm16;
}

enum GeminiSpeaker { user, model }

class GeminiLiveTranscript extends GeminiLiveEvent {
  const GeminiLiveTranscript({
    required this.speaker,
    required this.text,
    required this.finished,
  });

  final GeminiSpeaker speaker;
  final String text;
  final bool finished;
}

class GeminiLiveTurnComplete extends GeminiLiveEvent {
  const GeminiLiveTurnComplete();
}

class GeminiLiveInterrupted extends GeminiLiveEvent {
  const GeminiLiveInterrupted();
}

class GeminiLiveResumptionHandle extends GeminiLiveEvent {
  const GeminiLiveResumptionHandle(this.handle);

  final String handle;
}

class GeminiLiveGoAway extends GeminiLiveEvent {
  const GeminiLiveGoAway();
}

class GeminiLiveError extends GeminiLiveEvent {
  const GeminiLiveError(this.message);

  final String message;
}

class GeminiLiveClosed extends GeminiLiveEvent {
  const GeminiLiveClosed(this.code, this.reason);

  final int? code;
  final String reason;
}

/// Whether a dropped connection is worth redialling.
///
/// Mirrors `isRetryableGeminiDisconnectReason` in the web client: billing, quota
/// and auth failures will fail again immediately, and retrying them four times
/// just makes the user wait longer for the same bad news. Everything else —
/// including the routine `goAway` recycle — is retried.
bool isRetryableGeminiDisconnect(String reason) {
  final normalized = reason.toLowerCase();
  if (normalized.contains('goaway') ||
      normalized.contains('go away') ||
      normalized.contains('session duration')) {
    return true;
  }
  const fatal = [
    'prepayment credits',
    'billing',
    'quota',
    'resource_exhausted',
    'permission_denied',
    'unauthenticated',
    'unauthorized',
    'forbidden',
    'api key',
    'auth token',
    'access token',
    'invalid_argument',
  ];
  return !fatal.any(normalized.contains);
}
