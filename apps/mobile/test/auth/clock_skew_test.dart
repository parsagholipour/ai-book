import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

// A phone whose clock runs fast saw every access token as already due: each
// request refreshed before it was sent, and the image headers re-read
// themselves once a second. Here the device is 20 minutes ahead of the server.

const _ahead = Duration(minutes: 20);

/// A session as the server sends it, issued at the server's "now".
Map<String, dynamic> _serverSession(
  String owner, {
  bool sendsLifetime = true,
}) {
  final serverNow = DateTime.now().toUtc().subtract(_ahead);
  return {
    'accessToken': '$owner-access',
    'accessTokenExpiresAt': serverNow
        .add(const Duration(minutes: 15))
        .toIso8601String(),
    if (sendsLifetime) 'accessTokenExpiresIn': 900,
    'refreshToken': '$owner-refresh',
    'refreshTokenExpiresAt': serverNow
        .add(const Duration(days: 90))
        .toIso8601String(),
  };
}

void main() {
  test('tokens from a server 20 minutes behind are fresh, measured on the '
      "device's own clock", () {
    final tokens = MobileSessionTokens.fromJson(
      _serverSession('a'),
      requestedAt: DateTime.now(),
    );

    expect(tokens.deviceClockAhead.inMinutes, 20);
    expect(tokens.shouldRefreshAccessToken, isFalse);
    expect(tokens.isRefreshExpired, isFalse);
    expect(tokens.refreshDueIn.inSeconds, inInclusiveRange(14 * 60, 855));
  });

  test('without the lifetime the device clock is trusted, as before', () {
    final tokens = MobileSessionTokens.fromJson(
      _serverSession('a', sendsLifetime: false),
      requestedAt: DateTime.now(),
    );

    expect(tokens.deviceClockAhead, Duration.zero);
    expect(tokens.shouldRefreshAccessToken, isTrue);
  });

  test('the stored form keeps the four fields installed builds read, and '
      'adds the offset', () {
    final tokens = MobileSessionTokens.fromJson(
      _serverSession('a'),
      requestedAt: DateTime.now(),
    );
    final stored = tokens.toJson();

    expect(stored['accessToken'], 'a-access');
    expect(
      DateTime.parse(stored['accessTokenExpiresAt'] as String),
      tokens.accessTokenExpiresAt,
    );
    expect(stored['refreshToken'], 'a-refresh');
    expect(
      DateTime.parse(stored['refreshTokenExpiresAt'] as String),
      tokens.refreshTokenExpiresAt,
    );
    expect(stored['deviceClockAheadMs'], tokens.deviceClockAhead.inMilliseconds);

    final restored = MobileSessionTokens.fromJson(stored);
    expect(
      restored.deviceClockAhead.inMilliseconds,
      tokens.deviceClockAhead.inMilliseconds,
    );
    expect(restored.shouldRefreshAccessToken, isFalse);

    // Written by a build from before the offset.
    final legacy = MobileSessionTokens.fromJson(
      Map.of(stored)..remove('deviceClockAheadMs'),
    );
    expect(legacy.deviceClockAhead, Duration.zero);
    expect(legacy.accessToken, 'a-access');
  });

  test('requests go out without a refresh each', () async {
    final server = _Server();
    addTearDown(server.dispose);
    await server.auth.signIn(email: 'reader@example.test', password: 'pw');

    for (var i = 0; i < 10; i++) {
      await server.api.getMap('/api/mobile/projects');
    }

    expect(server.refreshes, 0);
    expect(server.authorizations, List.filled(10, 'Bearer a-access'));
  });

  for (final sendsLifetime in [true, false]) {
    testWidgets('the image headers do not refresh in a loop over a minute '
        '(${sendsLifetime ? 'offset measured' : 'server sends no lifetime: '
                  'the floor holds'})', (tester) async {
      final server = _Server(sendsLifetime: sendsLifetime);
      addTearDown(server.dispose);
      await server.store.write(
        MobileSessionTokens.fromJson(
          _serverSession('a', sendsLifetime: sendsLifetime),
          requestedAt: DateTime.now(),
        ),
      );
      final container = ProviderContainer(
        overrides: [apiClientProvider.overrideWithValue(server.api)],
      );
      final headers = <String>[];
      container.listen(apiAuthHeadersProvider, (_, next) {
        final value = next.asData?.value['Authorization'];
        if (value != null) headers.add(value);
      }, fireImmediately: true);

      for (var second = 0; second < 60; second++) {
        await tester.pump(const Duration(seconds: 1));
      }
      // Here, not in a tear-down: the provider's renewal timer must be gone
      // before the test's own pending-timer check runs.
      container.dispose();

      expect(headers, isNotEmpty);
      if (sendsLifetime) {
        expect(server.refreshes, 0);
      } else {
        // Every re-read of a token that looks due is a refresh; the 30 s
        // floor allows the first and one each half minute, not one a second.
        expect(server.refreshes, inInclusiveRange(1, 3));
      }
    });
  }
}

class _Server {
  _Server({this.sendsLifetime = true}) {
    api = ApiClient(dio: dio, tokenStore: store);
    auth = MobileAuthRepository(apiClient: api, tokenStore: store);
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          final now = DateTime.now().toUtc().toIso8601String();
          final user = {
            'id': 'user-1',
            'email': 'reader@example.test',
            'status': 'ACTIVE',
            'createdAt': now,
            'updatedAt': now,
          };
          Map<String, dynamic> data;
          if (options.path.endsWith('/signin')) {
            data = {
              'user': user,
              'session': _serverSession('a', sendsLifetime: sendsLifetime),
            };
          } else if (options.path.endsWith('/refresh')) {
            refreshes += 1;
            data = {
              'user': user,
              'session': _serverSession(
                'a-renewed-$refreshes',
                sendsLifetime: sendsLifetime,
              ),
            };
          } else {
            authorizations.add(options.headers['Authorization'] as String);
            data = {'projects': []};
          }
          handler.resolve(Response(requestOptions: options, data: data));
        },
      ),
    );
  }

  final bool sendsLifetime;
  final store = MemoryAuthTokenStore();
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  late final ApiClient api;
  late final MobileAuthRepository auth;
  final authorizations = <String>[];
  int refreshes = 0;

  void dispose() => dio.close(force: true);
}
