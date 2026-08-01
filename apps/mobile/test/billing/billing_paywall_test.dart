import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';

void main() {
  testWidgets('paywall queries products and verifies a completed purchase', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();

    await tester.pumpWidget(testPaywall(store: store, repository: repository));
    await tester.pumpAndSettle();

    expect(find.text('Creator monthly'), findsOneWidget);
    expect(find.text('100'), findsOneWidget);
    expect(find.text('credits available'), findsOneWidget);

    // Plans lead the sheet, so the one-off purchases are a scroll away.
    await tester.scrollUntilVisible(
      find.text('Restore purchases'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('One book export'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, r'$9.99'));
    await tester.pump();

    expect(store.buyCalls.single.product.id, 'tomeza.one_book_export');
    expect(store.buyCalls.single.consumable, isTrue);

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.one_book_export',
        status: StorePurchaseStatus.pending,
        purchaseToken: 'pending-token',
      ),
    );
    await tester.pump();

    await tester.scrollUntilVisible(
      find.textContaining('Payment is pending'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.textContaining('Payment is pending'), findsOneWidget);

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.one_book_export',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'purchase-token-1',
        purchaseId: 'order-1',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.text('1,100'),
      -200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(repository.verifications.single.productId, 'tomeza.one_book_export');
    expect(repository.verifications.single.purchaseToken, 'purchase-token-1');
    expect(store.finished.single.purchaseToken, 'purchase-token-1');
    expect(find.text('1,100'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('1000 credits added.'),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('1000 credits added.'), findsOneWidget);
  });

  testWidgets('paywall handles restore, failed, and canceled purchase states', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();

    await tester.pumpWidget(testPaywall(store: store, repository: repository));
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(
      tester.element(find.byType(BillingPaywall)),
    );
    final billingController = container.read(
      billingControllerProvider('project-1'),
    );
    await billingController.restore();
    await tester.pump();

    expect(store.restoreCalls, 1);
    expect(billingController.state.message, contains('Restore started'));

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.creator_monthly',
        status: StorePurchaseStatus.restored,
        purchaseToken: 'subscription-token',
        purchaseId: 'sub-order-1',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(repository.verifications.single.purchaseStatus, 'restored');
    expect(store.finished.single.consumable, isFalse);
    expect(billingController.state.message, contains('Subscription verified'));

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.error,
        purchaseToken: '',
        errorMessage: 'Card declined',
      ),
    );
    await tester.pump();

    expect(billingController.state.error, 'Card declined');

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.canceled,
        purchaseToken: '',
      ),
    );
    await tester.pump();

    expect(billingController.state.message, 'Purchase canceled.');
  });

  test('local app config uses the debug billing store client', () {
    final container = ProviderContainer(
      overrides: [appConfigProvider.overrideWithValue(testConfig)],
    );
    addTearDown(container.dispose);

    expect(
      container.read(storeBillingClientProvider),
      isA<DebugStoreBillingClient>(),
    );
  });

  test(
    'debug store client emits unique completed purchases repeatedly',
    () async {
      final store = DebugStoreBillingClient();
      addTearDown(store.dispose);
      final updates = <StorePurchaseUpdate>[];
      final subscription = store.purchaseUpdates.listen(updates.addAll);
      addTearDown(subscription.cancel);

      final query = await store.queryProducts({'tomeza.credit_pack_1'});
      expect(await store.isAvailable(), isTrue);
      expect(query.products.single.price, 'Debug');

      await store.buyProduct(query.products.single, consumable: true);
      await store.buyProduct(query.products.single, consumable: true);
      await pumpEventQueue();

      expect(updates, hasLength(2));
      expect(
        updates.map((update) => update.status),
        everyElement(StorePurchaseStatus.purchased),
      );
      expect(
        updates.map((update) => update.purchaseToken).toSet(),
        hasLength(2),
      );
    },
  );
}

Widget testPaywall({
  required FakeStoreBillingClient store,
  required FakeBillingRepository repository,
}) {
  return ProviderScope(
    overrides: [
      storeBillingClientProvider.overrideWithValue(store),
      billingRepositoryProvider.overrideWithValue(repository),
    ],
    child: const MaterialApp(
      home: Scaffold(body: BillingPaywall(projectId: 'project-1')),
    ),
  );
}

class FakeBillingRepository implements BillingRepository {
  MobileBilling billing = fakeBilling(availableCredits: 100);
  final verifications = <VerificationCall>[];

  @override
  Future<MobileBilling> getBilling() async => billing;

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
  }) async {
    verifications.add(
      VerificationCall(
        productId: productId,
        purchaseToken: purchaseToken,
        transactionId: transactionId,
        purchaseStatus: purchaseStatus,
        projectId: projectId,
      ),
    );
    final isSubscription = productId == 'tomeza.creator_monthly';
    final granted = isSubscription ? 3000 : 1000;
    billing = fakeBilling(
      availableCredits: billing.credits.available + granted,
    );
    return GooglePlayVerificationResult(
      purchase: VerifiedPurchase(
        id: 'purchase-${verifications.length}',
        status: 'granted',
        creditsGranted: granted,
        subscriptionStatus: isSubscription ? 'active' : null,
        entitlementType: isSubscription ? 'CREATOR_PLAN' : null,
      ),
      billing: billing,
    );
  }
}

class FakeStoreBillingClient implements StoreBillingClient {
  final _controller = StreamController<List<StorePurchaseUpdate>>.broadcast();
  final buyCalls = <BuyCall>[];
  final finished = <FinishCall>[];
  var restoreCalls = 0;

  @override
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates => _controller.stream;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    return StoreProductQueryResult(
      products: [
        for (final id in productIds)
          StoreProduct(
            id: id,
            title: id,
            description: id,
            price: switch (id) {
              'tomeza.one_book_export' => r'$9.99',
              'tomeza.creator_monthly' => r'$19.99',
              _ => r'$7.99',
            },
            rawPrice: 9.99,
            currencyCode: 'USD',
          ),
      ],
      notFoundIds: const [],
    );
  }

  @override
  Future<void> buyProduct(
    StoreProduct product, {
    required bool consumable,
  }) async {
    buyCalls.add(BuyCall(product: product, consumable: consumable));
  }

  @override
  Future<void> restorePurchases() async {
    restoreCalls += 1;
  }

  @override
  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    required bool consumable,
  }) async {
    finished.add(
      FinishCall(purchaseToken: purchase.purchaseToken, consumable: consumable),
    );
  }

  void emit(StorePurchaseUpdate purchase) {
    _controller.add([purchase]);
  }
}

class BuyCall {
  const BuyCall({required this.product, required this.consumable});

  final StoreProduct product;
  final bool consumable;
}

class FinishCall {
  const FinishCall({required this.purchaseToken, required this.consumable});

  final String purchaseToken;
  final bool consumable;
}

class VerificationCall {
  const VerificationCall({
    required this.productId,
    required this.purchaseToken,
    this.transactionId,
    this.purchaseStatus,
    this.projectId,
  });

  final String productId;
  final String purchaseToken;
  final String? transactionId;
  final String? purchaseStatus;
  final String? projectId;
}

MobileBilling fakeBilling({required int availableCredits}) {
  return MobileBilling(
    credits: CreditBalance(
      available: availableCredits,
      reserved: 0,
      lifetimeGranted: availableCredits,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [
      MobileBillingProduct(
        sku: 'tomeza.one_book_export',
        title: 'One book export',
        description: 'One standard export credit.',
        productType: 'ONE_TIME_UNLOCK',
        creditAmount: 1000,
        priceMicros: 9990000,
        currency: 'USD',
      ),
      MobileBillingProduct(
        sku: 'tomeza.creator_monthly',
        title: 'Creator monthly',
        description: 'Three standard export credits monthly.',
        productType: 'SUBSCRIPTION',
        creditAmount: 3000,
        priceMicros: 19990000,
        currency: 'USD',
      ),
      MobileBillingProduct(
        sku: 'tomeza.credit_pack_1',
        title: 'One extra credit',
        description: 'One extra standard export credit.',
        productType: 'CREDIT_PACK',
        creditAmount: 1000,
        priceMicros: 7990000,
        currency: 'USD',
      ),
    ],
    creditCosts: const {
      'fullBookBase': 350,
      'fullBookPerPage': 8,
      'imageGeneration': 45,
      'premiumReview': 200,
      'exportUnlock': 150,
    },
  );
}

final testConfig = AppConfig(
  environment: AppEnvironment.local,
  apiBaseUrl: Uri.parse('http://10.0.2.2:4001'),
  privacyPolicyUrl: Uri.parse('https://example.com/tomeza/privacy'),
  termsOfServiceUrl: Uri.parse('https://example.com/tomeza/terms'),
  accountDeletionUrl: Uri.parse('https://example.com/tomeza/account-deletion'),
  supportEmail: 'support@example.com',
);
