import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

import 'api_client_test.dart' show validTokens;

const requestData = {
  'requestId': 'original-request',
  'message': 'Tell me more',
  'expectedRevision': 4,
  'editMessageId': 'edited-message',
};

void main() {
  for (final interruption in ['eof', 'truncated', 'socket', 'gateway']) {
    test('recovers $interruption using the exact POST as JSON', () async {
      final adapter = RecoveryAdapter(interruption: interruption);
      final previews = <String>[];
      final client = clientFor(adapter);
      expect(
        await client.postChatMap(
          '/chat',
          data: requestData,
          onAssistantText: previews.add,
        ),
        {'reply': 'Saved complete reply'},
      );
      expect(adapter.requests, hasLength(2));
      for (final request in adapter.requests) {
        expect(request.method, 'POST');
        expect(request.path, '/chat');
        expect(request.data, requestData);
      }
      expect(adapter.requests.last.headers['Accept'], 'application/json');
      expect(previews, interruption == 'gateway' ? isEmpty : ['Partial']);
    });
  }

  testWidgets('waits for the accepted turn before replaying its saved reply', (
    tester,
  ) async {
    final adapter = RecoveryAdapter(pendingReplies: 2);
    var completed = false;
    final result = clientFor(adapter)
        .postChatMap('/chat', data: requestData, onAssistantText: (_) {})
        .then((value) {
          completed = true;
          return value;
        });
    await flushRequests(tester);
    expect(adapter.requests, hasLength(2));
    expect(completed, isFalse);
    await flushRequests(tester, const Duration(seconds: 2));
    expect(adapter.requests, hasLength(3));
    await flushRequests(tester, const Duration(seconds: 4));
    expect(completed, isTrue);
    expect(await result, {'reply': 'Saved complete reply'});
    expect(adapter.requests, hasLength(4));
    expect(adapter.requests.map((r) => r.data), everyElement(requestData));
  });

  testWidgets('stops replaying if the account changes during backoff', (
    tester,
  ) async {
    final adapter = RecoveryAdapter(pendingReplies: 1);
    final tokens = MemoryAuthTokenStore(validTokens());
    final client = clientFor(adapter, tokens: tokens);
    final result = client.postChatMap(
      '/chat',
      data: requestData,
      onAssistantText: (_) {},
    );
    final assertion = expectLater(
      result,
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'REQUEST_CANCELLED'),
      ),
    );
    await flushRequests(tester);
    expect(adapter.requests, hasLength(2));
    await tokens.clear();
    await flushRequests(tester, const Duration(seconds: 2));
    await assertion;
    expect(adapter.requests, hasLength(2));
  });

  for (final interruption in ['truncated', 'socket']) {
    testWidgets('recovers when the JSON fallback also suffers $interruption', (
      tester,
    ) async {
      final adapter = RecoveryAdapter(recoveryInterruption: interruption);
      final result = clientFor(
        adapter,
      ).postChatMap('/chat', data: requestData, onAssistantText: (_) {});
      final assertion = expectLater(
        result,
        completion({'reply': 'Saved complete reply'}),
      );
      await flushRequests(tester);
      expect(adapter.requests, hasLength(2));
      await flushRequests(tester, const Duration(seconds: 2));
      await assertion;
      expect(adapter.requests, hasLength(3));
      expect(
        adapter.requests.skip(1).map((r) => r.headers['Accept']),
        everyElement('application/json'),
      );
      expect(adapter.requests.map((r) => r.data), everyElement(requestData));
    });
  }

  testWidgets('persistent loss stops retrying and leaves a retryable error', (
    tester,
  ) async {
    final adapter = RecoveryAdapter(alwaysOffline: true);
    final result = clientFor(
      adapter,
    ).postChatMap('/chat', data: requestData, onAssistantText: (_) {});
    final assertion = expectLater(
      result,
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'CHAT_INTERRUPTED'),
      ),
    );
    await flushRequests(tester);
    for (var i = 0; i < 18; i++) {
      await flushRequests(tester, const Duration(seconds: 8));
    }
    await assertion;
    final count = adapter.requests.length;
    expect(count, lessThanOrEqualTo(19));
    await flushRequests(tester, const Duration(minutes: 5));
    expect(adapter.requests, hasLength(count));
  });

  for (final code in [
    'INSUFFICIENT_CREDITS',
    'SESSION_CONFLICT',
    'AI_PAUSED',
  ]) {
    test('preserves $code instead of retrying a definitive refusal', () async {
      final adapter = RecoveryAdapter(streamError: code);
      await expectLater(
        clientFor(
          adapter,
        ).postChatMap('/chat', data: requestData, onAssistantText: (_) {}),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', code)),
      );
      expect(adapter.requests, hasLength(1));
    });
  }
}

// Stream cancellation can finish in the root zone, while Dio interceptors use
// zero-time timers. Drain both without advancing the fake recovery backoff.
Future<void> flushRequests(
  WidgetTester tester, [
  Duration elapsed = Duration.zero,
]) async {
  await tester.pump(elapsed);
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump(Duration.zero);
  }
}

ApiClient clientFor(RecoveryAdapter adapter, {MemoryAuthTokenStore? tokens}) =>
    ApiClient(
      dio: Dio(BaseOptions(headers: {'Accept': 'application/json'}))
        ..httpClientAdapter = adapter,
      tokenStore: tokens ?? MemoryAuthTokenStore(validTokens()),
    );

class RecoveryAdapter implements HttpClientAdapter {
  RecoveryAdapter({
    this.interruption = 'eof',
    this.pendingReplies = 0,
    this.alwaysOffline = false,
    this.streamError,
    this.recoveryInterruption,
  });
  final String interruption;
  int pendingReplies;
  final bool alwaysOffline;
  final String? streamError;
  final String? recoveryInterruption;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    await requestStream?.drain<void>();
    if (requests.length == 1) {
      if (interruption == 'gateway') return jsonResponse({}, 502);
      const preview = 'event: text\ndata: {"text":"Partial"}\n\n';
      final stream = Stream<Uint8List>.multi((sink) {
        sink.add(Uint8List.fromList(utf8.encode(preview)));
        if (streamError != null) {
          sink.add(
            Uint8List.fromList(
              utf8.encode(
                'event: error\ndata: {"error":{"code":"$streamError"}}\n\n',
              ),
            ),
          );
        } else if (interruption == 'socket') {
          sink.addError(
            DioException(
              requestOptions: options,
              type: DioExceptionType.connectionError,
            ),
          );
        } else if (interruption == 'truncated') {
          sink.add(Uint8List.fromList(utf8.encode('event: done\ndata: {"rep')));
        }
        sink.close();
      });
      return ResponseBody(
        stream,
        200,
        headers: {
          Headers.contentTypeHeader: ['text/event-stream'],
        },
      );
    }
    if (requests.length == 2 && recoveryInterruption != null) {
      return ResponseBody(
        Stream<Uint8List>.multi((sink) {
          sink.add(Uint8List.fromList(utf8.encode('{"reply":"Saved')));
          if (recoveryInterruption == 'socket') {
            sink.addError(const SocketException('connection severed'));
          }
          sink.close();
        }),
        200,
        headers: {
          Headers.contentTypeHeader: ['application/json'],
        },
      );
    }
    if (alwaysOffline) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    if (pendingReplies-- > 0) {
      return jsonResponse({
        'error': {'code': 'REQUEST_IN_PROGRESS'},
      }, 409);
    }
    return jsonResponse({'reply': 'Saved complete reply'}, 200);
  }

  ResponseBody jsonResponse(Object data, int status) => ResponseBody.fromString(
    jsonEncode(data),
    status,
    headers: {
      Headers.contentTypeHeader: ['application/json'],
    },
  );

  @override
  void close({bool force = false}) {}
}
