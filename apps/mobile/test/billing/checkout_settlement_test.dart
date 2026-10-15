import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/data/play_purchase_processor.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';
import 'package:tomeza/shared/api/api_error.dart';
import 'package:tomeza/shared/ui/design_system/app_buttons.dart';

import 'billing_paywall_harness.dart';

/// Every checkout a controller opens is settled by Play's answer, whatever
/// that answer names. in_app_purchase_android reports Back, and any error Play
/// returns without a purchase list, as one update with `productID: ''`
/// (`_getPurchaseDetailsFromResult`); the controller used to clear `''` and
/// leave the real product spinning "Purchase pending" until the app was killed.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeStoreBillingClient store;
  late FakeBillingRepository repository;
  late PlayPurchaseProcessor purchases;
  late BillingController controller;
  late List<BillingPurchaseEvent> events;
  var held = 0;

  setUp(() async {
    store = FakeStoreBillingClient();
    repository = FakeBillingRepository();
    purchases = PlayPurchaseProcessor(
      billingRepository: repository,
      storeClient: store,
      onBillingChanged: () {},
    );
    held = 0;
    controller = BillingController(
      billingRepository: repository,
      storeClient: store,
      purchases: purchases,
      onBillingChanged: () {},
      // Stands in for `ref.keepAlive()`: a link that is never closed keeps the
      // controller, and its spinner, alive for the rest of the session.
      keepAlive: () {
        held += 1;
        var closed = false;
        return () {
          if (closed) return;
          closed = true;
          held -= 1;
        };
      },
    );
    events = [];
    controller.purchaseEvents.listen(events.add);
    await pumpEventQueue();
  });

  tearDown(() {
    controller.dispose();
    purchases.dispose();
  });

  MobileBillingProduct product(String sku) =>
      controller.products.firstWhere((item) => item.sku == sku);

  /// Settled means: nothing pending, nothing held, the surface told, and the
  /// next checkout opens.
  Future<void> expectSettled(String sku) async {
    expect(controller.state.pendingProductIds, isEmpty);
    expect(held, 0);
    expect(
      events.whereType<BillingPurchaseStopped>().map((e) => e.productId),
      contains(sku),
    );
    final opened = store.buyCalls.length;
    await controller.buy(product('tomeza.credit_pack_2'));
    expect(store.buyCalls, hasLength(opened + 1));
  }

  test('Back on Play\'s sheet settles the checkout it closed', () async {
    await controller.buy(product('tomeza.credit_pack_1'));
    expect(controller.state.pendingProductIds, {'tomeza.credit_pack_1'});
    expect(held, 1);

    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.canceled,
        purchaseToken: '',
      ),
    );
    await pumpEventQueue();

    expect(controller.state.message, 'Purchase canceled.');
    expect(controller.state.error, isNull);
    await expectSettled('tomeza.credit_pack_1');
  });

  test('an error Play returns with no purchase settles the checkout', () async {
    await controller.buy(product('tomeza.credit_pack_1'));

    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.error,
        purchaseToken: '',
        errorMessage:
            'Google Play Billing is not available for this Google account or device.',
      ),
    );
    await pumpEventQueue();

    expect(controller.state.error, contains('not available'));
    await expectSettled('tomeza.credit_pack_1');
  });

  test('a checkout Play would not open is settled, and Play is asked what '
      'it holds', () async {
    store.buyError = const ApiException(
      code: 'GOOGLE_PLAY_CHECKOUT_UNAVAILABLE',
      message: 'Google Play checkout could not open. Try again.',
    );
    await controller.buy(product('tomeza.credit_pack_1'));
    await pumpEventQueue();

    expect(controller.state.error, contains('could not open'));
    // A launch Play refuses can be a pack it already holds, unconsumed.
    expect(store.ownedQueries, 1);
    await expectSettled('tomeza.credit_pack_1');
  });

  test('ITEM_ALREADY_OWNED finishes the stranded pack and then lets the '
      'next purchase through', () async {
    // Granted by the server (which acknowledged it) but never consumed: the
    // verify call that would have consumed it never came back.
    store.owned = [
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.restored,
        purchaseToken: 'stranded-token',
        purchaseId: 'stranded-order',
        purchaseAccountId: 'test-purchase-account',
      ),
    ];
    await controller.buy(product('tomeza.credit_pack_1'));

    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.error,
        purchaseToken: '',
        alreadyOwned: true,
        errorMessage: 'You already own this.',
      ),
    );
    await pumpEventQueue();

    expect(repository.verifications.single.purchaseToken, 'stranded-token');
    expect(repository.verifications.single.purchaseStatus, 'restored');
    expect(store.finished.single.consumable, isTrue);
    expect(store.owned, isEmpty);
    // The purchase it found answers the surface that started the checkout.
    expect(
      events.single,
      isA<BillingPurchaseSuccess>().having(
        (e) => e.productId,
        'productId',
        'tomeza.credit_pack_1',
      ),
    );
    expect(controller.state.restoring, isFalse);
    expect(controller.state.error, isNull);
    expect(controller.state.message, '1,000 credits added.');
    expect(controller.state.pendingProductIds, isEmpty);
    expect(held, 0);

    await controller.buy(product('tomeza.credit_pack_1'));
    expect(store.buyCalls, hasLength(2));
  });

  test(
    'ITEM_ALREADY_OWNED after a refused launch still reads as found',
    () async {
      // Play can report it twice: as the launch's result, then on the stream.
      store.owned = [
        const StorePurchaseUpdate(
          productId: 'tomeza.credit_pack_1',
          status: StorePurchaseStatus.restored,
          purchaseToken: 'stranded-token',
          purchaseAccountId: 'test-purchase-account',
        ),
      ];
      store.buyError = const ApiException(
        code: 'GOOGLE_PLAY_CHECKOUT_UNAVAILABLE',
        message: 'Google Play checkout could not open. Try again.',
      );
      await controller.buy(product('tomeza.credit_pack_1'));
      await pumpEventQueue();
      // The launch failure's own pass has already finished the stranded pack.
      expect(store.finished.single.purchaseToken, 'stranded-token');

      store.emit(
        const StorePurchaseUpdate(
          productId: '',
          status: StorePurchaseStatus.error,
          purchaseToken: '',
          alreadyOwned: true,
        ),
      );
      await pumpEventQueue();

      expect(controller.state.restoring, isFalse);
      expect(controller.state.message, '1,000 credits added.');
      expect(repository.verifications, hasLength(1));
    },
  );

  test(
    'ITEM_ALREADY_OWNED with nothing unfinished says so and stops',
    () async {
      await controller.buy(product('tomeza.credit_pack_1'));

      store.emit(
        const StorePurchaseUpdate(
          productId: '',
          status: StorePurchaseStatus.error,
          purchaseToken: '',
          alreadyOwned: true,
        ),
      );
      await pumpEventQueue();

      expect(store.ownedQueries, 1);
      expect(repository.verifications, isEmpty);
      expect(controller.state.restoring, isFalse);
      expect(controller.state.message, contains('already yours'));
      await expectSettled('tomeza.credit_pack_1');
    },
  );

  testWidgets('the paywall\'s checkout button comes back after Back', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    await tester.pumpWidget(
      testPaywall(store: store, repository: FakeBillingRepository()),
    );
    await tester.pumpAndSettle();
    await selectPaywallPack(tester);
    final buy = find.byKey(const ValueKey('paywall-checkout-buy'));
    await tester.tap(buy);
    await tester.pump();
    expect(tester.widget<AppButton>(buy).onPressed, isNull);

    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.canceled,
        purchaseToken: '',
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.widget<AppButton>(buy).onPressed, isNotNull);
    expect(find.text('Purchase canceled.'), findsOneWidget);
  });

  group('the Play client', () {
    setUp(() => debugDefaultTargetPlatformOverride = TargetPlatform.android);
    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test(
      'reads ITEM_ALREADY_OWNED off the plugin\'s productless error',
      () async {
        // Exactly what `_getPurchaseDetailsFromResult` builds for a failed flow.
        final failure =
            PurchaseDetails(
                purchaseID: '',
                productID: '',
                status: PurchaseStatus.error,
                transactionDate: null,
                verificationData: PurchaseVerificationData(
                  localVerificationData: '',
                  serverVerificationData: '',
                  source: 'google_play',
                ),
              )
              ..error = IAPError(
                source: 'google_play',
                code: 'purchase_error',
                message: BillingResponse.itemAlreadyOwned.toString(),
                details: 'Item is already owned.',
              );
        final client = InAppPurchaseStoreBillingClient(
          inAppPurchase: _Play(updates: Stream.value([failure])),
        );

        final update = (await client.purchaseUpdates.first).single;

        expect(update.productId, isEmpty);
        expect(update.status, StorePurchaseStatus.error);
        expect(update.alreadyOwned, isTrue);
        // Not "BillingResponse.itemAlreadyOwned".
        expect(update.errorMessage, 'You already own this.');
      },
    );

    test('a restored payment that is still pending stays pending', () async {
      final pending = _purchase(
        'tomeza.credit_pack_1',
        'slow-card',
        state: PurchaseStateWrapper.pending,
      )..status = PurchaseStatus.restored;
      final client = InAppPurchaseStoreBillingClient(
        inAppPurchase: _Play(updates: Stream.value([pending])),
      );

      final update = (await client.purchaseUpdates.first).single;

      expect(update.status, StorePurchaseStatus.pending);
    });

    test('owned purchases come back restored, pending ones pending', () async {
      final play = _Play()
        ..addition.response = QueryPurchaseDetailsResponse(
          pastPurchases: [
            _purchase('tomeza.creator_monthly', 'plan', acknowledged: false),
            _purchase(
              'tomeza.credit_pack_1',
              'slow-card',
              state: PurchaseStateWrapper.pending,
            ),
          ],
        );
      final client = InAppPurchaseStoreBillingClient(inAppPurchase: play);

      final owned = await client.queryOwnedPurchases();

      expect(owned.map((p) => p.status), [
        StorePurchaseStatus.restored,
        StorePurchaseStatus.pending,
      ]);
      expect(owned.first.pendingCompletePurchase, isTrue);
      expect(owned.first.purchaseAccountId, 'test-purchase-account');
    });

    test('a failed owned-purchase query throws rather than answer half', () {
      final play = _Play()
        ..addition.response = QueryPurchaseDetailsResponse(
          pastPurchases: [_purchase('tomeza.creator_monthly', 'plan')],
          error: IAPError(
            source: 'google_play',
            code: 'restore_purchase_error',
            message: 'BillingResponse.serviceUnavailable',
          ),
        );
      final client = InAppPurchaseStoreBillingClient(inAppPurchase: play);

      expect(client.queryOwnedPurchases(), throwsA(isA<ApiException>()));
    });
  });
}

GooglePlayPurchaseDetails _purchase(
  String sku,
  String token, {
  bool acknowledged = true,
  PurchaseStateWrapper state = PurchaseStateWrapper.purchased,
}) {
  return GooglePlayPurchaseDetails.fromPurchase(
    PurchaseWrapper(
      orderId: 'order-$token',
      packageName: 'com.tomeza.tomeza',
      purchaseTime: 1,
      purchaseToken: token,
      obfuscatedAccountId: 'test-purchase-account',
      signature: '',
      products: [sku],
      isAutoRenewing: true,
      originalJson: '{}',
      isAcknowledged: acknowledged,
      purchaseState: state,
    ),
  ).single;
}

class _Play implements InAppPurchase {
  _Play({this.updates = const Stream.empty()});

  final Stream<List<PurchaseDetails>> updates;
  final addition = _PlayAddition();

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => updates;

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getPlatformAddition) return addition;
    return super.noSuchMethod(invocation);
  }
}

class _PlayAddition implements InAppPurchaseAndroidPlatformAddition {
  QueryPurchaseDetailsResponse response = QueryPurchaseDetailsResponse(
    pastPurchases: [],
  );

  @override
  Future<QueryPurchaseDetailsResponse> queryPastPurchases({
    String? applicationUserName,
  }) async => response;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
