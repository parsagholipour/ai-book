import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

import '../app/app_test_fixtures.dart';

void main() {
  test(
    'exchanges Google identity without bearer auth and saves only app tokens',
    () async {
      final tokens = MemoryAuthTokenStore();
      final expected = fakeSession();
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
      RequestOptions? sent;
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            sent = options;
            handler.resolve(
              Response(
                requestOptions: options,
                statusCode: 201,
                data: {
                  'user': expected.user.toJson(),
                  'session': expected.tokens.toJson(),
                },
              ),
            );
          },
        ),
      );
      final repository = MobileAuthRepository(
        apiClient: ApiClient(dio: dio, tokenStore: tokens),
        tokenStore: tokens,
      );
      final session = await repository.signInWithGoogle(
        idToken: 'google-identity-token',
        termsAccepted: true,
        ageGuardianAttested: true,
      );
      expect(sent?.path, '/api/mobile/auth/google');
      expect(sent?.headers, isNot(contains('Authorization')));
      expect(sent?.data, {
        'idToken': 'google-identity-token',
        'termsAccepted': true,
        'ageGuardianAttested': true,
      });
      expect(session.user.id, expected.user.id);
      expect((await tokens.read())?.toJson(), expected.tokens.toJson());
    },
  );

  test('consent or identity refusal never persists a session', () async {
    final tokens = MemoryAuthTokenStore();
    final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          handler.reject(
            DioException(
              requestOptions: options,
              type: DioExceptionType.badResponse,
              response: Response(
                requestOptions: options,
                statusCode: 409,
                data: {
                  'error': {
                    'code': 'GOOGLE_SIGNUP_REQUIRED',
                    'message': 'Accept terms.',
                  },
                },
              ),
            ),
          );
        },
      ),
    );
    final repository = MobileAuthRepository(
      apiClient: ApiClient(dio: dio, tokenStore: tokens),
      tokenStore: tokens,
    );
    await expectLater(
      repository.signInWithGoogle(idToken: 'google-token'),
      throwsA(
        isA<ApiException>().having(
          (e) => e.code,
          'code',
          'GOOGLE_SIGNUP_REQUIRED',
        ),
      ),
    );
    expect(await tokens.read(), isNull);
  });
}
