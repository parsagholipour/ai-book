import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_cancel_sheet.dart';
import 'package:tomeza/features/billing/presentation/play_subscriptions_link.dart';

/// Cancelling a plan. The sheet is the whole feature on this side: it has to say
/// what the reader keeps before it does anything, and then either end the
/// subscription itself or hand over to Play and check what happened.

void main() {
  testWidgets('says what is kept and what free gives before cancelling', (
    tester,
  ) async {
    final repository = _FakeBillingRepository();
    await _open(tester, repository, _billing(canCancelInApp: true));

    expect(find.text('Cancel your Creator plan?'), findsOneWidget);
    expect(find.textContaining('You keep Creator until'), findsOneWidget);
    expect(
      find.textContaining('Your 4,200 purchased credits never expire'),
      findsOneWidget,
    );
    expect(find.text('Every book you have made stays yours'), findsOneWidget);
    expect(find.text('1,000 credits every month'), findsOneWidget);
    expect(find.text('3 illustrated books a month'), findsOneWidget);
    // Nothing has happened yet — the sheet is the explanation, not the action.
    expect(repository.cancelCalls, 0);
  });

  testWidgets('ends the subscription in place when the backend can', (
    tester,
  ) async {
    final repository = _FakeBillingRepository();
    await _open(tester, repository, _billing(canCancelInApp: true));

    expect(find.text('Cancel subscription'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('cancel-subscription-confirm')));
    await tester.pumpAndSettle();

    expect(repository.cancelCalls, 1);
    // Done means gone: the sheet closes rather than leaving a dead card up.
    expect(find.text('Cancel your Creator plan?'), findsNothing);
  });

  testWidgets('keeps the sheet up and says why when cancelling fails', (
    tester,
  ) async {
    final repository = _FakeBillingRepository()
      ..cancelError = Exception('Cancel this subscription from Google Play.');
    await _open(tester, repository, _billing(canCancelInApp: true));

    await tester.tap(find.byKey(const ValueKey('cancel-subscription-confirm')));
    await tester.pumpAndSettle();

    expect(find.text('That did not work'), findsOneWidget);
    expect(find.text('Cancel your Creator plan?'), findsOneWidget);
  });

  testWidgets('hands a real Play subscription over, then re-checks it', (
    tester,
  ) async {
    // `canCancelInApp: false` is production: Google owns the cancellation, so
    // the only thing left for the app is to ask what happened afterwards.
    final repository = _FakeBillingRepository();
    final launches = <String?>[];
    await _open(
      tester,
      repository,
      _billing(canCancelInApp: false),
      playLaunches: launches,
    );

    expect(find.text('Cancel in Play'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('cancel-subscription-confirm')));
    await tester.pumpAndSettle();

    expect(launches, ['tomeza.creator_monthly']);
    expect(repository.cancelCalls, 0);
    expect(find.text('Finish in Google Play'), findsOneWidget);
    expect(find.text('Check my plan'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('cancel-subscription-confirm')));
    await tester.pumpAndSettle();

    expect(repository.refreshCalls, 1);
    expect(find.text('Cancel your Creator plan?'), findsNothing);
  });

  testWidgets('a device that cannot reach Play is told what to do instead', (
    tester,
  ) async {
    final repository = _FakeBillingRepository();
    await _open(
      tester,
      repository,
      _billing(canCancelInApp: false),
      playOpens: false,
    );

    await tester.tap(find.byKey(const ValueKey('cancel-subscription-confirm')));
    await tester.pumpAndSettle();

    // Never a dead end: the instruction changes, the way forward does not.
    expect(find.textContaining('Play would not open'), findsOneWidget);
    expect(find.text('Check my plan'), findsOneWidget);
  });
}

Future<void> _open(
  WidgetTester tester,
  _FakeBillingRepository repository,
  MobileBilling billing, {
  List<String?>? playLaunches,
  bool playOpens = true,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        billingRepositoryProvider.overrideWithValue(repository),
        storeBillingClientProvider.overrideWithValue(_SilentStoreClient()),
        playSubscriptionsLauncherProvider.overrideWithValue((sku) async {
          playLaunches?.add(sku);
          return playOpens;
        }),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () =>
                  showCancelSubscriptionSheet(context, billing: billing),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

MobileBilling _billing({required bool canCancelInApp}) {
  return MobileBilling(
    credits: const CreditBalance(
      available: 9200,
      purchased: 4200,
      reserved: 0,
      lifetimeGranted: 9200,
      lifetimeSpent: 0,
    ),
    entitlements: const [],
    products: const [],
    creditCosts: const {},
    plan: MobileSubscriptionPlan(
      tier: 'creator',
      source: 'google_play',
      status: 'ACTIVE',
      renewsAt: DateTime.utc(2026, 9, 12),
      canCancelInApp: canCancelInApp,
      productSku: 'tomeza.creator_monthly',
    ),
    allowance: MobileAllowance(
      monthlyCredits: 6000,
      planCredits: 5000,
      resetsAt: DateTime.utc(2026, 9, 12),
    ),
  );
}

class _FakeBillingRepository implements BillingRepository {
  MobileBilling billing = _billing(canCancelInApp: true);
  var cancelCalls = 0;
  var refreshCalls = 0;
  Object? cancelError;

  @override
  Future<MobileBilling> getBilling() async => billing;

  @override
  Future<MobileBilling> cancelSubscription() async {
    cancelCalls += 1;
    if (cancelError != null) {
      throw cancelError!;
    }
    return billing;
  }

  @override
  Future<MobileBilling> refreshSubscription() async {
    refreshCalls += 1;
    return billing;
  }

  @override
  Future<GooglePlayVerificationResult> verifyGooglePlayPurchase({
    required String productId,
    required String purchaseToken,
    String? transactionId,
    String? purchaseStatus,
    String? projectId,
  }) {
    throw UnimplementedError();
  }
}

/// The controller opens a store connection on construction; the cancel flow
/// never touches it.
class _SilentStoreClient implements StoreBillingClient {
  @override
  Stream<List<StorePurchaseUpdate>> get purchaseUpdates =>
      const Stream<List<StorePurchaseUpdate>>.empty();

  @override
  Future<bool> isAvailable() async => false;

  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> ids) async {
    return const StoreProductQueryResult(products: [], notFoundIds: []);
  }

  @override
  Future<void> buyProduct(StoreProduct product, {bool consumable = false}) async {}

  @override
  Future<void> restorePurchases() async {}

  @override
  Future<void> finishPurchase(
    StorePurchaseUpdate purchase, {
    bool consumable = false,
  }) async {}
}
