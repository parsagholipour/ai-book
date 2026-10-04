import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';
import 'api_client_test.dart' show validTokens;

void main() {
  test('auth refresh replays the same POST and request id', () async {
    final adapter = ChatAdapter(expireOnce: true);
    final client = ApiClient(
      dio: Dio()..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );
    final request = client.postChatMap(
      '/chat',
      data: {'requestId': 'stable'},
      onAssistantText: (_) {},
    );
    adapter.add('event: done\ndata: {"reply":"Saved"}\n\n');
    expect(await request, {'reply': 'Saved'});
    expect(adapter.chatRequests, hasLength(2));
    for (final request in adapter.chatRequests) {
      expect(request.method, 'POST');
      expect(request.data, {'requestId': 'stable'});
    }
    await adapter.bytes.close();
  });

  test(
    'changing accounts rejects later previews and the final response',
    () async {
      final adapter = ChatAdapter();
      final tokens = MemoryAuthTokenStore(validTokens());
      final client = ApiClient(
        dio: Dio()..httpClientAdapter = adapter,
        tokenStore: tokens,
      );
      final first = Completer<void>();
      final previews = <String>[];
      final request = client.postChatMap(
        '/chat',
        onAssistantText: (text) {
          previews.add(text);
          first.complete();
        },
      );
      final assertion = expectLater(
        request,
        throwsA(
          isA<ApiException>().having(
            (e) => e.code,
            'code',
            'REQUEST_CANCELLED',
          ),
        ),
      );
      adapter.add('event: text\ndata: {"text":"First"}\n\n');
      await first.future;
      await tokens.clear();
      adapter.add(
        'event: text\ndata: {"text":"Private old reply"}\n\nevent: done\ndata: {}\n\n',
      );
      await assertion;
      expect(previews, ['First']);
      await adapter.bytes.close();
    },
  );

  test(
    'POST previews arrive before done, with split UTF-8 and multiline events',
    () async {
      final adapter = ChatAdapter();
      final client = ApiClient(
        dio: Dio()..httpClientAdapter = adapter,
        tokenStore: MemoryAuthTokenStore(validTokens()),
      );
      final previews = <String>[];
      final first = Completer<void>();
      var completed = false;
      final request = client
          .postChatMap(
            '/chat',
            data: {'requestId': 'stable'},
            onAssistantText: (text) {
              previews.add(text);
              if (!first.isCompleted) first.complete();
            },
          )
          .then((value) {
            completed = true;
            return value;
          });
      for (final byte in utf8.encode(
        'event: text\r\ndata: {"text":"سلام 😀"}\r\n\r\n',
      )) {
        adapter.bytes.add(Uint8List.fromList([byte]));
      }
      await first.future;
      expect(completed, isFalse);
      expect(previews, ['سلام 😀']);
      expect(adapter.options?.method, 'POST');
      expect(adapter.options?.data, {'requestId': 'stable'});
      expect(adapter.options?.headers['Authorization'], 'Bearer access-token');
      adapter.add(
        'event: text\ndata: {"text":""}\n\nevent: text\ndata: {"text":"Corrected"}\n\nevent: done\ndata: {"reply":\ndata: "Saved"}\n\n',
      );
      expect(await request, {'reply': 'Saved'});
      expect(previews, ['سلام 😀', '', 'Corrected']);
      await adapter.bytes.close();
    },
  );

  test(
    'a stream without done fails instead of saving its partial preview',
    () async {
      final adapter = ChatAdapter();
      final client = ApiClient(
        dio: Dio()..httpClientAdapter = adapter,
        tokenStore: MemoryAuthTokenStore(validTokens()),
      );
      final request = client.postChatMap('/chat', onAssistantText: (_) {});
      final assertion = expectLater(
        request,
        throwsA(
          isA<ApiException>().having((e) => e.code, 'code', 'CHAT_INTERRUPTED'),
        ),
      );
      adapter.add('event: text\ndata: {"text":"Partial"}\n\n');
      await adapter.bytes.close();
      await assertion;
    },
  );

  test(
    'JSON replies from old servers and replayed requests still work',
    () async {
      final adapter = ChatAdapter(contentType: 'application/json');
      final client = ApiClient(
        dio: Dio()..httpClientAdapter = adapter,
        tokenStore: MemoryAuthTokenStore(validTokens()),
      );
      final request = client.postChatMap(
        '/chat',
        onAssistantText: (_) => fail('JSON must not invent previews'),
      );
      adapter.add('{"reply":"Saved"}');
      await adapter.bytes.close();
      expect(await request, {'reply': 'Saved'});
    },
  );

  for (final streaming in [false, true]) {
    test(
      'preserves actionable ${streaming ? "stream" : "HTTP"} errors',
      () async {
        final adapter = ChatAdapter(
          contentType: streaming ? 'text/event-stream' : 'application/json',
          status: streaming ? 200 : 402,
        );
        final client = ApiClient(
          dio: Dio()..httpClientAdapter = adapter,
          tokenStore: MemoryAuthTokenStore(validTokens()),
        );
        final assertion = expectLater(
          client.postChatMap('/chat', onAssistantText: (_) {}),
          throwsA(
            isA<ApiException>()
                .having((e) => e.code, 'code', 'INSUFFICIENT_CREDITS')
                .having((e) => e.statusCode, 'status', 402)
                .having((e) => e.details['requiredCredits'], 'credits', 8),
          ),
        );
        const body =
            '{"statusCode":402,"error":{"code":"INSUFFICIENT_CREDITS","message":"Top up","requiredCredits":8}}';
        adapter.add(streaming ? 'event: error\ndata: $body\n\n' : body);
        await adapter.bytes.close();
        await assertion;
      },
    );
  }
}

class ChatAdapter implements HttpClientAdapter {
  ChatAdapter({
    this.contentType = 'text/event-stream',
    this.status = 200,
    this.expireOnce = false,
  });
  bool expireOnce;
  final chatRequests = <RequestOptions>[];
  final String contentType;
  final int status;
  final bytes = StreamController<Uint8List>();
  RequestOptions? options;
  void add(String text) => bytes.add(Uint8List.fromList(utf8.encode(text)));
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    this.options = options;
    await requestStream?.drain<void>();
    if (options.path == '/api/mobile/auth/refresh') {
      return ResponseBody.fromString(
        jsonEncode({'session': validTokens().toJson()}),
        200,
        headers: {
          Headers.contentTypeHeader: ['application/json'],
        },
      );
    }
    chatRequests.add(options);
    if (expireOnce) {
      expireOnce = false;
      return ResponseBody.fromString(
        '{"error":{"code":"TOKEN_EXPIRED"}}',
        401,
        headers: {
          Headers.contentTypeHeader: ['application/json'],
        },
      );
    }
    return ResponseBody(
      bytes.stream,
      status,
      headers: {
        Headers.contentTypeHeader: [contentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}
