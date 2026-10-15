import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/domain/auth_models.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';
import 'package:tomeza/shared/api/api_client.dart';
import 'package:tomeza/shared/api/auth_token_store.dart';

import '../app/app_test_fixtures.dart' show fakeSession;
import 'billing_paywall_harness.dart';

class AccountBillingRepository extends MobileBillingRepository {
  AccountBillingRepository({required super.apiClient});
  String accountId = 'account-A';
  @override
  Future<MobileBilling> getBilling() async =>
      fakeBilling(availableCredits: 0, purchaseAccountId: accountId);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('checkout refreshes the account after the paywall was loaded', () async {
    final repository = FakeBillingRepository()
      ..billing = fakeBilling(
        availableCredits: 0,
        purchaseAccountId: 'account-A',
      );
    final store = FakeStoreBillingClient();
    final container = ProviderContainer(
      overrides: [
        billingRepositoryProvider.overrideWithValue(repository),
        storeBillingClientProvider.overrideWithValue(store),
      ],
    );
    addTearDown(container.dispose);
    final watcher = container.listen(
      billingControllerProvider(null),
      (_, _) {},
    );
    final controller = watcher.read();
    await pumpEventQueue();
    expect(controller.state.billing?.purchaseAccountId, 'account-A');
    repository.billing = fakeBilling(
      availableCredits: 0,
      purchaseAccountId: 'account-B',
    );
    await controller.buy(
      controller.products.firstWhere((p) => p.sku == 'tomeza.credit_pack_1'),
    );
    expect(store.buyCalls.single.purchaseAccountId, 'account-B');
    watcher.close();
  });

  for (final completion in [
    StorePurchaseStatus.purchased,
    StorePurchaseStatus.restored,
  ]) {
    test('a $completion receipt stays with its checkout account', () async {
      final sessionA = fakeSession(email: 'a@example.test');
      final sessionB = MobileSessionTokens(
        accessToken: 'account-B-access',
        accessTokenExpiresAt: DateTime.utc(2999),
        refreshToken: 'account-B-refresh',
        refreshTokenExpiresAt: DateTime.utc(2999),
      );
      final tokens = MemoryAuthTokenStore(sessionA.tokens);
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
      final requests = <RequestOptions>[];
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            requests.add(options);
            final data = switch (options.path) {
              '/api/mobile/auth/me' => {'user': sessionA.user.toJson()},
              '/api/mobile/auth/signin' =>
                (options.data as Map)['email'] == 'a@example.test'
                    ? {
                        'user': sessionA.user.toJson(),
                        'session': sessionA.tokens.toJson(),
                      }
                    : {
                        'user': {
                          ...sessionA.user.toJson(),
                          'id': 'user-B',
                          'email': 'b@example.test',
                        },
                        'session': sessionB.toJson(),
                      },
              '/api/mobile/billing/google-play/verify' => {
                'purchase': {
                  'id': 'purchase-1',
                  // A pending payment is sent with no status, and Google still
                  // reports it pending to the server.
                  'status': (options.data as Map)['purchaseStatus'] == null
                      ? 'pending'
                      : 'granted',
                  'creditsGranted': 1000,
                },
                'billing': {
                  'purchaseAccountId': 'account-A',
                  'credits': {
                    'available': 1000,
                    'reserved': 0,
                    'lifetimeGranted': 1000,
                    'lifetimeSpent': 0,
                  },
                  'entitlements': [],
                  'products': [],
                  'creditCosts': {},
                },
              },
              _ => {'ok': true},
            };
            handler.resolve(
              Response(
                requestOptions: options,
                statusCode: 200,
                data: jsonDecode(jsonEncode(data)),
              ),
            );
          },
        ),
      );
      final api = ApiClient(dio: dio, tokenStore: tokens);
      final store = FakeStoreBillingClient();
      final repository = AccountBillingRepository(apiClient: api);
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(
            MobileAuthRepository(apiClient: api, tokenStore: tokens),
          ),
          billingRepositoryProvider.overrideWithValue(repository),
          storeBillingClientProvider.overrideWithValue(store),
        ],
      );
      addTearDown(() {
        container.dispose();
        dio.close(force: true);
      });
      await container.read(authControllerProvider.future);
      final watcher = container.listen(
        billingControllerProvider(null),
        (_, _) {},
      );
      final controller = watcher.read();
      await pumpEventQueue();
      await controller.buy(
        controller.products.firstWhere((p) => p.sku == 'tomeza.credit_pack_1'),
      );
      expect(store.buyCalls.single.purchaseAccountId, 'account-A');
      store.emit(
        const StorePurchaseUpdate(
          productId: 'tomeza.credit_pack_1',
          status: StorePurchaseStatus.pending,
          purchaseToken: 'account-A-purchase',
          purchaseAccountId: 'account-A',
        ),
      );
      await pumpEventQueue();
      // The pending payment is recorded under A, the account that started it.
      bool isVerify(RequestOptions r) => r.path.endsWith('/google-play/verify');
      final pendingRecord = requests.singleWhere(isVerify);
      expect(
        pendingRecord.headers['Authorization'],
        'Bearer ${sessionA.tokens.accessToken}',
      );
      expect(pendingRecord.data['purchaseStatus'], isNull);
      expect(store.finished, isEmpty);
      watcher.close();
      await container.read(authControllerProvider.notifier).logout();
      await container
          .read(authControllerProvider.notifier)
          .signIn(email: 'b@example.test', password: 'unused');
      repository.accountId = 'account-B';
      expect(container.read(authControllerProvider).value?.user.id, 'user-B');
      store.emit(
        StorePurchaseUpdate(
          productId: 'tomeza.credit_pack_1',
          status: completion,
          purchaseToken: 'account-A-purchase',
          purchaseAccountId: 'account-A',
        ),
      );
      await pumpEventQueue();
      expect(requests.where(isVerify), [pendingRecord]);
      expect(store.finished, isEmpty);

      // A newly opened paywall (or restarted app) must also reject A's receipt.
      final otherWatcher = container.listen(
        billingControllerProvider(null),
        (_, _) {},
      );
      await pumpEventQueue();
      store.emit(
        const StorePurchaseUpdate(
          productId: 'tomeza.credit_pack_1',
          status: StorePurchaseStatus.restored,
          purchaseToken: 'account-A-purchase',
          purchaseAccountId: 'account-A',
        ),
      );
      await pumpEventQueue();
      expect(requests.where(isVerify), [pendingRecord]);
      expect(otherWatcher.read().state.error, contains('account that started'));
      otherWatcher.close();
      await pumpEventQueue();

      // The purchase remains unfinished, so A can restore and receive it.
      await container.read(authControllerProvider.notifier).logout();
      await container
          .read(authControllerProvider.notifier)
          .signIn(email: 'a@example.test', password: 'unused');
      repository.accountId = 'account-A';
      final restoredWatcher = container.listen(
        billingControllerProvider(null),
        (_, _) {},
      );
      await pumpEventQueue();
      store.emit(
        const StorePurchaseUpdate(
          productId: 'tomeza.credit_pack_1',
          status: StorePurchaseStatus.restored,
          purchaseToken: 'account-A-purchase',
          purchaseAccountId: 'account-A',
        ),
      );
      await pumpEventQueue();
      final verify = requests.where(isVerify).last;
      expect(requests.where(isVerify), hasLength(2));
      expect(
        verify.headers['Authorization'],
        'Bearer ${sessionA.tokens.accessToken}',
      );
      expect(verify.data['purchaseToken'], 'account-A-purchase');
      expect(store.finished.single.purchaseToken, 'account-A-purchase');
      restoredWatcher.close();
    });
  }
}
