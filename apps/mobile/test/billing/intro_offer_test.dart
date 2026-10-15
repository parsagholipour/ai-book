import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_plan_tiles.dart';

import 'billing_paywall_harness.dart';

const _introId = 'creator-intro-first-month';

PricingPhaseWrapper _phase(String price, int micros, int cycles) =>
    PricingPhaseWrapper(
      billingCycleCount: cycles,
      billingPeriod: 'P1M',
      formattedPrice: price,
      priceAmountMicros: micros,
      priceCurrencyCode: 'USD',
      recurrenceMode: cycles == 0
          ? RecurrenceMode.infiniteRecurring
          : RecurrenceMode.finiteRecurring,
    );

/// Creator as Play lists it to an eligible account: the base plan, the intro
/// offer, and a free trial this app never sells — in the order given.
List<GooglePlayProductDetails> _creatorEntries({bool introFirst = false}) {
  final base = SubscriptionOfferDetailsWrapper(
    basePlanId: 'monthly',
    offerTags: const [],
    offerIdToken: 'base-token',
    pricingPhases: [_phase(r'$19.99', 19990000, 0)],
  );
  final intro = SubscriptionOfferDetailsWrapper(
    basePlanId: 'monthly',
    offerId: _introId,
    offerTags: const [],
    offerIdToken: 'intro-token',
    pricingPhases: [
      _phase(r'$9.99', 9990000, 1),
      _phase(r'$19.99', 19990000, 0),
    ],
  );
  final trial = SubscriptionOfferDetailsWrapper(
    basePlanId: 'monthly',
    offerId: 'free-week',
    offerTags: const [],
    offerIdToken: 'trial-token',
    pricingPhases: [_phase('Free', 0, 1), _phase(r'$19.99', 19990000, 0)],
  );
  return GooglePlayProductDetails.fromProductDetails(
    ProductDetailsWrapper(
      description: 'Creator',
      name: 'Creator',
      productId: 'tomeza.creator_monthly',
      productType: ProductType.subs,
      title: 'Creator',
      subscriptionOfferDetails: introFirst
          ? [intro, trial, base]
          : [base, intro, trial],
    ),
  );
}

void main() {
  test('a plan Play lists with an offer is priced at its base plan', () {
    for (final introFirst in [false, true]) {
      final product = storeProductFromDetails(
        _creatorEntries(introFirst: introFirst),
      );

      expect(product.price, r'$19.99', reason: 'introFirst: $introFirst');
      expect(product.rawPrice, 19.99);
      expect(
        (product.source! as GooglePlayProductDetails).offerToken,
        'base-token',
      );
      // The trial is left out: a free first phase is not something we sell.
      expect(product.offers.map((offer) => offer.offerId), [_introId]);
      final intro = product.offers.single;
      expect(intro.price, r'$9.99');
      expect(intro.termLabel, 'first month');
      expect(
        (intro.source! as GooglePlayProductDetails).offerToken,
        'intro-token',
      );
    }
  });

  test('an offer is shown with the price it renews at', () {
    final creator = fakeBilling(
      availableCredits: 0,
      creatorIntroOfferId: _introId,
    ).products.firstWhere((p) => p.sku == 'tomeza.creator_monthly');
    final store = storeProductFromDetails(_creatorEntries());

    expect(
      planPriceLine(creator, store),
      r'$9.99 first month, then $19.99 / month',
    );
    // Play leaves an offer out for an account it is not eligible for.
    final ineligible = StoreProduct(
      id: store.id,
      title: store.title,
      description: store.description,
      price: store.price,
      rawPrice: store.rawPrice,
      currencyCode: store.currencyCode,
    );
    expect(planPriceLine(creator, ineligible), r'$19.99 / month');
    // An offer the server does not name is never sold.
    final unnamed = fakeBilling(
      availableCredits: 0,
    ).products.firstWhere((p) => p.sku == 'tomeza.creator_monthly');
    expect(introOfferFor(unnamed, store), isNull);
    expect(planPriceLine(unnamed, store), r'$19.99 / month');
  });

  testWidgets('the paywall sells Creator through its intro offer', (
    tester,
  ) async {
    final store = _IntroOfferStore();
    final repository = FakeBillingRepository()
      ..billing = fakeBilling(
        availableCredits: 100,
        creatorIntroOfferId: _introId,
      );

    await tester.pumpWidget(testPaywall(store: store, repository: repository));
    await tester.pumpAndSettle();

    expect(find.textContaining(r'$9.99'), findsWidgets);
    expect(find.textContaining(r'Then $19.99 / month'), findsWidgets);

    await tester.tap(find.byKey(const ValueKey('paywall-checkout-buy')));
    await tester.pump();

    final bought = store.buyCalls.single.product;
    expect(bought.id, 'tomeza.creator_monthly');
    expect(bought.source, 'intro-details');
  });
}

/// The harness store, with Creator carrying an intro offer.
class _IntroOfferStore extends FakeStoreBillingClient {
  @override
  Future<StoreProductQueryResult> queryProducts(Set<String> productIds) async {
    final result = await super.queryProducts(productIds);
    return StoreProductQueryResult(
      products: [
        for (final product in result.products)
          product.id == 'tomeza.creator_monthly'
              ? StoreProduct(
                  id: product.id,
                  title: product.title,
                  description: product.description,
                  price: product.price,
                  rawPrice: product.rawPrice,
                  currencyCode: product.currencyCode,
                  source: 'base-details',
                  offers: const [
                    StoreIntroOffer(
                      offerId: _introId,
                      price: r'$9.99',
                      billingPeriod: 'P1M',
                      cycles: 1,
                      source: 'intro-details',
                    ),
                  ],
                )
              : product,
      ],
      notFoundIds: result.notFoundIds,
    );
  }
}
