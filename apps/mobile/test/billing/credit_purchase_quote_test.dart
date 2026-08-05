import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';
import 'package:tomeza/features/billing/domain/credit_purchase_quote.dart';

void main() {
  group('MoneyFormat', () {
    test('keeps the symbol and the side the store put it on', () {
      final dollars = MoneyFormat.fromStorePrice(r'$14.99');
      expect(dollars.format(29.98), r'$29.98');

      final euros = MoneyFormat.fromStorePrice('14,99 €');
      expect(euros.format(29.98), '29,98 €');

      final krona = MoneyFormat.fromStorePrice('149,00 kr');
      expect(krona.format(298.0), '298,00 kr');
    });

    test('a grouped thousand is not mistaken for a decimal mark', () {
      final grouped = MoneyFormat.fromStorePrice(r'$1,499.00');
      expect(grouped.format(2998), r'$2998.00');
    });

    test('falls back to the currency code when the store said nothing', () {
      final fallback = MoneyFormat.fromStorePrice(null, currencyCode: 'USD');
      expect(fallback.format(14.99), 'USD 14.99');
    });
  });

  group('quoteCredits', () {
    test('picks the cheapest pack that covers the request', () {
      final quote = quoteCredits(
        credits: 900,
        products: _products,
        storeProducts: const {},
      );

      expect(quote.best?.product.sku, 'tomeza.credit_pack_1');
      expect(quote.quantity, 1);
      expect(quote.creditsDelivered, 1000);
      expect(quote.surplus, 100);
      expect(quote.totalLabel, 'USD 7.99');
    });

    test('reaches for the bigger pack when the small one falls short', () {
      final quote = quoteCredits(
        credits: 1600,
        products: _products,
        storeProducts: const {},
      );

      expect(quote.best?.product.sku, 'tomeza.credit_pack_2');
      expect(quote.quantity, 1);
      expect(quote.surplus, 400);
    });

    test('says how many purchases a request past the top shelf takes', () {
      final quote = quoteCredits(
        credits: 3000,
        products: _products,
        storeProducts: const {},
        plans: _plans,
      );

      // Nothing on sale reaches 3,000, so the best value wins and the sheet
      // owes the reader the count rather than charging twice quietly.
      expect(quote.best?.product.sku, 'tomeza.credit_pack_2');
      expect(quote.quantity, 2);
      expect(quote.creditsDelivered, 4000);
      expect(quote.totalLabel, 'USD 29.98');
      // ...and at that point the ladder is simply cheaper.
      expect(quote.betterPlan?.sku, 'tomeza.creator_monthly');
      expect(quote.betterPlanPriceLabel, 'USD 19.99');
    });

    test('prices an arbitrary number at the best rate on offer', () {
      final quote = quoteCredits(
        credits: 3200,
        products: _products,
        storeProducts: const {},
      );

      // 2,000 credits for 14.99 is the best rate, so 3,200 is 3.2 × 7.495.
      expect(quote.ratePerThousandLabel, 'USD 7.50');
      expect(quote.estimateLabel, 'USD 23.98');
    });

    test('a plan that does not cover the request is not offered', () {
      final quote = quoteCredits(
        credits: 9000,
        products: _products,
        storeProducts: const {},
        plans: _plans,
      );

      expect(quote.quantity, 5);
      expect(quote.betterPlan, isNull);
    });

    test('store prices win, and one missing answer falls the lot back', () {
      final storeProducts = {
        'tomeza.credit_pack_1': _storeProduct('tomeza.credit_pack_1', 4.5),
        'tomeza.credit_pack_2': _storeProduct('tomeza.credit_pack_2', 8.0),
      };
      final localized = quoteCredits(
        credits: 900,
        products: _products,
        storeProducts: storeProducts,
      );
      expect(localized.totalLabel, r'$4.50');

      // Dropping one of them must not rank a localized price against a
      // catalogue one — the whole quote goes back to the catalogue.
      final partial = quoteCredits(
        credits: 900,
        products: _products,
        storeProducts: {'tomeza.credit_pack_1': storeProducts.values.first},
      );
      expect(partial.totalLabel, 'USD 7.99');
    });

    test('an empty catalogue quotes nothing rather than guessing', () {
      final quote = quoteCredits(
        credits: 900,
        products: const [],
        storeProducts: const {},
      );

      expect(quote.isEmpty, isTrue);
      expect(quote.creditsDelivered, 0);
    });
  });
}

const _products = [
  MobileBillingProduct(
    sku: 'tomeza.one_book_export',
    title: 'One book export',
    description: 'One standard export credit.',
    productType: 'ONE_TIME_UNLOCK',
    creditAmount: 1000,
    priceMicros: 9990000,
    currency: 'USD',
  ),
  MobileBillingProduct(
    sku: 'tomeza.credit_pack_1',
    title: 'One extra credit',
    description: 'One extra standard export credit.',
    productType: 'CREDIT_PACK',
    creditAmount: 1000,
    priceMicros: 7990000,
    currency: 'USD',
  ),
  MobileBillingProduct(
    sku: 'tomeza.credit_pack_2',
    title: 'Two extra credits',
    description: 'Two extra standard export credits.',
    productType: 'CREDIT_PACK',
    creditAmount: 2000,
    priceMicros: 14990000,
    currency: 'USD',
  ),
];

const _plans = [
  MobileBillingProduct(
    sku: 'tomeza.creator_monthly',
    title: 'Creator',
    description: 'Six thousand credits a month.',
    productType: 'SUBSCRIPTION',
    creditAmount: 6000,
    priceMicros: 19990000,
    currency: 'USD',
  ),
];

StoreProduct _storeProduct(String id, double price) {
  return StoreProduct(
    id: id,
    title: id,
    description: id,
    price: '\$${price.toStringAsFixed(2)}',
    rawPrice: price,
    currencyCode: 'USD',
  );
}
