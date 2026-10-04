import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

void main() {
  for (final signOut in [false, true]) {
    test(
      'a slow secure refresh write cannot outlive ${signOut ? 'logout' : 'sign-in'}',
      () async {
        final storage = DelayedSecureStorage();
        final store = SecureAuthTokenStore(storage: storage);
        await store.write(tokens('a'));
        storage.delayWrite = true;
        final rotating = store.writeIfCurrent(
          store.generation,
          tokens('a-renewed'),
        );
        await storage.writeStarted.future;
        final transition = signOut ? store.clear() : store.write(tokens('b'));
        storage.finishWrite.complete();
        expect(await rotating, isFalse);
        await transition;
        expect(
          (await store.read())?.accessToken,
          signOut ? isNull : 'b-access',
        );
        expect(
          storage.value == null
              ? null
              : jsonDecode(storage.value!)['accessToken'],
          signOut ? isNull : 'b-access',
        );
      },
    );
  }

  test('a failed storage write does not prevent the next logout', () async {
    final storage = DelayedSecureStorage();
    final store = SecureAuthTokenStore(storage: storage);
    await store.write(tokens('a'));
    storage.failWrite = true;
    await expectLater(
      store.writeIfCurrent(store.generation, tokens('a-renewed')),
      throwsStateError,
    );
    await store.clear();
    expect(await store.read(), isNull);
  });

  test(
    'corrupt stored tokens are removed without blocking later sign-in',
    () async {
      final storage = DelayedSecureStorage()..value = 'broken json';
      final store = SecureAuthTokenStore(storage: storage);
      expect(await store.read(), isNull);
      await store.write(tokens('b'));
      expect((await store.read())?.accessToken, 'b-access');
    },
  );
}

MobileSessionTokens tokens(String owner) => MobileSessionTokens(
  accessToken: '$owner-access',
  refreshToken: '$owner-refresh',
  accessTokenExpiresAt: DateTime.now().toUtc().add(const Duration(minutes: 15)),
  refreshTokenExpiresAt: DateTime.now().toUtc().add(const Duration(days: 30)),
);

class DelayedSecureStorage extends FlutterSecureStorage {
  String? value;
  bool delayWrite = false;
  bool failWrite = false;
  final writeStarted = Completer<void>();
  final finishWrite = Completer<void>();

  @override
  Future<String?> read({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => value;

  @override
  Future<void> write({
    required String key,
    required String? value,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (delayWrite) {
      delayWrite = false;
      writeStarted.complete();
      await finishWrite.future;
    }
    if (failWrite) throw StateError('Storage unavailable');
    this.value = value;
  }

  @override
  Future<void> delete({
    required String key,
    AppleOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    AppleOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    value = null;
  }
}
