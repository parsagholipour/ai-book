
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_buy_credits_sheet.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/credit_log_screen.dart';

import 'billing_paywall_harness.dart';

void main() {
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
    expect(amountField(tester).controller?.text, '400');
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
      testPaywallLauncher(
        store: store,
        repository: repository,
        creditsNeeded: const PaywallCreditsNeeded(credits: 500),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('open-billing-paywall')));
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

    // Enough credits now — the shortfall sheet has nothing left to ask for.
    expect(find.byType(BillingPaywall), findsNothing);
    expect(find.text('You have enough credits'), findsNothing);
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

}
