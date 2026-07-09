import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
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

  test('concurrent refreshTokens calls share a single refresh request', () async {
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
  });

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
    expect(
      adapter.authorizationHeaders.toSet(),
      {'Bearer access-token-1'},
    );
    expect((await tokenStore.read())?.accessToken, 'access-token-1');
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
