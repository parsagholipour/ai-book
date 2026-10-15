import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
  group('a failure with no API error body', () {
    test('a proxy 502 never shows its reason phrase', () async {
      final client = _client(
        _StaticAdapter(
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
          contentType: 'text/html',
        ),
      );

      await expectLater(
        client.getMap('/api/mobile/projects'),
        throwsA(
          isA<ApiException>()
              .having((error) => error.code, 'code', 'API_ERROR')
              .having((error) => error.statusCode, 'statusCode', 502)
              .having(
                (error) => error.message,
                'message',
                'Tomeza is having trouble right now. Try again in a moment.',
              ),
        ),
      );
    });

    test('a bare 4xx reads as a plain retry sentence', () async {
      final client = _client(
        _StaticAdapter(
          statusCode: 404,
          statusMessage: 'Not Found',
          body: 'Not Found',
          contentType: 'text/plain',
        ),
      );

      await expectLater(
        client.getMap('/api/mobile/nowhere'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            'Something went wrong. Try again.',
          ),
        ),
      );
    });

    test('an API error body still speaks for itself', () async {
      final client = _client(
        _StaticAdapter(
          statusCode: 503,
          statusMessage: 'Service Unavailable',
          body: jsonEncode({
            'error': {'code': 'AI_PAUSED', 'message': 'Writing is paused.'},
          }),
          contentType: Headers.jsonContentType,
        ),
      );

      await expectLater(
        client.getMap('/api/mobile/projects'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            'Writing is paused.',
          ),
        ),
      );
    });
  });

  group('event stream idle timeout', () {
    test('a silent stream fails once the idle window passes', () async {
      final adapter = _ScriptedEventStreamAdapter();
      final client = _client(adapter);

      final events = <String>[];
      final failed = Completer<Object>();
      client
          .getServerSentEvents(
            '/api/mobile/projects/p/status/events',
            idleTimeout: const Duration(milliseconds: 80),
          )
          .listen(
            (event) => events.add(event.event),
            onError: (Object error) {
              if (!failed.isCompleted) failed.complete(error);
            },
            cancelOnError: true,
          );

      await adapter.opened.future;
      adapter.send('event: status\ndata: {"a":1}\n\n');

      final error = await failed.future.timeout(const Duration(seconds: 2));
      expect(
        error,
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'NETWORK_ERROR',
        ),
        reason: 'a caller deciding whether to reconnect reads one type',
      );
      expect(events, ['status']);
      await Future<void>.delayed(Duration.zero);
      expect(adapter.aborted, isTrue, reason: 'the dead socket is closed');
    });

    test('a ping comment counts as activity and is not an event', () async {
      final adapter = _ScriptedEventStreamAdapter();
      final client = _client(adapter);

      final events = <String>[];
      Object? failure;
      final subscription = client
          .getServerSentEvents(
            '/api/mobile/projects/p/status/events',
            idleTimeout: const Duration(milliseconds: 150),
          )
          .listen(
            (event) => events.add(event.event),
            onError: (Object error) => failure = error,
          );

      await adapter.opened.future;
      for (var i = 0; i < 5; i++) {
        adapter.send(': ping\n\n');
        await Future<void>.delayed(const Duration(milliseconds: 60));
      }
      adapter.send('event: status\ndata: {"a":2}\n\n');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(failure, isNull);
      expect(events, ['status']);
      await subscription.cancel();
    });

    test('a cancel between events aborts the request at once', () async {
      // An `async*` generator waiting inside `await for` saw a cancel only at
      // its next `yield`, so a stream cancelled between events kept its socket
      // until the server next sent a status — and pings yield nothing.
      final adapter = _ScriptedEventStreamAdapter();
      final client = _client(adapter);

      final first = Completer<void>();
      final subscription = client
          .getServerSentEvents('/api/mobile/projects/p/status/events')
          .listen((_) {
            if (!first.isCompleted) first.complete();
          });
      await adapter.opened.future;
      adapter.send('event: status\ndata: {"a":1}\n\n');
      await first.future;
      // Now waiting for the next event, with nothing coming.
      await Future<void>.delayed(const Duration(milliseconds: 20));

      await subscription.cancel().timeout(const Duration(seconds: 1));
      await Future<void>.delayed(Duration.zero);
      expect(adapter.aborted, isTrue);
    });
  });
}

ApiClient _client(HttpClientAdapter adapter) {
  return ApiClient(
    dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
      ..httpClientAdapter = adapter,
    tokenStore: MemoryAuthTokenStore(
      MobileSessionTokens(
        accessToken: 'access-token',
        accessTokenExpiresAt: DateTime.now().toUtc().add(
          const Duration(hours: 1),
        ),
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: DateTime.now().toUtc().add(
          const Duration(days: 30),
        ),
      ),
    ),
  );
}

class _StaticAdapter implements HttpClientAdapter {
  _StaticAdapter({
    required this.statusCode,
    required this.statusMessage,
    required this.body,
    required this.contentType,
  });

  final int statusCode;
  final String statusMessage;
  final String body;
  final String contentType;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await requestStream?.drain<void>();
    return ResponseBody.fromString(
      body,
      statusCode,
      statusMessage: statusMessage,
      headers: {
        Headers.contentTypeHeader: [contentType],
      },
    );
  }
}

class _ScriptedEventStreamAdapter implements HttpClientAdapter {
  final _bytes = StreamController<Uint8List>();
  final opened = Completer<void>();
  bool aborted = false;

  void send(String text) =>
      _bytes.add(Uint8List.fromList(utf8.encode(text)));

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    unawaited(cancelFuture?.then((_) => aborted = true));
    if (!opened.isCompleted) opened.complete();
    return ResponseBody(
      _bytes.stream,
      200,
      headers: {
        Headers.contentTypeHeader: ['text/event-stream'],
      },
    );
  }
}
