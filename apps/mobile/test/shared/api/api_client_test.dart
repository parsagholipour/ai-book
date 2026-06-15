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
