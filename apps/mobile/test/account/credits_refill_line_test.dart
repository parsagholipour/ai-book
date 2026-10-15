import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/account/presentation/account_billing_copy.dart';
import 'package:tomeza/features/account/presentation/account_links.dart';
import 'package:tomeza/features/account/presentation/account_overview_card.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';

import '../billing/billing_paywall_harness.dart' show fakeBilling;

/// Creator yearly renews once a year and refills every month, so a surface
/// that says when credits next arrive reads `allowance.resetsAt` — the plan's
/// `renewsAt` is a year away and would read as a year's wait for credits.
void main() {
  final monthEnd = DateTime.utc(2026, 11, 1);
  final yearEnd = DateTime.utc(2027, 10, 15);

  MobileBilling subscriber({
    required String sku,
    required DateTime renewsAt,
    required DateTime resetsAt,
    bool cancelling = false,
  }) {
    final base = fakeBilling(availableCredits: 4000);
    return MobileBilling(
      purchaseAccountId: base.purchaseAccountId,
      credits: base.credits,
      entitlements: base.entitlements,
      products: base.products,
      creditCosts: base.creditCosts,
      plan: MobileSubscriptionPlan(
        tier: 'creator',
        source: 'google_play',
        status: 'active',
        productSku: sku,
        renewsAt: cancelling ? null : renewsAt,
        endsAt: cancelling ? renewsAt : null,
        cancelAtPeriodEnd: cancelling,
      ),
      allowance: MobileAllowance(
        monthlyCredits: 6000,
        planCredits: 4000,
        resetsAt: resetsAt,
      ),
    );
  }

  Future<BuildContext> pumpCard(
    WidgetTester tester,
    MobileBilling billing,
  ) async {
    late BuildContext captured;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              captured = context;
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
    return captured;
  }

  testWidgets('a yearly subscriber is told when the next month\'s credits '
      'arrive, beside the year\'s renewal', (tester) async {
    final context = await pumpCard(
      tester,
      subscriber(
        sku: 'tomeza.creator_yearly',
        renewsAt: yearEnd,
        resetsAt: monthEnd,
      ),
    );

    expect(
      find.text(
        'Credits refill ${formatAccountDate(context, monthEnd)} · '
        'Renews ${formatAccountDate(context, yearEnd)}',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a cancelled yearly plan still refills monthly until it ends', (
    tester,
  ) async {
    final context = await pumpCard(
      tester,
      subscriber(
        sku: 'tomeza.creator_yearly',
        renewsAt: yearEnd,
        resetsAt: monthEnd,
        cancelling: true,
      ),
    );

    expect(
      find.text(
        'Credits refill ${formatAccountDate(context, monthEnd)} · '
        'Ends ${formatAccountDate(context, yearEnd)}',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a monthly plan, whose refill is its renewal, says it once', (
    tester,
  ) async {
    final context = await pumpCard(
      tester,
      subscriber(
        sku: 'tomeza.creator_monthly',
        renewsAt: monthEnd,
        resetsAt: monthEnd,
      ),
    );

    expect(
      find.text('Renews ${formatAccountDate(context, monthEnd)}'),
      findsOneWidget,
    );
    expect(find.textContaining('Credits refill'), findsNothing);
  });

  testWidgets('the refill date is the allowance\'s, never the plan\'s', (
    tester,
  ) async {
    final billing = subscriber(
      sku: 'tomeza.creator_yearly',
      renewsAt: yearEnd,
      resetsAt: monthEnd,
    );
    final context = await pumpCard(tester, billing);

    expect(
      creditsRefillLine(context, billing),
      'Credits refill ${formatAccountDate(context, monthEnd)}',
    );
    expect(
      find.textContaining(
        'Credits refill ${formatAccountDate(context, yearEnd)}',
      ),
      findsNothing,
    );
  });
}
