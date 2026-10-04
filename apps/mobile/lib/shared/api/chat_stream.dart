part of 'api_client.dart';

extension ChatStreamRequest on ApiClient {
  /// A streamed preview is provisional. Only `done` is a saved conversation.
  Future<Map<String, dynamic>> postChatMap(
    String path, {
    Object? data,
    void Function(String text)? onAssistantText,
  }) async {
    if (onAssistantText == null) {
      return postMap(path, data: data, receiveTimeout: llmReceiveTimeout);
    }
    final generation = tokenStore.generation;
    try {
      return await _readChatReply(path, data, onAssistantText, generation);
    } on ApiException catch (error) {
      _assertCurrentSession(generation);
      final requestId = data is Map ? data['requestId'] : null;
      // Only a stable request id makes a POST safe to repeat. Admission keeps
      // the original turn running after disconnect; replay returns its saved
      // response without another message or charge.
      if (requestId is! String ||
          requestId.trim().isEmpty ||
          !_canRecoverChat(error)) {
        rethrow;
      }
      return _recoverChat(path, data, generation);
    }
  }

  Future<Map<String, dynamic>> _readChatReply(
    String path,
    Object? data,
    void Function(String)? onAssistantText,
    int generation, {
    Duration receiveTimeout = llmReceiveTimeout,
  }) async {
    final token = CancelToken();
    try {
      final response = await _streamRequest(
        path,
        method: 'POST',
        data: data,
        accept: onAssistantText == null
            ? 'application/json'
            : 'text/event-stream',
        receiveTimeout: receiveTimeout,
        cancelToken: token,
      );
      final body = response.data;
      if (body != null) {
        // Count heartbeat bytes as activity, even while tools produce no text.
        final bytes = body.stream.timeout(receiveTimeout).handleError((
          Object error,
        ) {
          if (error is DioException) throw _mapDioException(error);
          throw _chatInterrupted;
        });
        // Older servers, replays and deterministic replies still return JSON.
        if (!(response.headers.value('content-type') ?? '').contains(
          'text/event-stream',
        )) {
          final json = await utf8.decoder.bind(bytes.cast<List<int>>()).join();
          _assertCurrentSession(generation);
          return jsonDecode(json) as Map<String, dynamic>;
        }
        await for (final event in _decodeServerSentEvents(bytes)) {
          _assertCurrentSession(generation);
          if (!const ['text', 'done', 'error'].contains(event.event)) continue;
          final payload = jsonDecode(event.data) as Map<String, dynamic>;
          switch (event.event) {
            case 'text':
              onAssistantText?.call(payload['text'] as String);
            case 'done':
              return payload;
            case 'error':
              final error = payload['error'] as Map<String, dynamic>;
              throw ApiException(
                code: error['code'] as String? ?? 'CHAT_FAILED',
                message:
                    error['message'] as String? ??
                    'The reply could not be completed.',
                statusCode: payload['statusCode'] as int?,
                details: error,
              );
          }
        }
      }
      throw _chatInterrupted;
    } on DioException catch (error) {
      await _decodeStreamError(error);
      throw _mapDioException(error);
    } on FormatException {
      // A severed UTF-8 sequence or JSON event is also an incomplete reply.
      throw _chatInterrupted;
    } finally {
      token.cancel('Chat request finished.');
    }
  }

  Future<Map<String, dynamic>> _recoverChat(
    String path,
    Object? data,
    int generation,
  ) async {
    final deadline = DateTime.now().add(llmReceiveTimeout);
    var delay = const Duration(seconds: 2);
    // Bound both elapsed time and attempts, including an offline device whose
    // requests fail immediately. Keep previews provisional until JSON arrives.
    for (var attempt = 0; attempt < 18; attempt++) {
      _assertCurrentSession(generation);
      final remaining = deadline.difference(DateTime.now());
      if (remaining <= Duration.zero) break;
      try {
        // Read JSON through the same byte decoder so a second disconnection
        // (including truncated JSON) stays retryable during recovery.
        final result = await _readChatReply(
          path,
          data,
          null,
          generation,
          receiveTimeout: remaining,
        );
        _assertCurrentSession(generation);
        return result;
      } on ApiException catch (error) {
        _assertCurrentSession(generation);
        if (!_canRecoverChat(error)) rethrow;
      }
      if (attempt == 17) break;
      final remainingWait = deadline.difference(DateTime.now());
      if (remainingWait <= Duration.zero) break;
      await Future<void>.delayed(delay < remainingWait ? delay : remainingWait);
      if (delay < const Duration(seconds: 8)) delay *= 2;
    }
    _assertCurrentSession(generation);
    throw _chatInterrupted;
  }
}

const _chatInterrupted = ApiException(
  code: 'CHAT_INTERRUPTED',
  message: 'The connection was interrupted. Try again to recover this reply.',
);

bool _canRecoverChat(ApiException error) =>
    const [
      'CHAT_INTERRUPTED',
      'NETWORK_ERROR',
      'REQUEST_IN_PROGRESS',
    ].contains(error.code) ||
    (error.code == 'API_ERROR' &&
        const [502, 503, 504].contains(error.statusCode));

Future<void> _decodeStreamError(DioException error) async {
  final body = error.response?.data;
  if (body is! ResponseBody) return;
  try {
    error.response!.data = jsonDecode(
      await utf8.decoder.bind(body.stream.cast<List<int>>()).join(),
    );
  } catch (_) {
    // Keep the original HTTP status if an error body is not JSON.
  }
}
