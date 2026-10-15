import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/account/presentation/account_billing_copy.dart';
import 'package:tomeza/features/account/presentation/account_overview_card.dart';
import 'package:tomeza/features/account/presentation/account_plan_screen.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/play_purchase_processor.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_controller.dart';
import 'package:tomeza/features/billing/presentation/billing_purchase_success_dialog.dart';
import 'package:tomeza/shared/api/api_error.dart';

import 'billing_paywall_harness.dart';

/// What a buyer reads after Play has answered. Each of these used to say the
/// wrong thing: a charged card told to "check your connection", a downgrade
/// that bought nothing today called "verified, credits available", and a quiet
/// re-check on resume spinning every paywall button.
class _ScriptedRepository extends FakeBillingRepository {
  _ScriptedRepository();

  Completer<void>? gate;
  Object? verifyError;
  var verifyStarted = 0;

  /// When set, a billing read fails with it.
  Object? billingError;

  @override
  Future<MobileBilling> getBilling() async {
    final error = billingError;
    if (error != null) throw error;
    return super.getBilling();
  }

  /// When set, the next verification is a downgrade Play deferred.
  ({String sku, DateTime at})? scheduled;

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
    verifyStarted += 1;
    final wait = gate;
    if (wait != null) await wait.future;
    final error = verifyError;
    if (error != null) throw error;
    final change = scheduled;
    if (change != null) {
      return GooglePlayVerificationResult(
        purchase: VerifiedPurchase(
          id: 'switch-record',
          status: 'granted',
          creditsGranted: 0,
          subscriptionStatus: 'active',
          scheduledChangeSku: change.sku,
          scheduledChangeAt: change.at,
        ),
        billing: billingWithPendingChange(change.sku, change.at),
      );
    }
    return super.verifyGooglePlayPurchase(
      productId: productId,
      purchaseToken: purchaseToken,
      transactionId: transactionId,
      purchaseStatus: purchaseStatus,
      projectId: projectId,
      localPriceMicros: localPriceMicros,
      localCurrency: localCurrency,
    );
  }
}

/// Max, running out its paid month before a switch to [sku] on [at].
MobileBilling billingWithPendingChange(String sku, DateTime at) {
  final base = fakeBilling(availableCredits: 5000);
  return MobileBilling(
    purchaseAccountId: base.purchaseAccountId,
    credits: base.credits,
    entitlements: base.entitlements,
    products: base.products,
    creditCosts: base.creditCosts,
    plan: MobileSubscriptionPlan(
      tier: 'max',
      source: 'google_play',
      status: 'active',
      productSku: 'tomeza.max_monthly',
      renewsAt: at,
      pendingChangeSku: sku,
      pendingChangeAt: at,
    ),
  );
}

StorePurchaseUpdate _update(
  String sku,
  String token, {
  StorePurchaseStatus status = StorePurchaseStatus.purchased,
}) {
  return StorePurchaseUpdate(
    productId: sku,
    status: status,
    purchaseToken: token,
    purchaseId: 'order-$token',
    purchaseAccountId: 'test-purchase-account',
    pendingCompletePurchase: true,
  );
}

/// Wednesday 4 November 2026, midday UTC: the same calendar day everywhere
/// the suite runs.
final _switchDay = DateTime.utc(2026, 11, 4, 12);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the controller', () {
    late FakeStoreBillingClient store;
    late _ScriptedRepository repository;
    late PlayPurchaseProcessor purchases;
    late BillingController controller;

    setUp(() async {
      store = FakeStoreBillingClient();
      repository = _ScriptedRepository();
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
    });

    tearDown(() {
      controller.dispose();
      purchases.dispose();
    });

    test(
      'a charge the server could not record yet says the payment went through',
      () async {
        repository.verifyError = const ApiException(
          code: 'NETWORK_ERROR',
          message: 'Check your connection and try again.',
        );
        store.emit(_update('tomeza.credit_pack_1', 'paid-token'));
        await pumpEventQueue();

        final message = controller.state.message;
        expect(message, playPaymentNotRecordedMessage);
        expect(message, contains('Your payment went through'));
        expect(message, contains('Restore purchases'));
        expect(message, isNot(contains('Check your connection')));
        expect(controller.state.error, isNull);
        expect(controller.state.pendingProductIds, isEmpty);
        // Left unfinished in Play, so the next pass or a restore records it.
        expect(store.finished, isEmpty);
      },
    );

    test(
      'a refusal is still an error, and takes the "Adding" line with it',
      () async {
        const refusal = ApiException(
          code: 'GOOGLE_PLAY_ACCOUNT_MISMATCH',
          message:
              'Sign in to the Tomeza account that started this purchase, then restore purchases.',
        );
        repository.gate = Completer<void>();
        repository.verifyError = refusal;
        store.emit(
          _update(
            'tomeza.credit_pack_1',
            'restored-token',
            status: StorePurchaseStatus.restored,
          ),
        );
        await pumpEventQueue();
        expect(
          controller.state.message,
          'Adding your purchase to your account.',
        );
        expect(controller.state.pendingProductIds, {'tomeza.credit_pack_1'});

        repository.gate!.complete();
        await pumpEventQueue();

        expect(controller.state.error, refusal.message);
        expect(controller.state.message, isNull);
        expect(controller.state.pendingProductIds, isEmpty);
      },
    );

    test(
      'a re-check on resume holds no button and leaves nothing on screen',
      () async {
        repository.gate = Completer<void>();
        store.owned = [
          _update(
            'tomeza.creator_monthly',
            'orphan-plan',
            status: StorePurchaseStatus.restored,
          ),
        ];
        unawaited(purchases.signedIn('user-1'));
        await pumpEventQueue();

        expect(repository.verifyStarted, 1);
        expect(controller.state.pendingProductIds, isEmpty);
        expect(controller.state.message, isNull);

        repository.verifyError = const ApiException(
          code: 'NETWORK_ERROR',
          message: 'Check your connection and try again.',
        );
        repository.gate!.complete();
        await pumpEventQueue();

        expect(controller.state.message, isNull);
        expect(controller.state.error, isNull);
        expect(controller.state.pendingProductIds, isEmpty);
      },
    );

    test('a deferred downgrade says when the plan switches', () async {
      final events = <BillingPurchaseEvent>[];
      final subscription = controller.purchaseEvents.listen(events.add);
      addTearDown(subscription.cancel);
      repository.scheduled = (sku: 'tomeza.creator_monthly', at: _switchDay);

      store.emit(_update('tomeza.creator_monthly', 'switch-token'));
      await pumpEventQueue();

      expect(
        controller.state.message,
        'Your plan switches to Creator on Wed, Nov 4.',
      );
      expect(controller.state.message, isNot(contains('verified')));
      final success = events.whereType<BillingPurchaseSuccess>().single;
      expect(success.scheduled, isTrue);
      expect(success.message, 'Your plan switches to Creator on Wed, Nov 4.');
    });

    // Play said yes to the downgrade, but this phone could confirm nothing:
    // no token surfaced yet and the billing read failed. Nothing went wrong
    // and nothing was charged, so it is not drawn in error colours.
    test(
      'an unconfirmed deferred downgrade is a message, not an error',
      () async {
        final events = <BillingPurchaseEvent>[];
        final subscription = controller.purchaseEvents.listen(events.add);
        addTearDown(subscription.cancel);
        repository.billingError = const ApiException(
          code: 'NETWORK_ERROR',
          message: 'Check your connection and try again.',
        );

        store.emit(
          const StorePurchaseUpdate(
            productId: 'tomeza.creator_monthly',
            status: StorePurchaseStatus.purchased,
            purchaseToken: '',
            planChangeDeferred: true,
          ),
        );
        await pumpEventQueue();

        expect(controller.state.message, playPlanChangeNotConfirmedMessage);
        expect(controller.state.message, contains('accepted your plan change'));
        expect(controller.state.error, isNull);
        expect(controller.state.pendingProductIds, isEmpty);
        expect(events.whereType<BillingPurchaseStopped>(), hasLength(1));
      },
    );
  });

  testWidgets('a scheduled switch is not called a purchase', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          billingRepositoryProvider.overrideWithValue(FakeBillingRepository()),
        ],
        child: const MaterialApp(
          home: Scaffold(
            body: BillingPurchaseSuccessDialog(
              purchase: BillingPurchaseSuccess(
                productId: 'tomeza.creator_monthly',
                purchaseId: 'switch-record',
                message: 'Your plan switches to Creator on Wed, Nov 4.',
                scheduled: true,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Plan change scheduled'), findsOneWidget);
    expect(find.text('Purchase successful'), findsNothing);
  });

  testWidgets('the paywall shows a scheduled switch above the plans', (
    tester,
  ) async {
    final repository = FakeBillingRepository()
      ..billing = billingWithPendingChange(
        'tomeza.creator_monthly',
        _switchDay,
      );
    await tester.pumpWidget(
      testPaywall(store: FakeStoreBillingClient(), repository: repository),
    );
    await tester.pumpAndSettle();

    expect(find.text('Plan change scheduled'), findsOneWidget);
    expect(
      find.text('Switches to Creator on Wed, Nov 4. You keep Max until then.'),
      findsOneWidget,
    );
  });

  testWidgets('a downgrade is sold as starting at renewal, not now', (
    tester,
  ) async {
    await tester.pumpWidget(
      testPaywall(
        store: FakeStoreBillingClient(),
        repository: FakeBillingRepository(planTier: 'max'),
      ),
    );
    await tester.pumpAndSettle();

    // Max to Creator is deferred by Play; "Switches now at full price" was
    // the upgrade's small print.
    expect(find.text('Switch to Creator'), findsOneWidget);
    expect(
      find.text(
        'Starts when your current plan renews; you keep Max until then. '
        'Renews monthly; cancel in Google Play.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('Switches now'), findsNothing);
  });

  testWidgets('the plan card says when the plan switches, not that it renews', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: AccountPlanCard(
              billing: AsyncValue.data(
                billingWithPendingChange('tomeza.creator_monthly', _switchDay),
              ),
              onUpgrade: () {},
              onManageSubscription: (_) {},
              onCancelSubscription: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Switches to Creator on Wed, Nov 4'), findsOneWidget);
    expect(find.textContaining('Renews'), findsNothing);
  });

  testWidgets(
    'the account hub says when the plan switches, not that it renews',
    (tester) async {
      final billing = billingWithPendingChange(
        'tomeza.creator_monthly',
        _switchDay,
      );
      late String subtitle;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              subtitle = hubPlanSubtitle(context, billing);
              return const SizedBox.shrink();
            },
          ),
        ),
      );

      expect(subtitle, 'Max · Switches to Creator on Wed, Nov 4');
      expect(subtitle, isNot(contains('Renews')));
    },
  );

  testWidgets(
    'the account overview says when the plan switches, not that it renews',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: AccountOverviewCard(
                billing: AsyncValue.data(
                  billingWithPendingChange(
                    'tomeza.creator_monthly',
                    _switchDay,
                  ),
                ),
                onGetCredits: () {},
                onRetry: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Switches to Creator on Wed, Nov 4'), findsOneWidget);
      expect(find.textContaining('Renews'), findsNothing);
    },
  );

  testWidgets('a plan with nothing scheduled still says when it renews', (
    tester,
  ) async {
    final base = fakeBilling(availableCredits: 5000);
    final billing = MobileBilling(
      purchaseAccountId: base.purchaseAccountId,
      credits: base.credits,
      entitlements: base.entitlements,
      products: base.products,
      creditCosts: base.creditCosts,
      plan: MobileSubscriptionPlan(
        tier: 'max',
        source: 'google_play',
        status: 'active',
        productSku: 'tomeza.max_monthly',
        renewsAt: _switchDay,
      ),
    );
    late String subtitle;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              subtitle = hubPlanSubtitle(context, billing);
              return AccountOverviewCard(
                billing: AsyncValue.data(billing),
                onGetCredits: () {},
                onRetry: () {},
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(subtitle, startsWith('Max · Renews '));
    expect(find.textContaining('Renews '), findsOneWidget);
    expect(find.textContaining('Switches to'), findsNothing);
  });
}
