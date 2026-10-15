import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/app.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

import '../app/app_test_fixtures.dart';

// A session the server stops honouring mid-use signs the reader out to the
// sign-in screen, which says why. The app, the real auth repository and the
// real API client run here; only the HTTP transport is fake.

void main() {
  for (final (status, code) in [
    (401, 'INVALID_SESSION'),
    (401, 'SESSION_REVOKED'),
    (401, 'SESSION_EXPIRED'),
    (403, 'ACCOUNT_DISABLED'),
  ]) {
    testWidgets('a refresh refused with $code signs the reader out to '
        'sign-in, and says so', (tester) async {
      final server = _Server(refresh: _refuse(status, code));
      await _pumpSignedIn(tester, server);

      final failure = await _probe(tester, server);

      expect(failure.code, code);
      expect(server.refreshes, 1);
      await _expectSignedOut(tester, server, notice: true);
    });
  }

  testWidgets('a refresh token that ran out signs the reader out without '
      'asking the server', (tester) async {
    final server = _Server();
    await _pumpSignedIn(tester, server);
    await server.store.writeIfCurrent(
      server.store.generation,
      _tokens('a', refreshExpiresIn: const Duration(seconds: -1)),
    );

    final failure = await _probe(tester, server);

    expect(failure.code, 'SESSION_EXPIRED');
    expect(server.refreshes, 0);
    expect(server.probes, 0);
    await _expectSignedOut(tester, server, notice: true);
  });

  testWidgets('a disabled account signs the reader out from any request', (
    tester,
  ) async {
    final server = _Server(probe: _refuse(403, 'ACCOUNT_DISABLED'));
    await _pumpSignedIn(tester, server);

    final failure = await _probe(tester, server);

    expect(failure.code, 'ACCOUNT_DISABLED');
    expect(server.refreshes, 0);
    await _expectSignedOut(tester, server, notice: true);
  });

  testWidgets('a refresh lost to the network keeps the reader signed in', (
    tester,
  ) async {
    final server = _Server(
      refresh: (options, handler) => handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.connectionError,
        ),
      ),
    );
    await _pumpSignedIn(tester, server);

    final failure = await _probe(tester, server);

    expect(failure.code, 'NETWORK_ERROR');
    expect((await server.store.read())?.accessToken, 'a-access');
    expect(_auth(tester).value, isNotNull);
    expect(find.text('Welcome back'), findsNothing);
    expect(find.text('You were signed out'), findsNothing);
  });

  testWidgets('the notice is shown once: signing in again and logging out '
      'does not bring it back', (tester) async {
    final server = _Server(refresh: _refuse(401, 'INVALID_SESSION'));
    await _pumpSignedIn(tester, server);
    await _probe(tester, server);
    await _expectSignedOut(tester, server, notice: true);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      'reader@example.com',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Password'),
      'CorrectPass123',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
    await tester.pumpAndSettle();
    expect(_auth(tester).value?.tokens.accessToken, 'b-access');
    expect(find.text('Welcome back'), findsNothing);

    await _container(tester).read(authControllerProvider.notifier).logout();
    await tester.pumpAndSettle();
    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('You were signed out'), findsNothing);
  });
}

ProviderContainer _container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(TomezaApp)));

AsyncValue<AuthSession?> _auth(WidgetTester tester) =>
    _container(tester).read(authControllerProvider);

Future<void> _pumpSignedIn(WidgetTester tester, _Server server) async {
  addTearDown(() => server.dio.close(force: true));
  await tester.pumpWidget(
    testApp(
      authRepository: null,
      overrides: [
        authTokenStoreProvider.overrideWithValue(server.store),
        dioProvider.overrideWithValue(server.dio),
      ],
    ),
  );
  await tester.pumpAndSettle();
  expect(_auth(tester).value?.user.id, 'user-1');
  expect(find.text('Welcome back'), findsNothing);
}

/// Some screen's request, through the app's own client.
Future<ApiException> _probe(WidgetTester tester, _Server server) async {
  Object? failure;
  unawaited(
    _container(tester)
        .read(apiClientProvider)
        .getMap('/api/mobile/probe')
        .then<void>((_) {}, onError: (Object error) => failure = error),
  );
  await tester.pumpAndSettle();
  expect(failure, isA<ApiException>());
  return failure! as ApiException;
}

Future<void> _expectSignedOut(
  WidgetTester tester,
  _Server server, {
  required bool notice,
}) async {
  expect(await server.store.read(), isNull);
  expect(_auth(tester).value, isNull);
  expect(find.text('Welcome back'), findsOneWidget);
  expect(
    find.text('You were signed out'),
    notice ? findsOneWidget : findsNothing,
  );
}

typedef _Answer = void Function(RequestOptions, RequestInterceptorHandler);

_Answer _refuse(int status, String code) {
  return (options, handler) => handler.reject(
    DioException(
      requestOptions: options,
      type: DioExceptionType.badResponse,
      response: Response(
        requestOptions: options,
        statusCode: status,
        data: {
          'error': {'code': code, 'message': 'Sign in again to continue.'},
        },
      ),
    ),
  );
}

MobileSessionTokens _tokens(
  String owner, {
  Duration refreshExpiresIn = const Duration(days: 90),
}) {
  final now = DateTime.now().toUtc();
  return MobileSessionTokens(
    accessToken: '$owner-access',
    refreshToken: '$owner-refresh',
    accessTokenExpiresAt: now.add(const Duration(minutes: 15)),
    refreshTokenExpiresAt: now.add(refreshExpiresIn),
  );
}

/// The API as the auth layer answers it. The probe refuses the first
/// account's access token, as the server does once a session is revoked,
/// deleted or rotated past; [refresh] decides what the refresh that follows
/// is told.
class _Server {
  _Server({this.refresh, this.probe}) {
    dio.interceptors.add(InterceptorsWrapper(onRequest: _answer));
  }

  final _Answer? refresh;
  final _Answer? probe;
  final store = MemoryAuthTokenStore(_tokens('a'));
  final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
  int refreshes = 0;
  int probes = 0;

  void _answer(RequestOptions options, RequestInterceptorHandler handler) {
    final user = fakeSession().user.toJson();
    switch (options.path) {
      case '/api/mobile/auth/me':
        _ok(options, handler, {'user': user});
      case '/api/mobile/auth/signin':
        _ok(options, handler, {
          'user': user,
          'session': _tokens('b').toJson(),
        });
      case '/api/mobile/auth/refresh':
        refreshes += 1;
        final answer = refresh;
        if (answer != null) return answer(options, handler);
        _ok(options, handler, {'session': _tokens('a-renewed').toJson()});
      case '/api/mobile/probe':
        probes += 1;
        final answer = probe;
        if (answer != null) return answer(options, handler);
        if (options.headers['Authorization'] == 'Bearer a-access') {
          return _refuse(401, 'INVALID_SESSION')(options, handler);
        }
        _ok(options, handler, {'ok': true});
      case '/api/mobile/auth/logout':
        _ok(options, handler, {'ok': true});
      default:
        _refuse(404, 'NOT_FOUND')(options, handler);
    }
  }

  static void _ok(
    RequestOptions options,
    RequestInterceptorHandler handler,
    Map<String, dynamic> data,
  ) {
    handler.resolve(
      Response(requestOptions: options, statusCode: 200, data: data),
    );
  }
}
