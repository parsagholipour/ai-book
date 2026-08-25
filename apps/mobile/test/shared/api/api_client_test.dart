import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
  test('getMap returns the top-level JSON map', () async {
    final adapter = RecordingHttpClientAdapter(
      responseBody: '{"project":{"id":"project-1"}}',
    );
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    final result = await apiClient.getMap('/api/mobile/projects/project-1');

    expect(result, {
      'project': {'id': 'project-1'},
    });
    expect(adapter.lastOptions?.method, 'GET');
  });

  test('postMap returns the top-level JSON map and forwards data', () async {
    final adapter = RecordingHttpClientAdapter(
      responseBody: '{"operation":{"id":"operation-1"}}',
    );
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    final result = await apiClient.postMap(
      '/api/mobile/projects/project-1/plan',
      data: const {'requestId': 'request-1'},
    );

    expect(result, {
      'operation': {'id': 'operation-1'},
    });
    expect(adapter.lastOptions?.method, 'POST');
    expect(adapter.lastOptions?.data, {'requestId': 'request-1'});
    expect(adapter.lastOptions?.contentType, Headers.jsonContentType);
  });

  test('getMap and postMap forward requiresAuth', () async {
    final adapter = RecordingHttpClientAdapter();
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(),
    );

    await apiClient.getMap('/api/mobile/public', requiresAuth: false);
    expect(adapter.lastOptions?.headers, isNot(contains('Authorization')));

    await apiClient.postMap('/api/mobile/public', requiresAuth: false);
    expect(adapter.lastOptions?.headers, isNot(contains('Authorization')));
  });

  test('getMap preserves the cast failure for a non-map response', () async {
    final adapter = RecordingHttpClientAdapter(responseBody: '[]');
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    await expectLater(
      apiClient.getMap('/api/mobile/projects'),
      throwsA(isA<TypeError>()),
    );
  });

  test('postJson does not send JSON content type for empty posts', () async {
    final adapter = RecordingHttpClientAdapter();
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    await apiClient.postJson('/api/mobile/plans/plan-1/approve');

    expect(adapter.lastOptions?.method, 'POST');
    expect(adapter.lastOptions?.data, isNull);
    expect(adapter.lastOptions?.contentType, isNull);
    expect(
      adapter.lastOptions?.headers,
      isNot(contains(Headers.contentTypeHeader)),
    );
  });

  test('postJson keeps JSON content type when a payload is present', () async {
    final adapter = RecordingHttpClientAdapter();
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    await apiClient.postJson(
      '/api/mobile/projects/project-1/plan',
      data: const <String, dynamic>{},
    );

    expect(adapter.lastOptions?.method, 'POST');
    expect(adapter.lastOptions?.data, const <String, dynamic>{});
    expect(adapter.lastOptions?.contentType, Headers.jsonContentType);
  });

  test('postMap forwards the per-request receive timeout for LLM endpoints '
      'and leaves other requests on the global default', () async {
    final adapter = RecordingHttpClientAdapter();
    final apiClient = ApiClient(
      dio: Dio(
        BaseOptions(
          baseUrl: 'http://localhost:4001',
          receiveTimeout: const Duration(seconds: 20),
        ),
      )..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    await apiClient.postMap(
      '/api/mobile/projects/project-1/chat/messages',
      data: const {'message': 'Make chapter two warmer.'},
      receiveTimeout: llmReceiveTimeout,
    );
    expect(adapter.lastOptions?.receiveTimeout, llmReceiveTimeout);

    await apiClient.getJson('/api/mobile/projects/project-1');
    expect(adapter.lastOptions?.receiveTimeout, const Duration(seconds: 20));
  });

  test('refreshTokens sends JSON content type', () async {
    final refreshedTokens = validTokens();
    final adapter = RecordingHttpClientAdapter(
      responseBody: jsonEncode({'session': refreshedTokens.toJson()}),
    );
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    await apiClient.refreshTokens();

    expect(adapter.lastOptions?.method, 'POST');
    expect(adapter.lastOptions?.path, '/api/mobile/auth/refresh');
    expect(adapter.lastOptions?.data, {'refreshToken': 'refresh-token'});
    expect(adapter.lastOptions?.contentType, Headers.jsonContentType);
  });

  test(
    'concurrent refreshTokens calls share a single refresh request',
    () async {
      final adapter = RefreshCountingHttpClientAdapter();
      final apiClient = ApiClient(
        dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
          ..httpClientAdapter = adapter,
        tokenStore: MemoryAuthTokenStore(validTokens()),
      );

      final results = await Future.wait([
        apiClient.refreshTokens(),
        apiClient.refreshTokens(),
        apiClient.refreshTokens(),
      ]);

      expect(adapter.refreshCount, 1);
      expect(results[1].refreshToken, results[0].refreshToken);
      expect(results[2].refreshToken, results[0].refreshToken);

      await apiClient.refreshTokens();

      expect(adapter.refreshCount, 2);
    },
  );

  test('parallel requests with a stale access token refresh once', () async {
    final adapter = RefreshCountingHttpClientAdapter();
    final tokenStore = MemoryAuthTokenStore(staleAccessTokens());
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: tokenStore,
    );

    await Future.wait([
      apiClient.getJson('/api/mobile/projects/project-1'),
      apiClient.getJson('/api/mobile/projects/project-1/status'),
    ]);

    expect(adapter.refreshCount, 1);
    expect(adapter.authorizationHeaders.toSet(), {'Bearer access-token-1'});
    expect((await tokenStore.read())?.accessToken, 'access-token-1');
  });

  test(
    'downloadFile surfaces the server error code, not a generic API_ERROR',
    () async {
      // The reader's "Still preparing this book" overlay keys on
      // `code == 'EXPORT_NOT_READY'`, and a download is the one request whose
      // body Dio reads as a stream — it only decodes the error body because
      // `receiveDataWhenStatusError` defaults to true. A Dio upgrade or a
      // BaseOptions tweak that turned that off would silently downgrade the
      // overlay to "Could not download this book" with no other test noticing.
      //
      // The status alone cannot stand in for the code here: PROJECT_NOT_FOUND and
      // a genuinely absent book are 404 too, and neither is "still preparing".
      final directory = await Directory.systemTemp.createTemp(
        'api-client-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final apiClient = ApiClient(
        dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
          ..httpClientAdapter = ErrorBodyHttpClientAdapter(
            statusCode: 404,
            code: 'EXPORT_NOT_READY',
            message: 'This export is not ready yet.',
          ),
        tokenStore: MemoryAuthTokenStore(validTokens()),
      );

      await expectLater(
        apiClient.downloadFile(
          '/api/mobile/projects/project-1/export/pdf',
          '${directory.path}/book.pdf',
        ),
        throwsA(
          isA<ApiException>()
              .having((error) => error.code, 'code', 'EXPORT_NOT_READY')
              .having((error) => error.statusCode, 'statusCode', 404)
              .having(
                (error) => error.message,
                'message',
                'This export is not ready yet.',
              ),
        ),
      );
    },
  );

  test('a cancelled download maps to REQUEST_CANCELLED, not API_ERROR', () async {
    // The reader cancels its own download when the screen closes; surfacing
    // that as a generic failure would report the reader's own action back to
    // them as something going wrong.
    final directory = await Directory.systemTemp.createTemp('api-client-test');
    addTearDown(() => directory.delete(recursive: true));
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = HangingHttpClientAdapter(),
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    final cancelToken = CancelToken();
    final download = apiClient.downloadFile(
      '/api/mobile/projects/project-1/export/pdf',
      '${directory.path}/book.pdf',
      cancelToken: cancelToken,
    );
    cancelToken.cancel('Reader closed');

    await expectLater(
      download,
      throwsA(
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'REQUEST_CANCELLED',
        ),
      ),
    );
  });

  test('a request that fails after a token refresh is still mapped', () async {
    // The retry that follows a 401 is issued from inside the catch block that
    // does the mapping, so it is not covered by it. An access token that
    // expired while the reader sat on the book turned every subsequent refusal
    // into a raw DioException: the reader's rebuilding overlay and the paywall
    // both begin `error is ApiException`, so a book that was merely still
    // compiling reported "Could not download this book" instead.
    final directory = await Directory.systemTemp.createTemp('api-client-test');
    addTearDown(() => directory.delete(recursive: true));
    final apiClient = ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = StaleTokenErrorBodyHttpClientAdapter(
          statusCode: 404,
          code: 'EXPORT_NOT_READY',
          message: 'This export is not ready yet.',
        ),
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    await expectLater(
      apiClient.downloadFile(
        '/api/mobile/projects/project-1/export/pdf',
        '${directory.path}/book.pdf',
      ),
      throwsA(
        isA<ApiException>()
            .having((error) => error.code, 'code', 'EXPORT_NOT_READY')
            .having((error) => error.statusCode, 'statusCode', 404),
      ),
    );

    // The same gap sits on the shared JSON path, which every other call uses.
    await expectLater(
      apiClient.getJson('/api/mobile/projects/project-1'),
      throwsA(
        isA<ApiException>().having(
          (error) => error.code,
          'code',
          'EXPORT_NOT_READY',
        ),
      ),
    );
  });

  // The raw-byte upload used to be duplicated inside the characters
  // repository, and these three assertions lived beside that copy. It goes
  // through `putBytes` now, so the coverage belongs where the transport does.
  group('putBytes', () {
    ApiClient clientFor(HttpClientAdapter adapter) => ApiClient(
      dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
        ..httpClientAdapter = adapter,
      tokenStore: MemoryAuthTokenStore(validTokens()),
    );

    test('PUTs the raw bytes with auth and metadata', () async {
      final adapter = RecordingHttpClientAdapter();
      final apiClient = clientFor(adapter);

      await apiClient.putBytes(
        '/api/mobile/characters/char-1/photo',
        bytes: [1, 2, 3],
        queryParameters: {'filename': 'face.jpg', 'mimeType': 'image/jpeg'},
      );

      expect(adapter.lastOptions?.method, 'PUT');
      expect(adapter.lastOptions?.path, '/api/mobile/characters/char-1/photo');
      expect(adapter.lastOptions?.queryParameters, {
        'filename': 'face.jpg',
        'mimeType': 'image/jpeg',
      });
      expect(adapter.lastOptions?.contentType, 'application/octet-stream');
      expect(
        adapter.lastOptions?.headers['Authorization'],
        'Bearer access-token',
      );
    });

    test('reports upload progress, which a 20 MB photo needs', () async {
      final adapter = RecordingHttpClientAdapter();
      final apiClient = clientFor(adapter);
      final progress = <int>[];

      await apiClient.putBytes(
        '/api/mobile/characters/char-1/photo',
        bytes: List<int>.filled(2048, 7),
        queryParameters: const {'filename': 'face.jpg'},
        onSendProgress: (sent, total) => progress.add(sent),
      );

      expect(progress, isNotEmpty);
      expect(progress.last, 2048);
    });

    test('maps the server error body onto ApiException', () async {
      final apiClient = clientFor(
        ErrorBodyHttpClientAdapter(
          statusCode: 422,
          code: 'PHOTO_UNSUPPORTED',
          message: 'Use a JPEG, PNG, or WebP photo.',
        ),
      );

      await expectLater(
        apiClient.putBytes(
          '/api/mobile/characters/char-1/photo',
          bytes: const [1],
          queryParameters: const {'filename': 'face.gif'},
        ),
        throwsA(
          isA<ApiException>()
              .having((error) => error.code, 'code', 'PHOTO_UNSUPPORTED')
              .having((error) => error.statusCode, 'statusCode', 422),
        ),
      );
    });
  });
}

MobileSessionTokens staleAccessTokens() {
  final now = DateTime.now().toUtc();
  return MobileSessionTokens(
    accessToken: 'access-token-0',
    accessTokenExpiresAt: now.subtract(const Duration(minutes: 1)),
    refreshToken: 'refresh-token-0',
    refreshTokenExpiresAt: now.add(const Duration(days: 1)),
  );
}

MobileSessionTokens validTokens() {
  final now = DateTime.now().toUtc();
  return MobileSessionTokens(
    accessToken: 'access-token',
    accessTokenExpiresAt: now.add(const Duration(minutes: 5)),
    refreshToken: 'refresh-token',
    refreshTokenExpiresAt: now.add(const Duration(days: 1)),
  );
}

class RecordingHttpClientAdapter implements HttpClientAdapter {
  RecordingHttpClientAdapter({this.responseBody = '{"ok":true}'});

  final String responseBody;
  RequestOptions? lastOptions;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    lastOptions = options;
    await requestStream?.drain<void>();
    return ResponseBody.fromString(
      responseBody,
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}

/// Counts refresh calls and rotates the session tokens on each one, mirroring
/// the backend's single-use refresh tokens.
class RefreshCountingHttpClientAdapter implements HttpClientAdapter {
  int refreshCount = 0;
  final List<String> authorizationHeaders = [];

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await requestStream?.drain<void>();
    if (options.path == '/api/mobile/auth/refresh') {
      refreshCount += 1;
      final generation = refreshCount;
      // Yield so concurrent callers can race before the response lands.
      await Future<void>.delayed(Duration.zero);
      final now = DateTime.now().toUtc();
      final session = MobileSessionTokens(
        accessToken: 'access-token-$generation',
        accessTokenExpiresAt: now.add(const Duration(minutes: 15)),
        refreshToken: 'refresh-token-$generation',
        refreshTokenExpiresAt: now.add(const Duration(days: 30)),
      );
      return ResponseBody.fromString(
        jsonEncode({'session': session.toJson()}),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    }

    final authorization = options.headers['Authorization'];
    if (authorization is String) {
      authorizationHeaders.add(authorization);
    }
    return ResponseBody.fromString(
      '{"ok":true}',
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}

/// Never answers, so a cancellation is the only way the request can end.
class HangingHttpClientAdapter implements HttpClientAdapter {
  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return Completer<ResponseBody>().future;
  }
}

/// Rejects the first token as expired, serves the refresh, then answers the
/// retry with a structured error body — the sequence a reader hits when their
/// access token ran out while the export was still compiling.
class StaleTokenErrorBodyHttpClientAdapter implements HttpClientAdapter {
  StaleTokenErrorBodyHttpClientAdapter({
    required this.statusCode,
    required this.code,
    required this.message,
  });

  final int statusCode;
  final String code;
  final String message;
  final Set<String> _refreshed = {};

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await requestStream?.drain<void>();
    if (options.path == '/api/mobile/auth/refresh') {
      final now = DateTime.now().toUtc();
      final session = MobileSessionTokens(
        accessToken: 'access-token-1',
        accessTokenExpiresAt: now.add(const Duration(minutes: 15)),
        refreshToken: 'refresh-token-1',
        refreshTokenExpiresAt: now.add(const Duration(days: 30)),
      );
      return ResponseBody.fromString(
        jsonEncode({'session': session.toJson()}),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    }

    if (_refreshed.add(options.path)) {
      return ResponseBody.fromString(
        jsonEncode({
          'error': {'code': 'TOKEN_EXPIRED', 'message': 'Token expired.'},
        }),
        401,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    }

    return ResponseBody.fromString(
      jsonEncode({
        'error': {'code': code, 'message': message},
      }),
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}

/// Answers every request with a structured error body, the way the mobile API
/// reports a refusal.
class ErrorBodyHttpClientAdapter implements HttpClientAdapter {
  ErrorBodyHttpClientAdapter({
    required this.statusCode,
    required this.code,
    required this.message,
  });

  final int statusCode;
  final String code;
  final String message;

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
      jsonEncode({
        'error': {'code': code, 'message': message},
      }),
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}
