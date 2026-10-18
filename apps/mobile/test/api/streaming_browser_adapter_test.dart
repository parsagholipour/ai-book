import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:tomeza/shared/api/streaming_browser_adapter.dart';

class _Client extends http.BaseClient {
  final chunks = StreamController<List<int>>();
  http.BaseRequest? request;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    this.request = request;
    return http.StreamedResponse(
      chunks.stream,
      200,
      headers: {'content-type': 'text/event-stream'},
    );
  }
}

class _Fallback implements HttpClientAdapter {
  int requests = 0;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests++;
    return ResponseBody.fromString('normal', 200);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  test(
    'delivers SSE bytes before close and cancels the network request',
    () async {
      final client = _Client();
      final fallback = _Fallback();
      final adapter = StreamingBrowserAdapter(fallback, client: client);
      final cancel = Completer<void>();
      final response = await adapter.fetch(
        RequestOptions(
          path: 'https://example.test/events',
          responseType: ResponseType.stream,
          headers: {'Authorization': 'Bearer test-token'},
        ),
        null,
        cancel.future,
      );
      final received = response.stream.first;
      client.chunks.add([65, 66]);
      expect(await received, [65, 66]);
      expect(client.chunks.isClosed, isFalse);
      expect(client.request!.headers['Authorization'], 'Bearer test-token');
      final abort = (client.request as http.Abortable).abortTrigger!;
      cancel.complete();
      await abort;
      expect(fallback.requests, 0);
      await client.chunks.close();
    },
  );

  test('keeps normal requests on the existing adapter', () async {
    final fallback = _Fallback();
    final adapter = StreamingBrowserAdapter(fallback, client: _Client());
    await adapter.fetch(
      RequestOptions(path: 'https://example.test/book'),
      null,
      null,
    );
    expect(fallback.requests, 1);
  });
}
