import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
  for (final transport in ['json', 'upload', 'download', 'events']) {
    test('$transport never retries an old 401 under the next account', () async {
      final directory = await Directory.systemTemp.createTemp('session-test');
      addTearDown(() => directory.delete(recursive: true));
      final store = MemoryAuthTokenStore(tokens('a'));
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
      addTearDown(() => dio.close(force: true));
      final pending = Completer<(RequestOptions, RequestInterceptorHandler)>();
      final requests = <RequestOptions>[];
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            if (!pending.isCompleted) {
              pending.complete((options, handler));
            } else {
              // Terminate an erroneous retry immediately rather than hanging the test.
              handler.reject(
                DioException(
                  requestOptions: options,
                  type: DioExceptionType.connectionError,
                ),
              );
            }
          },
        ),
      );
      final api = ApiClient(dio: dio, tokenStore: store);
      const path = '/api/mobile/projects/a-book';
      final Future<dynamic> request = switch (transport) {
        'json' => api.postJson(path, data: {'title': 'Changed title'}),
        'upload' => api.putBytes(path, bytes: [1, 2, 3]),
        'download' => api.downloadFile(path, '${directory.path}/book.pdf'),
        _ => api.getServerSentEvents(path).first,
      };
      final rejected = expectLater(
        request,
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'REQUEST_CANCELLED',
          ),
        ),
      );
      final (options, handler) = await pending.future;
      await store.write(tokens('b'));
      handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.badResponse,
          response: Response(
            requestOptions: options,
            statusCode: 401,
            data: transport == 'download'
                ? ResponseBody.fromString(
                    '{"error":{"code":"INVALID_SESSION"}}',
                    401,
                    headers: {
                      Headers.contentTypeHeader: [Headers.jsonContentType],
                    },
                  )
                : null,
          ),
        ),
      );
      await rejected;
      expect(requests, hasLength(1));
      expect(requests.single.headers['Authorization'], 'Bearer a-access');
      expect((await store.read())?.accessToken, 'b-access');
    });
  }

  test(
    'late data from an old account is not delivered to its caller',
    () async {
      final store = MemoryAuthTokenStore(tokens('a'));
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
      addTearDown(() => dio.close(force: true));
      final pending = Completer<(RequestOptions, RequestInterceptorHandler)>();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            pending.complete((options, handler));
          },
        ),
      );
      final api = ApiClient(dio: dio, tokenStore: store);
      final request = api.getMap('/api/mobile/projects');
      final rejected = expectLater(
        request,
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'REQUEST_CANCELLED',
          ),
        ),
      );
      final (options, handler) = await pending.future;
      await store.write(tokens('b'));
      handler.resolve(
        Response(
          requestOptions: options,
          data: {
            'projects': ['a-private-book'],
          },
        ),
      );
      await rejected;
    },
  );
}

MobileSessionTokens tokens(String owner) => MobileSessionTokens(
  accessToken: '$owner-access',
  refreshToken: '$owner-refresh',
  accessTokenExpiresAt: DateTime.now().toUtc().add(const Duration(minutes: 15)),
  refreshTokenExpiresAt: DateTime.now().toUtc().add(const Duration(days: 30)),
);
