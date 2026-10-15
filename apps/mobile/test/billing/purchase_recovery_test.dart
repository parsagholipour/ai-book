import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/auth/data/auth_repository.dart';
import 'package:tomeza/features/auth/presentation/auth_controller.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/data/play_purchase_processor.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';
import 'package:tomeza/features/billing/presentation/billing_purchase_watcher.dart';

import '../app/app_test_fixtures.dart' show FakeAuthRepository, fakeSession;
import 'billing_paywall_harness.dart';

/// A purchase nobody verifies is refunded by Play after three days, and the
/// server's notification handler ignores a token no account has claimed. These
/// are the purchases the paywall-scoped listener used to lose: one landing with
/// no paywall open, one a dead process or a dropped verify call left
/// unfinished, and a slow card that clears later.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeStoreBillingClient store;
  late FakeBillingRepository repository;
  late PlayPurchaseProcessor purchases;
  late DateTime now;
  var billingChanges = 0;

  setUp(() {
    store = FakeStoreBillingClient();
    repository = FakeBillingRepository();
    now = DateTime.utc(2026, 10, 12, 9);
    billingChanges = 0;
    purchases = PlayPurchaseProcessor(
      billingRepository: repository,
      storeClient: store,
      onBillingChanged: () => billingChanges += 1,
      clock: () => now,
    );
  });

  tearDown(() => purchases.dispose());

  StorePurchaseUpdate held(
    String sku,
    String token, {
    StorePurchaseStatus status = StorePurchaseStatus.restored,
    bool acknowledged = false,
    String account = 'test-purchase-account',
  }) {
    return StorePurchaseUpdate(
      productId: sku,
      status: status,
      purchaseToken: token,
      purchaseId: 'order-$token',
      purchaseAccountId: account,
      pendingCompletePurchase: !acknowledged,
    );
  }

  test('a purchase that lands with no paywall open is verified, then '
      'finished', () async {
    final gated = _GatedRepository();
    purchases.dispose();
    purchases = PlayPurchaseProcessor(
      billingRepository: gated,
      storeClient: store,
      onBillingChanged: () => billingChanges += 1,
    );
    await purchases.signedIn('user-1');

    final gate = gated.gate = Completer<void>();
    store.emit(
      held(
        'tomeza.credit_pack_1',
        'late-token',
        status: StorePurchaseStatus.purchased,
      ),
    );
    await pumpEventQueue();
    // Play is told nothing until the server has recorded it.
    expect(gated.verifications.single.purchaseToken, 'late-token');
    expect(gated.verifications.single.purchaseStatus, 'purchased');
    expect(store.finished, isEmpty);

    gate.complete();
    await pumpEventQueue();
    expect(store.finished.single.purchaseToken, 'late-token');
    expect(store.finished.single.consumable, isTrue);
    expect(billingChanges, 1);
  });

  test(
    'sign-in settles what Play still holds unfinished, and only that',
    () async {
      store.owned = [
        // A checkout the process died under: never verified, never acknowledged.
        held('tomeza.creator_monthly', 'orphan-plan'),
        // Granted and acknowledged by the server, never consumed by the app.
        held('tomeza.credit_pack_1', 'unconsumed-pack', acknowledged: true),
        // A plan running normally: Play returns it, and there is nothing to do.
        held('tomeza.pro_monthly', 'running-plan', acknowledged: true),
      ];

      await purchases.signedIn('user-1');

      expect(
        repository.verifications.map((call) => call.purchaseToken).toList(),
        ['orphan-plan', 'unconsumed-pack'],
      );
      expect(
        repository.verifications.map((call) => call.purchaseStatus),
        everyElement('restored'),
      );
      expect(
        store.finished.map((call) => (call.purchaseToken, call.consumable)),
        [('orphan-plan', false), ('unconsumed-pack', true)],
      );
    },
  );

  test(
    'a return to the foreground verifies an unacknowledged purchase once',
    () async {
      await purchases.signedIn('user-1');
      expect(store.ownedQueries, 1);

      // The verify call after checkout failed on a flaky network.
      store.owned = [held('tomeza.creator_monthly', 'dropped-verify')];
      await purchases.resumed();
      // Too soon after the sign-in pass: no query at all.
      expect(store.ownedQueries, 1);

      now = now.add(PlayPurchaseProcessor.resumeInterval);
      await Future.wait([purchases.resumed(), purchases.resumed()]);
      expect(store.ownedQueries, 2);
      expect(repository.verifications.single.purchaseToken, 'dropped-verify');
      expect(store.finished.single.purchaseToken, 'dropped-verify');

      now = now.add(PlayPurchaseProcessor.resumeInterval);
      await purchases.resumed();
      expect(store.ownedQueries, 3);
      expect(repository.verifications, hasLength(1));
    },
  );

  test('a purchase made for another Tomeza account is left for it', () async {
    store.owned = [
      held('tomeza.credit_pack_1', 'someone-elses', account: 'other-account'),
    ];

    await purchases.signedIn('user-1');

    expect(repository.verifications, isEmpty);
    expect(store.finished, isEmpty);
    expect(store.owned, hasLength(1));
  });

  test('a pending payment is recorded once, never finished, and holds only '
      'its own product', () async {
    var links = 0;
    final controller = BillingController(
      billingRepository: repository,
      storeClient: store,
      purchases: purchases,
      onBillingChanged: () {},
      keepAlive: () {
        links += 1;
        return () => links -= 1;
      },
    );
    addTearDown(controller.dispose);
    final events = <BillingPurchaseEvent>[];
    controller.purchaseEvents.listen(events.add);
    await pumpEventQueue();
    MobileBillingProduct product(String sku) =>
        controller.products.firstWhere((item) => item.sku == sku);

    await controller.buy(product('tomeza.credit_pack_1'));
    store.emit(
      held(
        'tomeza.credit_pack_1',
        'slow-card',
        status: StorePurchaseStatus.pending,
      ),
    );
    await pumpEventQueue();

    // On record with no status, so Google's notification can grant it.
    expect(repository.verifications.single.purchaseToken, 'slow-card');
    expect(repository.verifications.single.purchaseStatus, isNull);
    expect(store.finished, isEmpty);
    expect(repository.billing.credits.available, 100);
    expect(controller.state.awaitingPaymentProductIds, {
      'tomeza.credit_pack_1',
    });
    expect(controller.state.pendingProductIds, isEmpty);
    expect(controller.state.message, billingAwaitingPaymentMessage);
    expect(links, 0);

    // Another product is still for sale.
    await controller.buy(product('tomeza.credit_pack_2'));
    expect(store.buyCalls, hasLength(2));
    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.canceled,
        purchaseToken: '',
      ),
    );
    await pumpEventQueue();

    // The pending one is not: Play would refuse it as already owned.
    await controller.buy(product('tomeza.credit_pack_1'));
    expect(store.buyCalls, hasLength(2));
    expect(controller.state.message, billingAwaitingPaymentMessage);

    // A later pass does not record it again.
    now = now.add(PlayPurchaseProcessor.resumeInterval);
    store.owned = [
      held(
        'tomeza.credit_pack_1',
        'slow-card',
        status: StorePurchaseStatus.pending,
      ),
    ];
    await purchases.reconcile();
    expect(repository.verifications, hasLength(1));

    // The card clears while the app is open: verified, finished, released.
    store.emit(
      held(
        'tomeza.credit_pack_1',
        'slow-card',
        status: StorePurchaseStatus.purchased,
      ),
    );
    await pumpEventQueue();
    expect(repository.verifications.last.purchaseStatus, 'purchased');
    expect(store.finished.single.purchaseToken, 'slow-card');
    expect(controller.state.awaitingPaymentProductIds, isEmpty);
    expect(events.last, isA<BillingPurchaseSuccess>());
  });

  test('a pending payment Play drops is no longer held', () async {
    await purchases.signedIn('user-1');
    store.emit(
      held(
        'tomeza.credit_pack_1',
        'declined',
        status: StorePurchaseStatus.pending,
      ),
    );
    await pumpEventQueue();
    expect(purchases.awaitingPaymentProductIds, {'tomeza.credit_pack_1'});

    // The card was declined; Play no longer returns the purchase.
    now = now.add(PlayPurchaseProcessor.resumeInterval);
    await purchases.resumed();

    expect(purchases.awaitingPaymentProductIds, isEmpty);
  });

  test('sign-out stops the listener and forgets the account', () async {
    await purchases.signedIn('user-1');
    store.emit(
      held(
        'tomeza.credit_pack_1',
        'pending-a',
        status: StorePurchaseStatus.pending,
      ),
    );
    await pumpEventQueue();
    expect(purchases.awaitingPaymentProductIds, isNotEmpty);

    purchases.signedOut();
    await pumpEventQueue();
    store.emit(
      held(
        'tomeza.credit_pack_2',
        'after-sign-out',
        status: StorePurchaseStatus.purchased,
      ),
    );
    await pumpEventQueue();
    await purchases.resumed();

    expect(repository.verifications.map((call) => call.purchaseToken), [
      'pending-a',
    ]);
    expect(store.finished, isEmpty);
    expect(purchases.awaitingPaymentProductIds, isEmpty);
    expect(store.ownedQueries, 1);
  });

  testWidgets('the app watcher follows the session and the foreground', (
    tester,
  ) async {
    final auth = FakeAuthRepository(initialSession: fakeSession());
    // Built in the test's own zone, which is the one its pumps flush.
    purchases.dispose();
    purchases = PlayPurchaseProcessor(
      billingRepository: repository,
      storeClient: store,
      onBillingChanged: () {},
      clock: () => now,
    );
    store.owned = [held('tomeza.creator_monthly', 'orphan-plan')];
    late ProviderContainer container;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(auth),
          storeBillingClientProvider.overrideWithValue(store),
          billingRepositoryProvider.overrideWithValue(repository),
          playPurchaseProcessorProvider.overrideWithValue(purchases),
        ],
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: BillingPurchaseWatcher(
            child: Consumer(
              builder: (context, ref, _) {
                container = ProviderScope.containerOf(context);
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The restored session's pass found the orphaned plan.
    expect(repository.verifications.single.purchaseToken, 'orphan-plan');

    // No paywall is open, and a purchase still reaches the server.
    store.emit(
      held(
        'tomeza.credit_pack_1',
        'no-paywall',
        status: StorePurchaseStatus.purchased,
      ),
    );
    await tester.pumpAndSettle();
    expect(repository.verifications.last.purchaseToken, 'no-paywall');

    // Back from the background, a minute later: Play is asked again.
    now = now.add(PlayPurchaseProcessor.resumeInterval);
    store.owned = [held('tomeza.pro_monthly', 'cleared-while-away')];
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(store.ownedQueries, 2);
    expect(repository.verifications.last.purchaseToken, 'cleared-while-away');

    await container.read(authControllerProvider.notifier).logout();
    await tester.pumpAndSettle();
    final verified = repository.verifications.length;
    store.emit(
      held(
        'tomeza.credit_pack_2',
        'signed-out',
        status: StorePurchaseStatus.purchased,
      ),
    );
    await tester.pumpAndSettle();
    expect(repository.verifications, hasLength(verified));
  });
}

/// A repository whose next verification waits for [gate].
class _GatedRepository extends FakeBillingRepository {
  Completer<void>? gate;

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
    int? localPriceMicros,
    String? localCurrency,
  }) async {
    final result = super.verifyGooglePlayPurchase(
      productId: productId,
      purchaseToken: purchaseToken,
      transactionId: transactionId,
      purchaseStatus: purchaseStatus,
      projectId: projectId,
      localPriceMicros: localPriceMicros,
      localCurrency: localCurrency,
    );
    final waiting = gate;
    if (waiting != null) {
      gate = null;
      await waiting.future;
    }
    return result;
  }
}
