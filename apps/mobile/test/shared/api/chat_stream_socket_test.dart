import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

import 'api_client_test.dart' show validTokens;

void main() {
  test('real HTTP delivers chat previews before the reply completes', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final release = Completer<void>();
    final firstText = Completer<String>();
    final flushed = Completer<void>();
    String? accept;
    final served = Completer<void>();
    server.listen((request) async {
      try {
        accept = request.headers.value(HttpHeaders.acceptHeader);
        await request.drain<void>();
        request.response.bufferOutput = false;
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        request.response.write('event: text\ndata: {"text":"Hello"}\n\n');
        await request.response.flush();
        flushed.complete();
        await release.future;
        request.response.write(
          'event: done\ndata: {"reply":"Hello, saved"}\n\n',
        );
        await request.response.close();
        served.complete();
      } catch (error, stack) {
        served.completeError(error, stack);
      }
    });
    final dio = Dio(
      BaseOptions(
        baseUrl: 'http://127.0.0.1:${server.port}',
        headers: {'Accept': 'application/json'},
      ),
    );
    final client = ApiClient(
      dio: dio,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );
    var completed = false;
    final result = client
        .postChatMap(
          '/chat',
          data: {'requestId': 'same-turn'},
          onAssistantText: firstText.complete,
        )
        .then((value) {
          completed = true;
          return value;
        });
    try {
      await flushed.future.timeout(const Duration(seconds: 2));
      expect(
        await firstText.future.timeout(const Duration(seconds: 2)),
        'Hello',
      );
      expect(accept, 'text/event-stream');
      expect(completed, isFalse);
      release.complete();
      expect(await result, {'reply': 'Hello, saved'});
      await served.future;
    } finally {
      if (!release.isCompleted) release.complete();
      dio.close(force: true);
      await server.close(force: true);
    }
  });
}
