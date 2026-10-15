import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

/// `MobileAuthRepository.restoreSession` against a transport that answers
/// `/auth/me` however a test says: a cold start with no network opens the
/// session this phone holds, offline, and only a session the server refuses
/// is given up.
void main() {
  final tokens = MobileSessionTokens(
    accessToken: 'access',
    accessTokenExpiresAt: DateTime.utc(2999, 1, 1),
    refreshToken: 'refresh',
    refreshTokenExpiresAt: DateTime.utc(2999, 2, 1),
  );
  final storedUser = AuthUser(
    id: 'user-1',
    email: 'reader@example.com',
    displayName: 'Reader',
    status: 'ACTIVE',
    createdAt: DateTime.utc(2026, 6, 1),
    updatedAt: DateTime.utc(2026, 6, 1),
    legalAcceptanceRequired: true,
    emailVerified: false,
  );
  final meJson = {
    'user': {
      'id': 'user-1',
      'email': 'reader@example.com',
      'displayName': 'Reader',
      'status': 'ACTIVE',
      'createdAt': '2026-06-01T00:00:00.000Z',
      'updatedAt': '2026-06-02T00:00:00.000Z',
      'legalAcceptanceRequired': false,
      'emailVerified': true,
    },
  };

  ({MobileAuthRepository auth, MemoryAuthTokenStore store}) harness(
    void Function(RequestOptions, RequestInterceptorHandler) answer, {
    AuthUser? user,
  }) {
    final store = MemoryAuthTokenStore(tokens, user);
    final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
    dio.interceptors.add(InterceptorsWrapper(onRequest: answer));
    final api = ApiClient(dio: dio, tokenStore: store);
    return (
      auth: MobileAuthRepository(apiClient: api, tokenStore: store),
      store: store,
    );
  }

  void offline(RequestOptions options, RequestInterceptorHandler handler) {
    handler.reject(
      DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      ),
    );
  }

  test('no network opens the stored session offline, with the stored '
      'account and no terms wall', () async {
    final h = harness(offline, user: storedUser);

    final session = await h.auth.restoreSession();

    expect(session, isNotNull);
    expect(session!.offline, isTrue);
    expect(session.user.id, 'user-1');
    expect(session.user.emailVerified, isFalse);
    expect(session.user.legalAcceptanceRequired, isFalse);
    expect(session.tokens.accessToken, 'access');
    // Nothing was given up: the next online restore uses the same tokens.
    expect((await h.store.read())?.refreshToken, 'refresh');
  });

  test('a gateway answering for a down server also opens it offline', () async {
    final h = harness((options, handler) {
      handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.badResponse,
          response: Response(
            requestOptions: options,
            statusCode: 502,
            data: '<html>Bad Gateway</html>',
          ),
        ),
      );
    }, user: storedUser);

    expect((await h.auth.restoreSession())?.offline, isTrue);
  });

  test('with no copy of the account on the phone the network error still '
      'reaches the splash', () async {
    final h = harness(offline);

    await expectLater(
      h.auth.restoreSession(),
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'NETWORK_ERROR'),
      ),
    );
    expect(await h.store.read(), isNotNull);
  });

  test('an online restore keeps the account for the next offline one', () async {
    var online = true;
    final h = harness((options, handler) {
      if (!online) return offline(options, handler);
      handler.resolve(Response(requestOptions: options, data: meJson));
    });

    final confirmed = await h.auth.restoreSession();
    expect(confirmed!.offline, isFalse);
    expect(confirmed.user.emailVerified, isTrue);
    expect((await h.store.readUser())?.email, 'reader@example.com');

    online = false;
    final restored = await h.auth.restoreSession();
    expect(restored!.offline, isTrue);
    expect(restored.user.emailVerified, isTrue);
  });

  test('a session the server refuses is given up, account copy and all', () async {
    final h = harness((options, handler) {
      handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.badResponse,
          response: Response(
            requestOptions: options,
            statusCode: 401,
            data: {
              'error': {
                'code': 'SESSION_REVOKED',
                'message': 'Sign in again to continue.',
              },
            },
          ),
        ),
      );
    }, user: storedUser);

    expect(await h.auth.restoreSession(), isNull);
    expect(await h.store.read(), isNull);
    expect(await h.store.readUser(), isNull);
  });

  test('signing in keeps the account for an offline start', () async {
    final h = harness((options, handler) {
      handler.resolve(
        Response(
          requestOptions: options,
          data: {
            ...meJson,
            'session': tokens.toJson(),
          },
        ),
      );
    });
    await h.store.clear();

    await h.auth.signIn(email: 'reader@example.com', password: 'secret-pass');

    expect((await h.store.readUser())?.id, 'user-1');
  });
}
