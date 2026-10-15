import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:tomeza/features/billing/data/google_play_billing_client.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/presentation/billing_tier_style.dart';

void main() {
  test('only a lower tier or a shorter term is a downgrade', () {
    expect(
      isPlanDowngrade('tomeza.max_monthly', 'tomeza.creator_monthly'),
      isTrue,
    );
    expect(isPlanDowngrade('tomeza.max_monthly', 'tomeza.pro_monthly'), isTrue);
    expect(
      isPlanDowngrade('tomeza.pro_monthly', 'tomeza.creator_yearly'),
      isTrue,
    );
    expect(
      isPlanDowngrade('tomeza.creator_yearly', 'tomeza.creator_monthly'),
      isTrue,
    );
    expect(
      isPlanDowngrade('tomeza.creator_monthly', 'tomeza.creator_yearly'),
      isFalse,
    );
    expect(
      isPlanDowngrade('tomeza.creator_monthly', 'tomeza.max_monthly'),
      isFalse,
    );
    expect(
      isPlanDowngrade('tomeza.unknown', 'tomeza.creator_monthly'),
      isFalse,
    );
  });

  test('ranks plans by the same tiers the paywall shows', () {
    const plans = [
      'tomeza.creator_monthly',
      'tomeza.creator_yearly',
      'tomeza.pro_monthly',
      'tomeza.max_monthly',
    ];
    for (final from in plans) {
      for (final to in plans) {
        final rankFrom = planTierOrder.indexOf(billingTierForSku(from));
        final rankTo = planTierOrder.indexOf(billingTierForSku(to));
        if (rankFrom != rankTo) {
          expect(
            isPlanDowngrade(from, to),
            rankTo < rankFrom,
            reason: '$from -> $to',
          );
        }
      }
    }
  });

  test(
    'prices a purchase at the phase it buys: an intro offer, a base plan, a pack',
    () {
      PricingPhaseWrapper phase(int micros, int cycles) => PricingPhaseWrapper(
        billingCycleCount: cycles,
        billingPeriod: 'P1M',
        formattedPrice: '$micros',
        priceAmountMicros: micros,
        priceCurrencyCode: 'EUR',
        recurrenceMode: cycles == 0
            ? RecurrenceMode.infiniteRecurring
            : RecurrenceMode.finiteRecurring,
      );
      final entries = GooglePlayProductDetails.fromProductDetails(
        ProductDetailsWrapper(
          description: 'Creator',
          name: 'Creator',
          productId: 'tomeza.creator_monthly',
          productType: ProductType.subs,
          title: 'Creator',
          subscriptionOfferDetails: [
            SubscriptionOfferDetailsWrapper(
              basePlanId: 'monthly',
              offerTags: const [],
              offerIdToken: 'base-token',
              pricingPhases: [phase(18990000, 0)],
            ),
            SubscriptionOfferDetailsWrapper(
              basePlanId: 'monthly',
              offerId: 'creator-intro-first-month',
              offerTags: const [],
              offerIdToken: 'intro-token',
              pricingPhases: [phase(9490000, 1), phase(18990000, 0)],
            ),
          ],
        ),
      );
      expect(storePriceOf(entries[0]), (micros: 18990000, currency: 'EUR'));
      expect(storePriceOf(entries[1]), (micros: 9490000, currency: 'EUR'));

      final packEntry = GooglePlayProductDetails.fromProductDetails(
        const ProductDetailsWrapper(
          description: 'Pack',
          name: 'Pack',
          productId: 'tomeza.credit_pack_1',
          productType: ProductType.inapp,
          title: 'Pack',
          oneTimePurchaseOfferDetails: OneTimePurchaseOfferDetailsWrapper(
            formattedPrice: '¥1,200',
            priceAmountMicros: 1200000000,
            priceCurrencyCode: 'JPY',
          ),
        ),
      ).single;
      expect(storePriceOf(packEntry), (micros: 1200000000, currency: 'JPY'));
    },
  );

  test(
    'reads the intro offer\'s credits and a scheduled plan change off the payload',
    () {
      final product = MobileBillingProduct.fromJson({
        'sku': 'tomeza.creator_monthly',
        'title': 'Creator',
        'description': '',
        'productType': 'SUBSCRIPTION',
        'creditAmount': 6000,
        'priceMicros': 19990000,
        'currency': 'USD',
        'introOfferId': 'creator-intro-first-month',
        'introOfferCredits': 4000,
      });
      expect(product.introOfferCredits, 4000);
      final plan = MobileSubscriptionPlan.fromJson({
        'tier': 'max',
        'source': 'google_play',
        'productSku': 'tomeza.max_monthly',
        'pendingChange': {
          'productSku': 'tomeza.creator_monthly',
          'startsAt': '2026-11-04T00:00:00.000Z',
        },
      });
      expect(plan.pendingChangeSku, 'tomeza.creator_monthly');
      expect(plan.pendingChangeAt, DateTime.utc(2026, 11, 4));
      expect(
        MobileSubscriptionPlan.fromJson({
          'tier': 'max',
          'source': 'google_play',
        }).pendingChangeSku,
        isNull,
      );
    },
  );
}
