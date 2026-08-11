
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/app/config/app_config.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/credit_log_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_paywall.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';

import 'billing_paywall_harness.dart';

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

  testWidgets('showBillingPaywall returns the verified purchase to its caller', (
    tester,
  ) async {
    // The caller that opened the paywall over something the balance blocked is
    // the only place that can offer to pick that thing back up, so the outcome
    // must reach it instead of being swallowed with the success dialog.
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository();
    BillingPurchaseSuccess? returned;
    var callerResumed = false;

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          storeBillingClientProvider.overrideWithValue(store),
          billingRepositoryProvider.overrideWithValue(repository),
          creditLogRepositoryProvider.overrideWithValue(
            EmptyCreditLogRepository(),
          ),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: FilledButton(
                  key: const ValueKey('open-billing-paywall'),
                  onPressed: () async {
                    returned = await showBillingPaywall(
                      context,
                      projectId: 'project-1',
                      title: null,
                    );
                    callerResumed = true;
                  },
                  child: const Text('Open billing'),
                ),
              ),
            ),
          ),
        ),
      ),
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

    // The success dialog still gates the caller: the purchase is returned
    // only once the user has acknowledged it.
    expect(callerResumed, isFalse);
    final successDialog = find.byKey(
      const ValueKey('billing-purchase-success-dialog'),
    );
    expect(successDialog, findsOneWidget);
    await tester.tap(
      find.descendant(of: successDialog, matching: find.byType(FilledButton)),
    );
    await tester.pumpAndSettle();

    expect(callerResumed, isTrue);
    expect(returned?.productId, 'tomeza.credit_pack_1');
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
