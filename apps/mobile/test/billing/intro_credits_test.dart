import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';
import 'package:tomeza/features/billing/presentation/billing_product_option.dart';

/// The intro month grants fewer credits than the plan renews with (4,000
/// against Creator's 6,000), and the rows beside the $9.99 intro price said
/// "6,000 credits every month".
const _creator = MobileBillingProduct(
  sku: 'tomeza.creator_monthly',
  title: 'Creator',
  description: '',
  productType: 'SUBSCRIPTION',
  creditAmount: 6000,
  priceMicros: 19990000,
  currency: 'USD',
  billingPeriod: 'P1M',
  introOfferId: 'creator-intro-first-month',
  introOfferCredits: 4000,
);

const _intro = StoreIntroOffer(
  offerId: 'creator-intro-first-month',
  price: r'$9.99',
  billingPeriod: 'P1M',
  cycles: 1,
);

const _eligible = StoreProduct(
  id: 'tomeza.creator_monthly',
  title: 'Creator',
  description: '',
  price: r'$19.99',
  rawPrice: 19.99,
  currencyCode: 'USD',
  offers: [_intro],
);

/// Play leaves the offer out for an account it is not eligible for.
const _ineligible = StoreProduct(
  id: 'tomeza.creator_monthly',
  title: 'Creator',
  description: '',
  price: r'$19.99',
  rawPrice: 19.99,
  currencyCode: 'USD',
);

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

void main() {
  test('the intro period states its own credits, then the plan\'s', () {
    expect(
      planCreditsLine(_creator, _intro),
      '4,000 credits the first month, then 6,000 / month',
    );
    expect(
      planCreditsLine(_creator, _intro, per: 'every'),
      '4,000 credits the first month, then 6,000 every month',
    );
    // No offer sold, or a server that does not say: the plan's own number.
    expect(planCreditsLine(_creator, null), '6,000 credits / month');
    const unsaid = MobileBillingProduct(
      sku: 'tomeza.creator_monthly',
      title: 'Creator',
      description: '',
      productType: 'SUBSCRIPTION',
      creditAmount: 6000,
      priceMicros: 19990000,
      currency: 'USD',
      introOfferId: 'creator-intro-first-month',
    );
    expect(planCreditsLine(unsaid, _intro), '6,000 credits / month');
  });

  testWidgets('a plan row sold through the intro offer', (tester) async {
    await tester.pumpWidget(
      _wrap(
        BillingProductOption(
          product: _creator,
          storeProduct: _eligible,
          selected: true,
          isCurrent: false,
          detailed: true,
          onSelect: () {},
        ),
      ),
    );

    expect(find.text(r'$9.99'), findsOneWidget);
    expect(
      find.text('4,000 credits the first month, then 6,000 / month'),
      findsOneWidget,
    );
    expect(find.text('6,000 credits / month'), findsNothing);
  });

  testWidgets('a plan row for an account Play offers no intro', (tester) async {
    await tester.pumpWidget(
      _wrap(
        BillingProductOption(
          product: _creator,
          storeProduct: _ineligible,
          selected: true,
          isCurrent: false,
          onSelect: () {},
        ),
      ),
    );

    expect(find.text(r'$19.99'), findsOneWidget);
    expect(find.text('6,000 credits / month'), findsOneWidget);
  });

  testWidgets('a plan card sold through the intro offer', (tester) async {
    await tester.pumpWidget(
      _wrap(
        BillingPlanCard(
          product: _creator,
          storeProduct: _eligible,
          isCurrentPlan: false,
          pending: false,
          onBuy: () {},
        ),
      ),
    );

    expect(
      find.text('4,000 credits the first month, then 6,000 every month'),
      findsOneWidget,
    );
    expect(find.text('6,000 credits every month'), findsNothing);
    expect(find.text(r'Then $19.99 per month'), findsOneWidget);
  });

  testWidgets('a row Play gave no price for shows none of ours either', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        BillingProductOption(
          product: _creator,
          storeProduct: null,
          selected: false,
          isCurrent: false,
          onSelect: () {},
        ),
      ),
    );

    expect(find.text('Unavailable'), findsOneWidget);
    expect(find.textContaining('USD'), findsNothing);
    expect(find.textContaining(r'$'), findsNothing);
  });
}
