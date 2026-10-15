import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/data/play_purchase_processor.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';

import 'billing_paywall_harness.dart';

const creator = MobileBillingProduct(
  sku: 'tomeza.creator_monthly',
  title: 'Creator',
  description: '',
  productType: 'SUBSCRIPTION',
  creditAmount: 6000,
  priceMicros: 9990000,
  currency: 'USD',
);
const max = MobileBillingProduct(
  sku: 'tomeza.max_monthly',
  title: 'Max',
  description: '',
  productType: 'SUBSCRIPTION',
  creditAmount: 80000,
  priceMicros: 99990000,
  currency: 'USD',
);
const pack = MobileBillingProduct(
  sku: 'tomeza.credit_pack_1',
  title: 'Credits',
  description: '',
  productType: 'CREDIT_PACK',
  creditAmount: 1000,
  priceMicros: 9990000,
  currency: 'USD',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakePlay play;
  late PlayPurchaseProcessor purchases;
  late BillingController controller;
  late FakeBillingRepository repository;

  Future<void> openCheckout({
    String? tier = 'creator',
    String? accountToken = 'old',
    String? purchaseAccountId = 'test-purchase-account',
  }) async {
    repository = FakeBillingRepository(planTier: tier);
    final billing = repository.billing;
    repository.billing = MobileBilling(
      purchaseAccountId: purchaseAccountId,
      credits: billing.credits,
      entitlements: billing.entitlements,
      plan: tier == null
          ? null
          : MobileSubscriptionPlan.fromJson({
              'tier': tier,
              'source': 'google_play',
              'productSku': 'tomeza.${tier}_monthly',
              'purchaseTokenHash': accountToken == null
                  ? null
                  : sha256.convert(utf8.encode(accountToken)).toString(),
            }),
      products: const [creator, max, pack],
      creditCosts: billing.creditCosts,
    );
    final store = InAppPurchaseStoreBillingClient(inAppPurchase: play);
    purchases = PlayPurchaseProcessor(
      billingRepository: repository,
      storeClient: store,
      onBillingChanged: () {},
    );
    controller = BillingController(
      billingRepository: repository,
      storeClient: store,
      purchases: purchases,
      onBillingChanged: () {},
      keepAlive: () => () {},
    );
    await pumpEventQueue();
  }

  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    play = FakePlay();
  });
  tearDown(() {
    controller.dispose();
    purchases.dispose();
    debugDefaultTargetPlatformOverride = null;
  });

  test('checkout cannot open without a server account identity', () async {
    await openCheckout(purchaseAccountId: null);
    await controller.buy(pack);
    expect(play.launched, isEmpty);
    expect(controller.state.pendingProductIds, isEmpty);
    expect(controller.state.error, contains('temporarily unavailable'));
  });

  test(
    'restored Play callbacks retain the original checkout account',
    () async {
      await openCheckout();
      play.updates = Stream.value([
        purchase(pack.sku, 'restored-token', accountId: 'original-account'),
      ]);
      final client = InAppPurchaseStoreBillingClient(inAppPurchase: play);
      final update = (await client.purchaseUpdates.first).single;
      expect(update.purchaseAccountId, 'original-account');
      expect(update.purchaseToken, 'restored-token');
    },
  );

  test(
    'Creator to Max replaces the owned purchase instead of buying twice',
    () async {
      final owned = purchase(creator.sku, 'creator-token');
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [owned],
      );
      await openCheckout(accountToken: 'creator-token');
      await controller.buy(max);
      expect(play.launched.single, isA<GooglePlayPurchaseParam>());
      expect(play.launched.single.applicationUserName, 'test-purchase-account');
      final change = (play.launched.single as GooglePlayPurchaseParam)
          .changeSubscriptionParam!;
      expect(change.oldPurchaseDetails, same(owned));
      expect(change.replacementMode, ReplacementMode.chargeFullPrice);
    },
  );

  test(
    'a downgrade waits for the renewal date instead of forfeiting the paid month',
    () async {
      final owned = purchase(max.sku, 'max-token', renewing: false);
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [owned],
      );
      await openCheckout(tier: 'max', accountToken: 'max-token');
      await controller.buy(creator);
      final change = (play.launched.single as GooglePlayPurchaseParam)
          .changeSubscriptionParam!;
      expect(change.oldPurchaseDetails, same(owned));
      // Charged in full, Max's remaining allowance was thrown away on day 3.
      expect(change.replacementMode, ReplacementMode.deferred);
    },
  );

  test(
    'Play\'s productless answer to a deferred downgrade settles the checkout and records the new token',
    () async {
      final updates = StreamController<List<PurchaseDetails>>.broadcast();
      addTearDown(updates.close);
      play.updates = updates.stream;
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(max.sku, 'max-token')],
      );
      await openCheckout(tier: 'max', accountToken: 'max-token');
      await controller.buy(creator);
      expect(controller.state.pendingProductIds, {creator.sku});

      // Play says the change went through and returns no purchase; the token
      // it issued is held, unacknowledged, under the plan it replaces.
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(max.sku, 'switch-token', acknowledged: false)],
      );
      updates.add([
        PurchaseDetails(
          purchaseID: '',
          productID: '',
          status: PurchaseStatus.purchased,
          transactionDate: null,
          verificationData: PurchaseVerificationData(
            localVerificationData: '',
            serverVerificationData: '',
            source: 'google_play',
          ),
        ),
      ]);
      await pumpEventQueue();

      // Recorded (and so acknowledged) now, or Play refunds it in three days.
      expect(repository.verifications.single.purchaseToken, 'switch-token');
      expect(controller.state.pendingProductIds, isEmpty);
      // Nothing failed: no "did not return a purchase token" error.
      expect(controller.state.error, isNull);
      // Nothing was bought today either: the reader is told when it starts.
      expect(
        controller.state.message,
        startsWith('Your plan switches to Creator'),
      );
      expect(controller.state.message, isNot(contains('verified')));
    },
  );

  test(
    'a pack bought here is verified with the price Play quoted the buyer',
    () async {
      final updates = StreamController<List<PurchaseDetails>>.broadcast();
      addTearDown(updates.close);
      play.updates = updates.stream;
      await openCheckout();
      await controller.buy(pack);
      updates.add([purchase(pack.sku, 'pack-token', acknowledged: false)]);
      await pumpEventQueue();

      final sent = repository.verifications.single;
      expect(sent.localPriceMicros, 749000000);
      expect(sent.localCurrency, 'INR');
    },
  );

  test(
    'first-time subscription has no replacement and ignores owned credit packs',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(pack.sku, 'pack-token')],
      );
      await openCheckout(tier: null);
      await controller.buy(creator);
      expect(play.launched.single.applicationUserName, 'test-purchase-account');
      expect(
        (play.launched.single as GooglePlayPurchaseParam)
            .changeSubscriptionParam,
        isNull,
      );
    },
  );

  test(
    'credit packs never replace a subscription or query owned plans',
    () async {
      await openCheckout();
      await controller.buy(pack);
      expect(play.launched.single.applicationUserName, 'test-purchase-account');
      expect(play.consumable, isTrue);
      expect(play.autoConsume, isFalse);
      expect(play.addition.queries, 0);
    },
  );

  test(
    'missing purchase blocks an upgrade and releases the pending checkout',
    () async {
      await openCheckout();
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.error, contains('not found'));
      expect(controller.state.pendingProductIds, isEmpty);
      expect(controller.state.message, isNull);
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(creator.sku, 'old')],
      );
      await controller.buy(max);
      expect(play.launched, hasLength(1));
    },
  );

  test(
    'failed Play query cannot fall through to a second subscription',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [],
        error: IAPError(
          source: 'google_play',
          code: 'disconnected',
          message: 'Offline',
        ),
      );
      await openCheckout();
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.error, contains('could not be checked'));
      expect(controller.state.pendingProductIds, isEmpty);
    },
  );

  test(
    'multiple owned plans require management instead of choosing an arbitrary token',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(creator.sku, 'old'), purchase(max.sku, 'new')],
      );
      await openCheckout();
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.error, contains('More than one plan'));
    },
  );

  test(
    'a stale free account must restore its owned plan before buying',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(creator.sku, 'old')],
      );
      await openCheckout(tier: null);
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.error, contains('Restore purchases'));
      // Nothing is being switched: this account has no plan on record, most
      // often because the purchase it just made was never verified.
      expect(controller.state.error, isNot(contains('before switching')));
      expect(controller.state.error, contains('isn’t on your account yet'));
    },
  );

  test(
    'a plan on record that Play holds under another product still says sync before switching',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(max.sku, 'old')],
      );
      await openCheckout(tier: 'creator');
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.error, contains('before switching'));
    },
  );

  test('a pending plan cannot launch another checkout', () async {
    final pending = purchase(creator.sku, 'pending')
      ..status = PurchaseStatus.pending;
    play.addition.response = QueryPurchaseDetailsResponse(
      pastPurchases: [pending],
    );
    await openCheckout();
    await controller.buy(max);
    expect(play.launched, isEmpty);
    expect(controller.state.error, contains('still pending'));
  });

  test('already-owned target plan cannot be bought again', () async {
    play.addition.response = QueryPurchaseDetailsResponse(
      pastPurchases: [purchase(creator.sku, 'old')],
    );
    await openCheckout();
    await controller.buy(creator);
    expect(play.launched, isEmpty);
    expect(controller.state.error, contains('already own'));
  });

  test(
    'a rejected checkout launch clears the hold so the switch can be retried',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(creator.sku, 'old')],
      );
      play.opensCheckout = false;
      await openCheckout();
      await controller.buy(max);
      expect(controller.state.pendingProductIds, isEmpty);
      expect(controller.state.error, contains('could not open'));
    },
  );

  test(
    'same tier on a different Play account cannot replace someone else\'s subscription',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(creator.sku, 'different-token')],
      );
      await openCheckout();
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.error, contains('does not match'));
    },
  );

  test(
    'an older backend without purchase identity cannot start an unsafe switch',
    () async {
      play.addition.response = QueryPurchaseDetailsResponse(
        pastPurchases: [purchase(creator.sku, 'old')],
      );
      await openCheckout(accountToken: null);
      await controller.buy(max);
      expect(play.launched, isEmpty);
      expect(controller.state.pendingProductIds, isEmpty);
    },
  );
}

GooglePlayPurchaseDetails purchase(
  String sku,
  String token, {
  bool renewing = true,
  bool acknowledged = true,
  String? accountId,
}) {
  return GooglePlayPurchaseDetails.fromPurchase(
    PurchaseWrapper(
      orderId: 'order-$token',
      packageName: 'com.tomeza.tomeza',
      purchaseTime: 1,
      purchaseToken: token,
      obfuscatedAccountId: accountId,
      signature: '',
      products: [sku],
      isAutoRenewing: renewing,
      originalJson: '{}',
      isAcknowledged: acknowledged,
      purchaseState: PurchaseStateWrapper.purchased,
    ),
  ).single;
}

class FakePlay implements InAppPurchase {
  final addition = FakePlayAddition();
  final launched = <PurchaseParam>[];
  bool opensCheckout = true;
  bool consumable = false;
  bool? autoConsume;
  Stream<List<PurchaseDetails>> updates = const Stream.empty();
  @override
  Stream<List<PurchaseDetails>> get purchaseStream => updates;
  @override
  Future<bool> isAvailable() async => true;
  @override
  Future<ProductDetailsResponse> queryProductDetails(
    Set<String> identifiers,
  ) async => ProductDetailsResponse(
    productDetails: [
      for (final id in identifiers)
        // A pack as Play lists it, in the buyer's currency.
        if (id == 'tomeza.credit_pack_1')
          ...GooglePlayProductDetails.fromProductDetails(
            ProductDetailsWrapper(
              description: id,
              name: id,
              productId: id,
              productType: ProductType.inapp,
              title: id,
              oneTimePurchaseOfferDetails:
                  const OneTimePurchaseOfferDetailsWrapper(
                    formattedPrice: '₹749',
                    priceAmountMicros: 749000000,
                    priceCurrencyCode: 'INR',
                  ),
            ),
          )
        else
          ProductDetails(
            id: id,
            title: id,
            description: '',
            price: '\$10',
            rawPrice: 10,
            currencyCode: 'USD',
          ),
    ],
    notFoundIDs: [],
  );
  @override
  Future<bool> buyNonConsumable({required PurchaseParam purchaseParam}) async {
    launched.add(purchaseParam);
    return opensCheckout;
  }

  @override
  Future<bool> buyConsumable({
    required PurchaseParam purchaseParam,
    bool autoConsume = true,
  }) async {
    consumable = true;
    this.autoConsume = autoConsume;
    launched.add(purchaseParam);
    return opensCheckout;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getPlatformAddition) return addition;
    return super.noSuchMethod(invocation);
  }
}

class FakePlayAddition implements InAppPurchaseAndroidPlatformAddition {
  int queries = 0;
  QueryPurchaseDetailsResponse response = QueryPurchaseDetailsResponse(
    pastPurchases: [],
  );
  @override
  Future<QueryPurchaseDetailsResponse> queryPastPurchases({
    String? applicationUserName,
  }) async {
    queries++;
    return response;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
