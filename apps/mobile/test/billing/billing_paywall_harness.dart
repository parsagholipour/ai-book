/// Shared fixtures for the billing paywall and buy-credits-sheet suites:
/// the fake store/repository pair, the widget scaffolds, and the app config.
/// Split out of billing_paywall_test.dart when it outgrew the file budget.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';

Widget testPaywall({
  required FakeStoreBillingClient store,
  required FakeBillingRepository repository,
  PaywallCreditsNeeded? creditsNeeded,
}) {
  return ProviderScope(
    overrides: [
      storeBillingClientProvider.overrideWithValue(store),
      billingRepositoryProvider.overrideWithValue(repository),
      creditLogRepositoryProvider.overrideWithValue(
        EmptyCreditLogRepository(),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: BillingPaywall(
          projectId: 'project-1',
          creditsNeeded: creditsNeeded,
        ),
      ),
    ),
  );
}

Widget testPaywallLauncher({
  required FakeStoreBillingClient store,
  required FakeBillingRepository repository,
  PaywallCreditsNeeded? creditsNeeded,
}) {
  return ProviderScope(
    overrides: [
      storeBillingClientProvider.overrideWithValue(store),
      billingRepositoryProvider.overrideWithValue(repository),
      creditLogRepositoryProvider.overrideWithValue(EmptyCreditLogRepository()),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: FilledButton(
              key: const ValueKey('open-billing-paywall'),
              onPressed: () => showBillingPaywall(
                context,
                projectId: 'project-1',
                title: creditsNeeded == null ? null : 'Credits needed',
                creditsNeeded: creditsNeeded,
              ),
              child: const Text('Open billing'),
            ),
          ),
        ),
      ),
    ),
  );
}

/// The amount the buy sheet opened on, read off the field itself.
TextField amountField(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const ValueKey('buy-credits-amount')));

/// Scrolled *to* a section means on screen. A lazy list will happily mount a
/// row a few hundred pixels below the fold, so finding it is not the assertion.
void expectInViewport(WidgetTester tester, Finder finder) {
  final target = tester.getRect(finder);
  final viewport = tester.getRect(find.byType(ListView));
  expect(target.top, greaterThanOrEqualTo(viewport.top - 1));
  expect(target.bottom, lessThanOrEqualTo(viewport.bottom + 1));
}

class FakeBillingRepository implements BillingRepository {
  FakeBillingRepository({this.planTier}) {
    billing = fakeBilling(availableCredits: 100, planTier: planTier);
  }

  /// The tier this account is already on, which is what "upgrade" is measured
  /// against. Null is the free tier.
  final String? planTier;

  late MobileBilling billing;
  final verifications = <VerificationCall>[];
  var refreshCalls = 0;
  var cancelCalls = 0;
  Object? cancelError;
  bool nextPurchaseIsPending = false;

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
    final granted = nextPurchaseIsPending
        ? 0
        : isSubscription
        ? 3000
        : 1000;
    if (!nextPurchaseIsPending) {
      billing = fakeBilling(
        availableCredits: billing.credits.available + granted,
        planTier: planTier,
      );
    }
    return GooglePlayVerificationResult(
      purchase: VerifiedPurchase(
        id: 'purchase-${verifications.length}',
        status: nextPurchaseIsPending ? 'pending' : 'granted',
        creditsGranted: granted,
        subscriptionStatus: isSubscription ? 'active' : null,
        entitlementType: isSubscription ? 'CREATOR_PLAN' : null,
      ),
      billing: billing,
    );
  }

  @override
  Future<MobileBilling> refreshSubscription() async {
    refreshCalls += 1;
    return billing;
  }

  @override
  Future<MobileBilling> cancelSubscription() async {
    cancelCalls += 1;
    if (cancelError != null) {
      throw cancelError!;
    }
    billing = fakeBilling(availableCredits: billing.credits.available);
    return billing;
  }
}

/// The paywall only has to reach the log; what it lists is covered by
/// credit_log_test.dart.
class EmptyCreditLogRepository implements CreditLogRepository {
  @override
  Future<CreditLogPage> getCreditLog({String? cursor, int limit = 30}) async {
    return const CreditLogPage(entries: []);
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
              'tomeza.pro_monthly' => r'$39.99',
              'tomeza.credit_pack_2' => r'$14.99',
              _ => r'$7.99',
            },
            rawPrice: switch (id) {
              'tomeza.one_book_export' => 9.99,
              'tomeza.creator_monthly' => 19.99,
              'tomeza.pro_monthly' => 39.99,
              'tomeza.credit_pack_2' => 14.99,
              _ => 7.99,
            },
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

MobileBilling fakeBilling({required int availableCredits, String? planTier}) {
  return MobileBilling(
    credits: CreditBalance(
      available: availableCredits,
      reserved: 0,
      lifetimeGranted: availableCredits,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    plan: planTier == null
        ? null
        : MobileSubscriptionPlan(
            tier: planTier,
            source: 'google_play',
            status: 'active',
            productSku: 'tomeza.${planTier}_monthly',
          ),
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
        sku: 'tomeza.pro_monthly',
        title: 'Pro monthly',
        description: 'Nine standard export credits monthly.',
        productType: 'SUBSCRIPTION',
        creditAmount: 9000,
        priceMicros: 39990000,
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
      MobileBillingProduct(
        sku: 'tomeza.credit_pack_2',
        title: 'Two extra credits',
        description: 'Two extra standard export credits.',
        productType: 'CREDIT_PACK',
        creditAmount: 2000,
        priceMicros: 14990000,
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
