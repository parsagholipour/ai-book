import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_buy_credits_sheet.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';
import 'package:tomeza/features/billing/presentation/credit_log_screen.dart';

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

    final successDialog = find.byKey(
      const ValueKey('billing-purchase-success-dialog'),
    );
    expect(successDialog, findsOneWidget);
    expect(find.text('Purchase successful'), findsOneWidget);
    expect(
      find.descendant(
        of: successDialog,
        matching: find.text('1000 credits added.'),
      ),
      findsOneWidget,
    );
    expect(repository.verifications.single.productId, 'tomeza.one_book_export');
    expect(repository.verifications.single.purchaseToken, 'purchase-token-1');
    expect(store.finished.single.purchaseToken, 'purchase-token-1');
    await tester.tap(
      find.descendant(of: successDialog, matching: find.byType(FilledButton)),
    );
    await tester.pumpAndSettle();

    expect(find.text('1000 credits added.'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('1,100'),
      -200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('1,100'), findsOneWidget);
  });

  testWidgets('a verified purchase closes the paywall before its dialog', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();

    await tester.pumpWidget(
      testPaywallLauncher(store: store, repository: repository),
    );
    await tester.tap(find.byKey(const ValueKey('open-billing-paywall')));
    await tester.pumpAndSettle();

    final creditPack = find.byKey(
      const ValueKey('paywall-topup-tomeza.credit_pack_1'),
    );
    await tester.scrollUntilVisible(
      creditPack,
      200,
      scrollable: find.byType(Scrollable).first,
    );
    final buyButton = find.descendant(
      of: creditPack,
      matching: find.byType(FilledButton),
    );
    await tester.ensureVisible(buyButton);
    await tester.pumpAndSettle();
    await tester.tap(buyButton);
    await tester.pump();

    expect(store.buyCalls.single.product.id, 'tomeza.credit_pack_1');

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.pending,
        purchaseToken: 'pending-token',
      ),
    );
    await tester.pump();

    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsNothing,
    );

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'purchase-token-1',
        purchaseId: 'order-1',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(BillingPaywall), findsNothing);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsOneWidget,
    );
    expect(find.text('Purchase successful'), findsOneWidget);
    expect(repository.verifications.single.productId, 'tomeza.credit_pack_1');
  });

  testWidgets('a late success cannot pop the page under a closing paywall', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();

    await tester.pumpWidget(
      testPaywallLauncher(store: store, repository: repository),
    );
    await tester.tap(find.byKey(const ValueKey('open-billing-paywall')));
    await tester.pumpAndSettle();

    final creditPack = find.byKey(
      const ValueKey('paywall-topup-tomeza.credit_pack_1'),
    );
    await tester.scrollUntilVisible(
      creditPack,
      200,
      scrollable: find.byType(Scrollable).first,
    );
    final buyButton = find.descendant(
      of: creditPack,
      matching: find.byType(FilledButton),
    );
    await tester.ensureVisible(buyButton);
    await tester.pumpAndSettle();
    await tester.tap(buyButton);
    await tester.pump();

    // Begin dismissing the paywall while its store purchase is still active.
    await tester.binding.handlePopRoute();
    await tester.pump();
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'late-purchase-token',
        purchaseId: 'late-order',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    // Verification and store completion survive route disposal, but the event
    // no longer owns a current route and therefore cannot pop the launcher.
    expect(
      repository.verifications.single.purchaseToken,
      'late-purchase-token',
    );
    expect(store.finished.single.purchaseToken, 'late-purchase-token');
    expect(find.byType(BillingPaywall), findsNothing);
    expect(find.byKey(const ValueKey('open-billing-paywall')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsNothing,
    );
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

  testWidgets('a shortfall leads the sheet with the two ways out of it', (
    tester,
  ) async {
    await tester.pumpWidget(
      testPaywall(
        store: FakeStoreBillingClient(),
        repository: FakeBillingRepository(),
        creditsNeeded: const PaywallCreditsNeeded(
          credits: 500,
          reason: 'Writing this short novel.',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Credits needed'), findsOneWidget);
    expect(find.text('Writing this short novel.'), findsOneWidget);
    expect(find.textContaining('400 short'), findsOneWidget);
    // The masthead the sheet opens with otherwise stays out of the way.
    expect(find.text('Upgrade your plan'), findsNothing);

    // Buying is its own question — how many credits, and what does that cost —
    // so the button opens the sheet that can answer it.
    await tester.tap(find.byKey(const ValueKey('paywall-buy-credits')));
    await tester.pumpAndSettle();
    expect(find.byType(BuyCreditsSheet), findsOneWidget);
    // Opened on the number the reader is actually short.
    expect(_amountField(tester).controller?.text, '400');
  });

  testWidgets('upgrade goes to the next rung, not the top of the ladder', (
    tester,
  ) async {
    await tester.pumpWidget(
      testPaywall(
        store: FakeStoreBillingClient(),
        repository: FakeBillingRepository(planTier: 'creator'),
        creditsNeeded: const PaywallCreditsNeeded(credits: 500),
      ),
    );
    await tester.pumpAndSettle();

    // On Creator, "upgrade" means Pro — and says so.
    expect(find.text('Upgrade to Pro monthly'), findsOneWidget);
    expect(find.text('Pro monthly'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('paywall-upgrade-plan')));
    await tester.pumpAndSettle();

    expectInViewport(
      tester,
      find.byKey(const ValueKey('paywall-plan-tomeza.pro_monthly')),
    );
  });

  testWidgets('the buy sheet prices a custom amount and buys the pack', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();
    await tester.pumpWidget(
      testPaywall(
        store: store,
        repository: repository,
        creditsNeeded: const PaywallCreditsNeeded(credits: 500),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('paywall-buy-credits')));
    await tester.pumpAndSettle();

    // 400 credits: the small pack covers it, with change.
    expect(find.text('One extra credit'), findsWidgets);
    expect(find.textContaining('600 to spare'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, r'Buy — $7.99'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('buy-credits-amount')),
      '2500',
    );
    await tester.pumpAndSettle();

    // Past the largest pack: the sheet says what it would really take, and
    // that the ladder is cheaper than taking it.
    expect(find.textContaining('2,500 credits is about'), findsOneWidget);
    expect(find.text('Two extra credits × 2'), findsOneWidget);
    expect(find.textContaining('2 purchases'), findsOneWidget);
    expect(find.text('Creator monthly costs less than this'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('buy-credits-buy')));
    await tester.pump();

    expect(store.buyCalls.single.product.id, 'tomeza.credit_pack_2');
    expect(store.buyCalls.single.consumable, isTrue);
    expect(find.byType(BuyCreditsSheet), findsOneWidget);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsNothing,
    );

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_2',
        status: StorePurchaseStatus.pending,
        purchaseToken: 'pending-token',
      ),
    );
    await tester.pump();

    // Opening checkout and a pending payment must not dismiss the sheet.
    expect(find.byType(BuyCreditsSheet), findsOneWidget);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsNothing,
    );

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_2',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'purchase-token-2',
        purchaseId: 'order-2',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(BuyCreditsSheet), findsNothing);
    expect(find.byType(BillingPaywall), findsOneWidget);
    final successDialog = find.byKey(
      const ValueKey('billing-purchase-success-dialog'),
    );
    expect(successDialog, findsOneWidget);
    expect(find.text('Purchase successful'), findsOneWidget);
    expect(
      find.descendant(
        of: successDialog,
        matching: find.text('1000 credits added.'),
      ),
      findsOneWidget,
    );
    expect(repository.verifications.single.productId, 'tomeza.credit_pack_2');
    expect(repository.verifications.single.purchaseToken, 'purchase-token-2');
    expect(store.finished.single.purchaseToken, 'purchase-token-2');

    await tester.tap(
      find.descendant(of: successDialog, matching: find.byType(FilledButton)),
    );
    await tester.pumpAndSettle();

    expect(find.text('You have enough credits'), findsOneWidget);
    expect(find.text('1000 credits added.'), findsNothing);
  });

  testWidgets('a backend-pending purchase keeps the buy sheet open', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository()..nextPurchaseIsPending = true;
    await tester.pumpWidget(
      testPaywall(
        store: store,
        repository: repository,
        creditsNeeded: const PaywallCreditsNeeded(credits: 500),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('paywall-buy-credits')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('buy-credits-buy')));
    await tester.pump();

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'backend-pending-token',
        purchaseId: 'backend-pending-order',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(
      repository.verifications.single.purchaseToken,
      'backend-pending-token',
    );
    expect(store.finished.single.purchaseToken, 'backend-pending-token');
    expect(find.byType(BuyCreditsSheet), findsOneWidget);
    expect(find.byType(BillingPaywall), findsOneWidget);
    expect(find.textContaining('Payment is pending'), findsWidgets);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsNothing,
    );
  });

  testWidgets('a canceled attempt does not claim a later purchase', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();
    await tester.pumpWidget(
      testPaywall(
        store: store,
        repository: repository,
        creditsNeeded: const PaywallCreditsNeeded(credits: 500),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('paywall-buy-credits')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('buy-credits-buy')));
    await tester.pump();

    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.canceled,
        purchaseToken: '',
      ),
    );
    await tester.pump();
    expect(find.byType(BuyCreditsSheet), findsOneWidget);

    // A later restore or external completion for the same SKU is not the
    // canceled button press and must not dismiss this sheet.
    store.emit(
      const StorePurchaseUpdate(
        productId: 'tomeza.credit_pack_1',
        status: StorePurchaseStatus.purchased,
        purchaseToken: 'external-purchase-token',
        purchaseId: 'external-order',
        pendingCompletePurchase: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(
      repository.verifications.single.purchaseToken,
      'external-purchase-token',
    );
    expect(find.byType(BuyCreditsSheet), findsOneWidget);
    expect(
      find.byKey(const ValueKey('billing-purchase-success-dialog')),
      findsNothing,
    );
  });

  testWidgets('the shortfall settles once a purchase covers it', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    await tester.pumpWidget(
      testPaywall(
        store: store,
        repository: FakeBillingRepository(),
        creditsNeeded: const PaywallCreditsNeeded(credits: 500),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('400 short'), findsOneWidget);
    expect(find.byKey(const ValueKey('paywall-credits-done')), findsNothing);

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

    // The card reads the live balance, so the arithmetic it opened with is not
    // still on screen after the credits it asked for arrived.
    expect(find.text('You have enough credits'), findsOneWidget);
    expect(find.textContaining('short'), findsNothing);
    expect(find.byKey(const ValueKey('paywall-credits-done')), findsOneWidget);
  });

  testWidgets('the credit log opens over the sheet rather than closing it', (
    tester,
  ) async {
    await tester.pumpWidget(
      testPaywall(
        store: FakeStoreBillingClient(),
        repository: FakeBillingRepository(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('paywall-credit-log')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(find.byKey(const ValueKey('paywall-credit-log')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('paywall-credit-log')));
    await tester.pumpAndSettle();

    expect(find.byType(CreditLogScreen), findsOneWidget);
    // Someone checking where their credits went is usually about to buy more,
    // so the paywall is still underneath when they come back.
    expect(
      find.byType(BillingPaywall, skipOffstage: false),
      findsOneWidget,
    );
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
                title: null,
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
TextField _amountField(WidgetTester tester) =>
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
