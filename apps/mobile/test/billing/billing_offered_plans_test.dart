import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_tier_style.dart';

import 'billing_paywall_harness.dart';

MobileBillingProduct max({required bool offered}) => MobileBillingProduct(
  sku: 'tomeza.max_monthly',
  title: 'Max',
  description: '',
  productType: 'SUBSCRIPTION',
  creditAmount: 80000,
  priceMicros: 199990000,
  currency: 'USD',
  offered: offered,
);

void main() {
  testWidgets('a plan the server does not offer stays off the paywall', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository()
      ..billing = fakeBilling(
        availableCredits: 100,
        extraProducts: [max(offered: false)],
      );

    await tester.pumpWidget(testPaywall(store: store, repository: repository));
    await tester.pumpAndSettle();

    expect(find.text('Creator'), findsOneWidget);
    expect(find.text('Max'), findsNothing);
  });

  testWidgets('an offered plan is listed', (tester) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository()
      ..billing = fakeBilling(
        availableCredits: 100,
        extraProducts: [max(offered: true)],
      );

    await tester.pumpWidget(testPaywall(store: store, repository: repository));
    await tester.pumpAndSettle();

    expect(find.text('Max'), findsOneWidget);
  });

  yearlyPlanTests();
}

/// Creator yearly as the server sends it: 72,000 for the payment, granted
/// 6,000 at the start of each month.
MobileBillingProduct creatorYearly() => const MobileBillingProduct(
  sku: 'tomeza.creator_yearly',
  title: 'Creator yearly',
  description: '',
  productType: 'SUBSCRIPTION',
  creditAmount: 72000,
  monthlyCreditAmount: 6000,
  priceMicros: 179990000,
  currency: 'USD',
  billingPeriod: 'P1Y',
);

void yearlyPlanTests() {
  testWidgets('a yearly plan is priced by the year and granted by the month', (
    tester,
  ) async {
    final store = FakeStoreBillingClient();
    final repository = FakeBillingRepository()
      ..billing = fakeBilling(
        availableCredits: 100,
        extraProducts: [creatorYearly()],
      );

    await tester.pumpWidget(testPaywall(store: store, repository: repository));
    await tester.pumpAndSettle();

    expect(find.text('Creator yearly'), findsOneWidget);
    // 6,000 credits each month of the paid year, never the year's total at
    // once.
    expect(find.text('6,000 credits / month, billed yearly'), findsOneWidget);
    expect(find.textContaining('72,000'), findsNothing);
    expect(find.text('/ year'), findsOneWidget);
  });

  test('the monthly grant is the server\'s monthlyCreditAmount', () {
    final yearly = MobileBillingProduct.fromJson(const {
      'sku': 'tomeza.creator_yearly',
      'title': 'Creator yearly',
      'description': '6,000 credits every month, billed yearly.',
      'productType': 'SUBSCRIPTION',
      'creditAmount': 72000,
      'monthlyCreditAmount': 6000,
      'priceMicros': 179990000,
      'currency': 'USD',
      'billingPeriod': 'P1Y',
    });
    expect(yearly.creditsPerGrant, 6000);
    // What one payment buys in all, which value per price compares.
    expect(yearly.creditAmount, 72000);
    expect(yearly.benefitLabel, '6,000 credits every month, billed yearly');

    final pack = MobileBillingProduct.fromJson(const {
      'sku': 'tomeza.credit_pack_1',
      'title': 'One extra credit',
      'description': '',
      'productType': 'CREDIT_PACK',
      'creditAmount': 1000,
      'monthlyCreditAmount': null,
      'priceMicros': 7990000,
      'currency': 'USD',
    });
    expect(pack.creditsPerGrant, 1000);
  });

  test('a server from before the field: a twelfth of a yearly plan', () {
    const older = MobileBillingProduct(
      sku: 'tomeza.creator_yearly',
      title: 'Creator yearly',
      description: '',
      productType: 'SUBSCRIPTION',
      creditAmount: 72000,
      priceMicros: 179990000,
      currency: 'USD',
      billingPeriod: 'P1Y',
    );
    expect(older.creditsPerGrant, 6000);
    const monthly = MobileBillingProduct(
      sku: 'tomeza.creator_monthly',
      title: 'Creator',
      description: '',
      productType: 'SUBSCRIPTION',
      creditAmount: 6000,
      priceMicros: 19990000,
      currency: 'USD',
      billingPeriod: 'P1M',
    );
    expect(monthly.creditsPerGrant, 6000);
  });

  testWidgets('a monthly Creator can still choose Creator yearly', (
    tester,
  ) async {
    expect(
      isHeldPlan(
        creatorYearly(),
        fakeBilling(availableCredits: 100, planTier: 'creator'),
      ),
      isFalse,
    );
    final monthly = fakeBilling(
      availableCredits: 100,
      planTier: 'creator',
    ).products.firstWhere((product) => product.sku == 'tomeza.creator_monthly');
    expect(
      isHeldPlan(
        monthly,
        fakeBilling(availableCredits: 100, planTier: 'creator'),
      ),
      isTrue,
    );
  });
}
