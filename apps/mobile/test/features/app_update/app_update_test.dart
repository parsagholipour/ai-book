import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/app_update/data/app_update_repository.dart';
import 'package:tomeza/features/app_update/domain/app_update.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
  group('AppUpdateStatus', () {
    test('reads the update object the server sends', () {
      expect(
        AppUpdateStatus.fromJson({
          'action': 'prompt',
          'latestBuild': 9,
          'latestVersion': '1.2.0',
          'message': ' New covers ',
        }),
        const AppUpdateStatus(
          action: AppUpdateAction.prompt,
          latestBuild: 9,
          latestVersion: '1.2.0',
          message: 'New covers',
        ),
      );
    });

    test('an action this build does not know asks nothing', () {
      expect(
        AppUpdateStatus.fromJson({'action': 'sunset', 'latestBuild': 9}).action,
        AppUpdateAction.none,
      );
      expect(AppUpdateStatus.fromJson(null), AppUpdateStatus.none);
      expect(AppUpdateStatus.fromJson('required'), AppUpdateStatus.none);
    });
  });

  group('AppBuild', () {
    test('names the build and platform in its headers', () {
      expect(AppBuild.parse('7', platform: 'android')?.headers, {
        'X-App-Build': '7',
        'X-App-Platform': 'android',
      });
    });

    test('is null for a build number the server could not compare', () {
      expect(AppBuild.parse('', platform: 'android'), isNull);
      expect(AppBuild.parse('1.0', platform: 'android'), isNull);
      expect(AppBuild.parse('0', platform: 'android'), isNull);
    });

    test('rides every request once main has read it', () {
      final container = ProviderContainer(
        overrides: [
          appBuildProvider.overrideWithValue(
            const AppBuild(build: 7, platform: 'android'),
          ),
        ],
      );
      addTearDown(container.dispose);

      final headers = container.read(dioProvider).options.headers;
      expect(headers['X-App-Build'], '7');
      expect(headers['X-App-Platform'], 'android');
      expect(headers['Accept'], 'application/json');
    });

    test('is not sent when this install has no build to name', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      expect(
        container.read(dioProvider).options.headers.containsKey('X-App-Build'),
        isFalse,
      );
    });
  });

  group('a 426 from any request', () {
    test(
      'reports the decision it carries and is not an auth failure',
      () async {
        Map<String, dynamic>? reported;
        final tokens = MemoryAuthTokenStore(_validTokens());
        final apiClient = ApiClient(
          dio: Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
            ..httpClientAdapter = _JsonAdapter(426, {
              'error': {
                'code': 'APP_UPDATE_REQUIRED',
                'message': 'Update the app to keep going.',
                'update': {
                  'action': 'required',
                  'latestBuild': 9,
                  'latestVersion': '1.2.0',
                  'message': 'Fixes purchases',
                },
              },
            }),
          tokenStore: tokens,
          onAppUpdateRequired: (details) => reported = details,
        );

        await expectLater(
          apiClient.getMap('/api/mobile/projects'),
          throwsA(
            isA<ApiException>()
                .having((error) => error.statusCode, 'statusCode', 426)
                .having((error) => error.isAuthFailure, 'isAuthFailure', false),
          ),
        );
        expect(reported?['update'], containsPair('latestBuild', 9));
        expect(await tokens.read(), isNotNull);
      },
    );

    test('sends the app to the update screen through the status', () async {
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            Dio(BaseOptions(baseUrl: 'http://localhost:4001'))
              ..httpClientAdapter = _JsonAdapter(426, {
                'error': {
                  'code': 'APP_UPDATE_REQUIRED',
                  'message': 'Update the app to keep going.',
                  'update': {
                    'action': 'required',
                    'message': 'Fixes purchases',
                  },
                },
              }),
          ),
          authTokenStoreProvider.overrideWithValue(MemoryAuthTokenStore()),
        ],
      );
      addTearDown(container.dispose);

      await expectLater(
        container
            .read(apiClientProvider)
            .getMap('/api/mobile/legal', requiresAuth: false),
        throwsA(isA<ApiException>()),
      );

      final status = container.read(appUpdateStatusProvider);
      expect(status.isRequired, isTrue);
      expect(status.message, 'Fixes purchases');
    });

    test('is required even when its body says nothing', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      container.read(appUpdateStatusProvider.notifier).reportRequired(const {});

      expect(container.read(appUpdateStatusProvider).isRequired, isTrue);
    });
  });

  group('AppUpdateChecker', () {
    test('writes what the server says to the status', () async {
      final repository = _FakeRepository([
        const AppUpdateStatus(
          action: AppUpdateAction.prompt,
          latestBuild: 9,
          latestVersion: '1.2.0',
        ),
      ]);
      final container = _checkerContainer(repository);

      await container.read(appUpdateCheckerProvider).refresh();

      expect(
        container.read(appUpdateStatusProvider).action,
        AppUpdateAction.prompt,
      );
    });

    test('a resume soon after a check does not ask again', () async {
      final repository = _FakeRepository([AppUpdateStatus.none]);
      final container = _checkerContainer(repository);
      final checker = container.read(appUpdateCheckerProvider);

      await checker.refresh();
      await checker.refresh(ifOlderThan: const Duration(minutes: 5));

      expect(repository.calls, 1);
    });

    test('a failed check leaves the last answer standing', () async {
      final repository = _FakeRepository([
        const AppUpdateStatus(action: AppUpdateAction.required),
      ]);
      final container = _checkerContainer(repository);
      final checker = container.read(appUpdateCheckerProvider);

      await checker.refresh();
      repository.fail = true;
      await checker.refresh();

      expect(container.read(appUpdateStatusProvider).isRequired, isTrue);
    });

    test('asks nothing when this install has no build to name', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      await container.read(appUpdateCheckerProvider).refresh();

      expect(container.read(appUpdateStatusProvider), AppUpdateStatus.none);
    });
  });
}

ProviderContainer _checkerContainer(AppUpdateRepository repository) {
  final container = ProviderContainer(
    overrides: [appUpdateRepositoryProvider.overrideWithValue(repository)],
  );
  addTearDown(container.dispose);
  return container;
}

class _FakeRepository implements AppUpdateRepository {
  _FakeRepository(this._answers);

  final List<AppUpdateStatus> _answers;
  int calls = 0;
  bool fail = false;

  @override
  Future<AppUpdateStatus> check() async {
    calls += 1;
    if (fail) throw StateError('offline');
    return _answers[(calls - 1).clamp(0, _answers.length - 1)];
  }
}

class _JsonAdapter implements HttpClientAdapter {
  _JsonAdapter(this.statusCode, this.body);

  final int statusCode;
  final Map<String, dynamic> body;

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
      jsonEncode(body),
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}

MobileSessionTokens _validTokens() {
  final now = DateTime.now().toUtc();
  return MobileSessionTokens(
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessTokenExpiresAt: now.add(const Duration(minutes: 15)),
    refreshTokenExpiresAt: now.add(const Duration(days: 30)),
  );
}
