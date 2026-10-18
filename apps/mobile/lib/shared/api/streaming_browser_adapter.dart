import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:http/http.dart' as http;

/// Dio's browser XHR adapter buffers until a response ends. An SSE connection
/// may never end, so chat/progress streams use Fetch through package:http.
/// Ordinary requests keep Dio's adapter and its upload progress reporting.
class StreamingBrowserAdapter implements HttpClientAdapter {
  StreamingBrowserAdapter(this.fallback, {http.Client? client})
    : client = client ?? http.Client();

  final HttpClientAdapter fallback;
  final http.Client client;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.responseType != ResponseType.stream) {
      return fallback.fetch(options, requestStream, cancelFuture);
    }
    final aborted = Completer<void>();
    void abort() {
      if (!aborted.isCompleted) aborted.complete();
    }

    unawaited(cancelFuture?.then((_) => abort()));
    final request = http.AbortableRequest(
      options.method,
      options.uri,
      abortTrigger: aborted.future,
    );
    for (final entry in options.headers.entries) {
      if (entry.value != null && entry.key.toLowerCase() != 'content-length') {
        request.headers[entry.key] = entry.value.toString();
      }
    }
    if (requestStream != null) {
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in requestStream) {
        bytes.add(chunk);
      }
      request.bodyBytes = bytes.takeBytes();
    }
    try {
      final response = await client
          .send(request)
          .timeout(
            options.connectTimeout ?? const Duration(seconds: 12),
            onTimeout: () {
              abort();
              throw DioException.connectionTimeout(
                timeout: options.connectTimeout ?? const Duration(seconds: 12),
                requestOptions: options,
              );
            },
          );
      return ResponseBody(
        response.stream.map(Uint8List.fromList),
        response.statusCode,
        statusMessage: response.reasonPhrase,
        headers: response.headers.map((key, value) => MapEntry(key, [value])),
        onClose: abort,
      );
    } on DioException {
      rethrow;
    } on http.RequestAbortedException catch (error) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.cancel,
        error: error,
      );
    } catch (error) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: error.toString(),
        error: error,
      );
    }
  }

  @override
  void close({bool force = false}) {
    fallback.close(force: force);
    client.close();
  }
}
