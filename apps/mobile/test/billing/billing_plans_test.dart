import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_free_plan_card.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';
import 'package:tomeza/features/billing/presentation/billing_tier_style.dart';

/// Plan tiers, the allowance, and the free tier's image budget as the app shows
/// them. The purchase plumbing itself is covered by billing_paywall_test.dart.

const _creator = MobileBillingProduct(
  sku: 'tomeza.creator_monthly',
  title: 'Creator',
  description: '6,000 credits a month.',
  productType: 'SUBSCRIPTION',
  creditAmount: 6000,
  priceMicros: 19990000,
  currency: 'USD',
);

const _max = MobileBillingProduct(
  sku: 'tomeza.max_monthly',
  title: 'Max',
  description: '80,000 credits a month.',
  productType: 'SUBSCRIPTION',
  creditAmount: 80000,
  priceMicros: 199990000,
  currency: 'USD',
);

MobileBilling _billing({
  String tier = 'free',
  String? productSku,
  int planCredits = 600,
  int monthlyCredits = 1000,
  MobileImageQuota? imageQuota,
  bool cancelAtPeriodEnd = false,
}) {
  return MobileBilling(
    credits: CreditBalance(
      available: planCredits,
      purchased: 0,
      reserved: 0,
      lifetimeGranted: monthlyCredits,
      lifetimeSpent: monthlyCredits - planCredits,
    ),
    entitlements: const [],
    products: const [_creator, _max],
    creditCosts: const {'imageGeneration': 45},
    plan: MobileSubscriptionPlan(
      tier: tier,
      source: tier == 'free' ? 'free' : 'google_play',
      status: tier == 'free' ? null : (cancelAtPeriodEnd ? 'CANCELED' : 'ACTIVE'),
      renewsAt: tier == 'free' || cancelAtPeriodEnd
          ? null
          : DateTime.utc(2026, 7, 15),
      cancelAtPeriodEnd: cancelAtPeriodEnd,
      endsAt: cancelAtPeriodEnd ? DateTime.utc(2026, 7, 15) : null,
      productSku: productSku,
    ),
    allowance: MobileAllowance(
      monthlyCredits: monthlyCredits,
      planCredits: planCredits,
      resetsAt: DateTime.utc(2026, 7, 1),
    ),
    imageQuota: imageQuota,
  );
}

/// A fragment (a card, a banner) inside a scrollable body.
Widget _wrap(Widget child, {MobileBilling? billing}) {
  return _scope(
    billing,
    MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child))),
  );
}

Widget _scope(MobileBilling? billing, Widget child) {
  return ProviderScope(
    overrides: [
      billingProvider.overrideWith((ref) async => billing ?? _billing()),
    ],
    child: child,
  );
}

void main() {
  group('plan card', () {
    testWidgets('sells the plan on what it includes, not just a price', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          BillingPlanCard(
            product: _max,
            isCurrentPlan: false,
            pending: false,
            onBuy: () {},
            storeProduct: const StoreProduct(
              id: 'tomeza.max_monthly',
              title: 'Max',
              description: '',
              price: r'$199.99',
              rawPrice: 199.99,
              currencyCode: 'USD',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('80,000 credits every month'), findsOneWidget);
      expect(find.text('Unlimited illustrated books'), findsOneWidget);
      expect(find.text(r'$199.99'), findsOneWidget);
      expect(find.text('per month'), findsOneWidget);
      // The call to action names the move, not the price — the price is already
      // the largest thing on the card.
      expect(find.text('Upgrade to Max'), findsOneWidget);
    });

    testWidgets('the better deal is worked out from the prices on offer', (
      tester,
    ) async {
      final value = billingPlanValue(const [_creator, _max], const {});

      // $19.99/6,000 is 300 credits per dollar against Max's 400, so Max is a
      // quarter cheaper per credit.
      expect(value.bestValueSku, 'tomeza.max_monthly');
      expect(value.savingsFor('tomeza.max_monthly'), 25);
      expect(value.savingsFor('tomeza.creator_monthly'), isNull);

      await tester.pumpWidget(
        _wrap(
          BillingPlanCard(
            product: _max,
            isCurrentPlan: false,
            pending: false,
            bestValue: true,
            savingsPercent: value.savingsFor('tomeza.max_monthly'),
            onBuy: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('BEST VALUE'), findsOneWidget);
      expect(find.text('Save 25%'), findsOneWidget);
    });

    testWidgets('a downgrade is offered as a switch, not an upgrade', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          BillingPlanCard(
            product: _creator,
            isCurrentPlan: false,
            currentTier: 'max',
            pending: false,
            onBuy: () {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Switch to Creator'), findsOneWidget);
    });

    testWidgets('the plan you are on cannot be bought again', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BillingPlanCard(
            product: _creator,
            isCurrentPlan: true,
            pending: false,
            onBuy: () {},
            storeProduct: const StoreProduct(
              id: 'tomeza.creator_monthly',
              title: 'Creator',
              description: '',
              price: r'$19.99',
              rawPrice: 19.99,
              currencyCode: 'USD',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('YOUR CURRENT PLAN'), findsOneWidget);
      expect(find.text('Your plan'), findsOneWidget);
      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull);
    });
  });

  group('plan card layout', () {
    // The card packs a price, a savings chip, a ribbon and a benefit list into
    // a phone's width. Long localised prices and large type are where that
    // comes apart, so both are rendered rather than assumed.
    for (final scale in <double>[1, 1.6]) {
      testWidgets('survives a long price and a $scale text scale', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(360, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(
          _scope(
            _billing(),
            MaterialApp(
              home: Scaffold(
                body: MediaQuery(
                  data: MediaQueryData(textScaler: TextScaler.linear(scale)),
                  child: SingleChildScrollView(
                    child: Column(
                      children: [
                        BillingPlanCard(
                          product: _max,
                          isCurrentPlan: false,
                          pending: false,
                          bestValue: true,
                          savingsPercent: 25,
                          onBuy: () {},
                          storeProduct: const StoreProduct(
                            id: 'tomeza.max_monthly',
                            title: 'Max',
                            description: '',
                            price: 'Rp 3.199.000,00',
                            rawPrice: 3199000,
                            currencyCode: 'IDR',
                          ),
                        ),
                        BillingPlanCard(
                          product: _creator,
                          isCurrentPlan: true,
                          pending: false,
                          currentTier: 'creator',
                          onBuy: () {},
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
      });
    }
  });

  group('plan banner', () {
    testWidgets('shows what is left of the allowance and the image budget', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          BillingPlanBanner(
            billing: _billing(
              imageQuota: MobileImageQuota(
                used: 1,
                limit: 3,
                resetsAt: DateTime.utc(2026, 7, 1),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('600'), findsOneWidget);
      expect(find.text('credits available'), findsOneWidget);
      expect(find.textContaining('600 of 1,000 monthly credits left'), findsOneWidget);
      expect(find.textContaining('2 of 3 illustrated books left'), findsOneWidget);
      // And what free grants, so the reader is not left inferring the month's
      // size from what happens to be left of it.
      expect(
        find.text(
          'Free includes 1,000 credits and 3 illustrated books each month',
        ),
        findsOneWidget,
      );
    });

    testWidgets('a cancelled plan says when it ends, not when it renews', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          BillingPlanBanner(
            billing: _billing(
              tier: 'creator',
              productSku: 'tomeza.creator_monthly',
              planCredits: 4200,
              monthlyCredits: 6000,
              cancelAtPeriodEnd: true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The date is formatted in the device's timezone, so only the shape of the
      // line is asserted here.
      expect(find.textContaining('then Free'), findsOneWidget);
      expect(find.textContaining('Renews'), findsNothing);
    });

    testWidgets('says plainly when the image budget is gone', (tester) async {
      await tester.pumpWidget(
        _wrap(
          BillingPlanBanner(
            billing: _billing(
              imageQuota: MobileImageQuota(
                used: 3,
                limit: 3,
                resetsAt: DateTime.utc(2026, 7, 1),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Illustrated books used up'), findsOneWidget);
    });
  });

  group('account plan card', () {
    testWidgets('a free reader is offered the upgrade', (tester) async {
      await tester.pumpWidget(
        _wrap(
          AccountPlanCard(
            billing: AsyncData(
              _billing(
                imageQuota: MobileImageQuota(
                  used: 3,
                  limit: 3,
                  resetsAt: DateTime.utc(2026, 7, 1),
                ),
              ),
            ),
            onUpgrade: () {},
            onManageSubscription: (_) {},
            onCancelSubscription: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Free plan'), findsOneWidget);
      expect(find.text('3 of 3 illustrated books used this month'), findsOneWidget);
      expect(
        find.text(
          'Free includes 1000 credits and 3 illustrated books each month',
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('account-upgrade-plan')), findsOneWidget);
      expect(find.byKey(const ValueKey('account-manage-subscription')), findsNothing);
      // Nothing to cancel on free.
      expect(find.byKey(const ValueKey('account-cancel-subscription')), findsNothing);
    });

    testWidgets('a subscriber gets the renewal date and a way out', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          AccountPlanCard(
            billing: AsyncData(
              _billing(
                tier: 'max',
                productSku: 'tomeza.max_monthly',
                planCredits: 74000,
                monthlyCredits: 80000,
              ),
            ),
            onUpgrade: () {},
            onManageSubscription: (_) {},
            onCancelSubscription: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Max plan'), findsOneWidget);
      expect(find.text('74000 of 80000 monthly credits left'), findsOneWidget);
      expect(find.textContaining('Renews'), findsOneWidget);
      // Cancelling belongs to Play, so the card sends them there rather than
      // pretending the app can do it.
      expect(find.byKey(const ValueKey('account-manage-subscription')), findsOneWidget);
      expect(find.byKey(const ValueKey('account-upgrade-plan')), findsNothing);
      expect(find.byKey(const ValueKey('account-cancel-subscription')), findsOneWidget);
    });

    testWidgets('a subscriber below the top tier is offered an upgrade', (
      tester,
    ) async {
      var upgradeTaps = 0;
      await tester.pumpWidget(
        _wrap(
          AccountPlanCard(
            billing: AsyncData(
              _billing(
                tier: 'creator',
                productSku: 'tomeza.creator_monthly',
                planCredits: 4200,
                monthlyCredits: 6000,
              ),
            ),
            onUpgrade: () => upgradeTaps += 1,
            onManageSubscription: (_) {},
            onCancelSubscription: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();

      final upgrade = find.byKey(const ValueKey('account-upgrade-plan'));
      expect(upgrade, findsOneWidget);
      expect(find.text('Upgrade plan'), findsOneWidget);
      await tester.tap(upgrade);
      expect(upgradeTaps, 1);
      expect(
        find.byKey(const ValueKey('account-manage-subscription')),
        findsOneWidget,
      );
    });

    testWidgets('a cancelled subscriber is told when they drop to free', (
      tester,
    ) async {
      var cancelTaps = 0;
      await tester.pumpWidget(
        _wrap(
          AccountPlanCard(
            billing: AsyncData(
              _billing(
                tier: 'creator',
                productSku: 'tomeza.creator_monthly',
                planCredits: 4200,
                monthlyCredits: 6000,
                cancelAtPeriodEnd: true,
              ),
            ),
            onUpgrade: () {},
            onManageSubscription: (_) {},
            onCancelSubscription: (_) => cancelTaps += 1,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('you move to Free then'), findsOneWidget);
      expect(find.textContaining('Renews'), findsNothing);
      // Cancelling twice is not a thing; the way back is the only thing left.
      expect(find.byKey(const ValueKey('account-cancel-subscription')), findsNothing);
      expect(find.byKey(const ValueKey('account-resume-subscription')), findsOneWidget);
      expect(cancelTaps, 0);
    });
  });

  group('free plan card', () {
    testWidgets('states what free grants rather than what is left', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          const BillingFreePlanCard(
            freeTier: MobileFreeTier(),
            isCurrentPlan: true,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('1,000 credits every month'), findsOneWidget);
      expect(find.text('3 illustrated books a month'), findsOneWidget);
      expect(find.text('YOUR PLAN'), findsOneWidget);
      // No way down from the bottom rung.
      expect(find.byKey(const ValueKey('paywall-switch-to-free')), findsNothing);
    });

    testWidgets('is the way down from a paid plan', (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        _wrap(
          BillingFreePlanCard(
            freeTier: const MobileFreeTier(
              monthlyCredits: 1500,
              illustratedBooksPerMonth: 2,
            ),
            isCurrentPlan: false,
            onSwitchToFree: () => taps += 1,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The operator's numbers, not the client's defaults.
      expect(find.text('1,500 credits every month'), findsOneWidget);
      expect(find.text('2 illustrated books a month'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('paywall-switch-to-free')));
      expect(taps, 1);
    });
  });

  group('billing model', () {
    test('an older server payload without plan fields still reads as free', () {
      final billing = MobileBilling.fromJson({
        'credits': {
          'available': 500,
          'reserved': 0,
          'lifetimeGranted': 500,
          'lifetimeSpent': 0,
        },
        'entitlements': <dynamic>[],
        'products': <dynamic>[],
        'creditCosts': <String, dynamic>{},
      });

      expect(billing.planTier, 'free');
      expect(billing.isPaidPlan, isFalse);
      // No quota is not the same as an exhausted one — it must not block anyone.
      expect(billing.isImageQuotaExhausted, isFalse);
      expect(billing.credits.purchased, 0);
    });

    test('any paid tier unlocks manuscript import', () {
      for (final tier in ['creator', 'pro', 'max']) {
        expect(_billing(tier: tier).hasCreatorSubscription, isTrue, reason: tier);
      }
      expect(_billing().hasCreatorSubscription, isFalse);
    });
  });
}
