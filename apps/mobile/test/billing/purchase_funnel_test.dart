import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/paywall_view_reporter.dart';
import 'package:tomeza/features/billing/data/play_purchase_processor.dart';
import 'package:tomeza/features/billing/data/purchase_funnel_reporter.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'billing_paywall_harness.dart';

class RecordingFunnel implements PurchaseFunnelReporter {
  final events = <String>[];

  @override
  void purchaseStarted({
    required String sku,
    required bool intro,
    PaywallTrigger? surface,
  }) => events.add(
    'started $sku${intro ? ' intro' : ''}${surface == null ? '' : ' from ${surface.wire}'}',
  );

  @override
  void purchaseCancelled(String sku) => events.add('cancelled $sku');

  @override
  void purchaseFailed(String sku, PurchaseFailureReason reason) =>
      events.add('failed $sku ${reason.wire}');
}

/// Prices the creator plan through its intro offer, as Play lists one for an
/// account that has never subscribed.
class _IntroStore extends FakeStoreBillingClient {
  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    final result = await super.queryProducts(productIds);
    return StoreProductQueryResult(
      products: [
        for (final product in result.products)
          product.id == 'tomeza.creator_monthly'
              ? StoreProduct(
                  id: product.id,
                  title: product.title,
                  description: product.description,
                  price: product.price,
                  rawPrice: product.rawPrice,
                  currencyCode: product.currencyCode,
                  offers: const [
                    StoreIntroOffer(
                      offerId: 'intro-1',
                      price: r'$9.99',
                      billingPeriod: 'P1M',
                      cycles: 1,
                    ),
                  ],
                )
              : product,
      ],
      notFoundIds: result.notFoundIds,
    );
  }
}

/// Play answers, but gives no price for anything.
class _UnpricedStore extends FakeStoreBillingClient {
  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    return StoreProductQueryResult(
      products: const [],
      notFoundIds: productIds.toList(),
    );
  }
}

/// The server refuses every purchase as another account's.
class _RefusingRepository extends FakeBillingRepository {
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
    throw const ApiException(
      code: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
      message: 'Sign in to the Tomeza account that started this purchase.',
    );
  }
}

/// What the growth funnel hears about a checkout: told once per Play answer by
/// the processor however many purchase surfaces are open, and never changing
/// what the purchase does.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late RecordingFunnel funnel;
  late FakeStoreBillingClient store;
  late FakeBillingRepository repository;
  late PlayPurchaseProcessor purchases;
  PlayPurchaseProcessor? opened;
  final controllers = <BillingController>[];

  Future<BillingController> open({String? projectId}) async {
    final controller = BillingController(
      billingRepository: repository,
      storeClient: store,
      purchases: purchases,
      onBillingChanged: () {},
      keepAlive: () => () {},
      projectId: projectId,
      funnel: funnel,
    );
    controllers.add(controller);
    await pumpEventQueue();
    return controller;
  }

  void setUpWith({
    FakeStoreBillingClient? storeClient,
    FakeBillingRepository? billingRepository,
  }) {
    funnel = RecordingFunnel();
    store = storeClient ?? FakeStoreBillingClient();
    repository = billingRepository ?? FakeBillingRepository();
    purchases = PlayPurchaseProcessor(
      billingRepository: repository,
      storeClient: store,
      onBillingChanged: () {},
      funnel: funnel,
    );
    opened = purchases;
  }

  tearDown(() {
    for (final controller in controllers) {
      controller.dispose();
    }
    controllers.clear();
    opened?.dispose();
    opened = null;
  });

  MobileBillingProduct product(BillingController controller, String sku) =>
      controller.products.firstWhere((item) => item.sku == sku);

  test('Back on Play\'s sheet is one cancel, however many surfaces are '
      'open', () async {
    setUpWith();
    final paywall = await open(projectId: 'book-1');
    await open();

    await paywall.buy(
      product(paywall, 'tomeza.credit_pack_1'),
      surface: PaywallTrigger.creditsNeeded,
    );
    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.canceled,
        purchaseToken: '',
      ),
    );
    await pumpEventQueue();

    expect(funnel.events, [
      'started tomeza.credit_pack_1 from credits_needed',
      'cancelled tomeza.credit_pack_1',
    ]);
    expect(paywall.state.message, 'Purchase canceled.');
  });

  test('a completed purchase is a start and nothing else', () async {
    setUpWith();
    final controller = await open();

    await controller.buy(product(controller, 'tomeza.credit_pack_1'));
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'token-1',
        purchaseId: 'order-1',
        purchaseAccountId: 'test-purchase-account',
      ),
    );
    await pumpEventQueue();

    expect(funnel.events, ['started tomeza.credit_pack_1']);
    expect(repository.verifications, hasLength(1));
  });

  test('an intro checkout says so', () async {
    setUpWith(storeClient: _IntroStore());
    repository.billing = fakeBilling(
      availableCredits: 100,
      creatorIntroOfferId: 'intro-1',
    );
    final controller = await open();

    await controller.buy(product(controller, 'tomeza.creator_monthly'));

    expect(funnel.events, ['started tomeza.creator_monthly intro']);
  });

  test('each way a checkout fails is reported as its class', () async {
    setUpWith();
    final controller = await open();

    await controller.buy(product(controller, 'tomeza.credit_pack_1'));
    store.emit(
      const StorePurchaseUpdate(
        productId: '',
        status: StorePurchaseStatus.error,
        purchaseToken: '',
        errorMessage: 'Google Play Billing is not available.',
      ),
    );
    await pumpEventQueue();

    store.buyError = const ApiException(
      code: 'GOOGLE_PLAY_CHECKOUT_UNAVAILABLE',
      message: 'Google Play checkout could not open. Try again.',
    );
    await controller.buy(product(controller, 'tomeza.credit_pack_1'));
    await pumpEventQueue();

    await controller.buy(product(controller, 'tomeza.credit_pack_1'));
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

    expect(funnel.events, [
      'started tomeza.credit_pack_1',
      'failed tomeza.credit_pack_1 play_error',
      'started tomeza.credit_pack_1',
      'failed tomeza.credit_pack_1 launch_failed',
      'started tomeza.credit_pack_1',
      'failed tomeza.credit_pack_1 already_owned',
    ]);
  });

  test('a product Play gave no price for fails before any sheet', () async {
    setUpWith(storeClient: _UnpricedStore());
    final controller = await open();

    await controller.buy(product(controller, 'tomeza.credit_pack_1'));

    expect(funnel.events, [
      'started tomeza.credit_pack_1',
      'failed tomeza.credit_pack_1 store_unavailable',
    ]);
    expect(store.buyCalls, isEmpty);
  });

  test('a purchase the server refuses is a failure; a restore it refuses '
      'is not a checkout', () async {
    setUpWith(billingRepository: _RefusingRepository());
    final controller = await open();

    await controller.buy(product(controller, 'tomeza.credit_pack_1'));
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'token-1',
        purchaseAccountId: 'test-purchase-account',
      ),
    );
    await pumpEventQueue();
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_2',
        status: StorePurchaseStatus.restored,
        purchaseToken: 'token-2',
        purchaseAccountId: 'test-purchase-account',
      ),
    );
    await pumpEventQueue();

    expect(funnel.events, [
      'started tomeza.credit_pack_1',
      'failed tomeza.credit_pack_1 refused',
    ]);
  });

  test('the last paywall shown names the surface, for half an hour', () {
    var now = DateTime.utc(2026, 10, 13, 12);
    final memory = PaywallTriggerMemory(clock: () => now);
    expect(memory.recent, isNull);

    memory.remember(PaywallTrigger.export);
    now = now.add(const Duration(minutes: 29));
    expect(memory.recent, PaywallTrigger.export);

    now = now.add(const Duration(minutes: 2));
    expect(memory.recent, isNull);
  });

  test('every failure class is one the server accepts', () {
    expect(PurchaseFailureReason.values.map((reason) => reason.wire), [
      'store_unavailable',
      'account_unavailable',
      'launch_failed',
      'play_error',
      'already_owned',
      'no_token',
      'refused',
      'other',
    ]);
  });
}
