import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/account/presentation/account_screen.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';

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
      status: tier == 'free' ? null : 'ACTIVE',
      renewsAt: tier == 'free' ? null : DateTime.utc(2026, 7, 15),
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
      expect(find.text(r'$199.99 / month'), findsOneWidget);
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

      expect(find.text('Current'), findsOneWidget);
      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull);
    });
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

      expect(find.textContaining('600 of 1000 monthly credits left'), findsOneWidget);
      expect(find.textContaining('2 of 3 illustrated books left'), findsOneWidget);
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
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Free plan'), findsOneWidget);
      expect(find.text('3 of 3 illustrated books used this month'), findsOneWidget);
      expect(find.byKey(const ValueKey('account-upgrade-plan')), findsOneWidget);
      expect(find.byKey(const ValueKey('account-manage-subscription')), findsNothing);
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
