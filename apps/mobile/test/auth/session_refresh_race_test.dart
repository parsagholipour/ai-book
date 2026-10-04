import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
  for (final switchAccount in [false, true]) {
    for (final succeeds in [false, true]) {
      test(
        'late refresh ${succeeds ? 'success' : 'failure'} cannot change '
        '${switchAccount ? 'the new account' : 'a logged-out session'}',
        () async {
          final harness = SessionRaceHarness();
          addTearDown(harness.dispose);
          // This is an ordinary authenticated request, so a stale refresh must
          // neither change the store nor send the waiting request as either user.
          final request = harness.api.getMap('/api/mobile/projects');
          final rejected = expectLater(request, throwsA(isA<ApiException>()));
          await harness.refreshStarted.future;
          await harness.auth.logout();
          if (switchAccount) await harness.signInB();

          harness.finishRefresh('a', succeeds: succeeds);
          await rejected;
          expect(harness.authorizations, isEmpty);
          if (switchAccount) {
            await harness.api.getMap('/api/mobile/projects');
            expect(harness.authorizations, ['Bearer b-access']);
          } else {
            expect(await harness.store.read(), isNull);
          }
        },
      );
    }
  }

  test(
    'the new account refreshes without joining an old in-flight refresh',
    () async {
      final harness = SessionRaceHarness(staleB: true);
      addTearDown(harness.dispose);
      final old = harness.api.refreshTokens();
      final rejected = expectLater(old, throwsA(isA<ApiException>()));
      await harness.refreshStarted.future;
      await harness.auth.logout();
      await harness.signInB();

      final next = harness.api.refreshTokens();
      await harness.waitForRefresh('b');
      harness.finishRefresh('a');
      await rejected;
      // The old completion must not clear B's single-flight slot either.
      final shared = harness.api.refreshTokens();
      harness.finishRefresh('b');
      final refreshed = await Future.wait([next, shared]);
      expect(refreshed.map((tokens) => tokens.accessToken), [
        'b-renewed-access',
        'b-renewed-access',
      ]);
      expect(harness.refreshCounts['b'], 1);
      expect((await harness.store.read())?.accessToken, 'b-renewed-access');
    },
  );

  test('a failed session restore cannot clear a newer sign-in', () async {
    final harness = SessionRaceHarness();
    addTearDown(harness.dispose);
    final restoring = harness.auth.restoreSession();
    await harness.refreshStarted.future;
    await harness.auth.logout();
    await harness.signInB();

    harness.finishRefresh('a', succeeds: false);
    expect(await restoring, isNull);
    await harness.api.getMap('/api/mobile/projects');
    expect(harness.authorizations, ['Bearer b-access']);
  });

  test(
    'a current session still refreshes and clears on an auth refusal',
    () async {
      final harness = SessionRaceHarness();
      addTearDown(harness.dispose);
      final refresh = harness.api.refreshTokens();
      await harness.refreshStarted.future;
      harness.finishRefresh('a');
      expect((await refresh).accessToken, 'a-renewed-access');
      expect((await harness.store.read())?.accessToken, 'a-renewed-access');

      final refused = harness.api.refreshTokens();
      final rejected = expectLater(refused, throwsA(isA<ApiException>()));
      await harness.waitForRefresh('a-renewed');
      harness.finishRefresh('a-renewed', succeeds: false);
      await rejected;
      expect(await harness.store.read(), isNull);
    },
  );
}

MobileSessionTokens sessionTokens(String owner, {bool stale = false}) {
  final now = DateTime.now().toUtc();
  return MobileSessionTokens(
    accessToken: '$owner-access',
    refreshToken: '$owner-refresh',
    accessTokenExpiresAt: now.add(Duration(minutes: stale ? -1 : 15)),
    refreshTokenExpiresAt: now.add(const Duration(days: 30)),
  );
}

class SessionRaceHarness {
  SessionRaceHarness({this.staleB = false}) {
    api = ApiClient(dio: dio, tokenStore: store);
    auth = MobileAuthRepository(apiClient: api, tokenStore: store);
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          if (options.path.endsWith('/refresh')) {
            final owner = (options.data['refreshToken'] as String).replaceFirst(
              RegExp(r'-refresh$'),
              '',
            );
            refreshes[owner] = (options, handler);
            _refreshArrivals.putIfAbsent(owner, Completer<void>.new).complete();
            refreshCounts.update(
              owner,
              (count) => count + 1,
              ifAbsent: () => 1,
            );
            if (!refreshStarted.isCompleted) refreshStarted.complete();
          } else if (options.path.endsWith('/logout')) {
            // Offline logout is supported: local session isolation must hold even
            // when the server cannot revoke the old credentials.
            handler.reject(
              DioException(
                requestOptions: options,
                type: DioExceptionType.connectionError,
              ),
            );
          } else if (options.path.endsWith('/signin')) {
            final now = DateTime.now().toUtc().toIso8601String();
            handler.resolve(
              Response(
                requestOptions: options,
                data: {
                  'user': {
                    'id': 'account-b',
                    'email': 'b@example.test',
                    'status': 'ACTIVE',
                    'createdAt': now,
                    'updatedAt': now,
                  },
                  'session': sessionTokens('b', stale: staleB).toJson(),
                },
              ),
            );
          } else {
            authorizations.add(options.headers['Authorization'] as String);
            handler.resolve(
              Response(requestOptions: options, data: {'projects': []}),
            );
          }
        },
      ),
    );
  }

  final bool staleB;
  final store = MemoryAuthTokenStore(sessionTokens('a', stale: true));
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  final refreshStarted = Completer<void>();
  final refreshes = <String, (RequestOptions, RequestInterceptorHandler)>{};
  final refreshCounts = <String, int>{};
  final _refreshArrivals = <String, Completer<void>>{};

  Future<void> waitForRefresh(String owner) => _refreshArrivals
      .putIfAbsent(owner, Completer<void>.new)
      .future
      .timeout(const Duration(seconds: 2));
  final authorizations = <String>[];
  late final ApiClient api;
  late final MobileAuthRepository auth;

  Future<void> signInB() async {
    final session = await auth.signIn(
      email: 'b@example.test',
      password: 'password',
    );
    expect(session.user.id, 'account-b');
    expect((await store.read())?.accessToken, 'b-access');
  }

  void finishRefresh(String owner, {bool succeeds = true}) {
    final (options, handler) = refreshes.remove(owner)!;
    if (succeeds) {
      handler.resolve(
        Response(
          requestOptions: options,
          data: {'session': sessionTokens('$owner-renewed').toJson()},
        ),
      );
    } else {
      handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.badResponse,
          response: Response(
            requestOptions: options,
            statusCode: 401,
            data: {
              'error': {'code': 'INVALID_SESSION', 'message': 'Sign in again.'},
            },
          ),
        ),
      );
    }
  }

  void dispose() => dio.close(force: true);
}
