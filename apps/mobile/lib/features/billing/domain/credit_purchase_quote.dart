import 'dart:math' as math;

import 'billing_models.dart';

/// Formats an amount in the currency the store already localized for this
/// reader.
///
/// Two packs is a number we compute, and the decoration around it is not ours
/// to invent: a total reading "USD 29.98" under a price reading "€14,99" is how
/// a sheet stops being believed. So the symbol, the side it sits on and the
/// decimal mark are all lifted from a price string the store handed us, and a
/// currency code is only the fallback when there is no such string.
class MoneyFormat {
  const MoneyFormat({
    this.prefix = '',
    this.suffix = '',
    this.decimalSeparator = '.',
  });

  factory MoneyFormat.fromStorePrice(String? price, {String? currencyCode}) {
    final digits = price == null
        ? null
        // A digit run that ends on a digit, so a trailing " €" stays in the
        // suffix. Spaces belong inside it: several locales group thousands with
        // one, including a non-breaking one.
        : RegExp('\\d[\\d.,\u00A0 ]*\\d|\\d').firstMatch(price);
    if (price == null || digits == null) {
      final code = (currencyCode ?? '').trim();
      return MoneyFormat(prefix: code.isEmpty ? '' : '$code ');
    }
    // A separator with one or two digits behind it is a decimal mark; one with
    // three is how the rest of the world groups thousands.
    final decimals = RegExp(r'([.,])\d{1,2}$').firstMatch(digits.group(0)!);
    return MoneyFormat(
      prefix: price.substring(0, digits.start),
      suffix: price.substring(digits.end),
      decimalSeparator: decimals?.group(1) ?? '.',
    );
  }

  final String prefix;
  final String suffix;
  final String decimalSeparator;

  String format(double amount) {
    final digits = amount.toStringAsFixed(2).replaceAll('.', decimalSeparator);
    return '$prefix$digits$suffix';
  }
}

/// One credit product, priced in the reader's own currency.
class CreditPurchaseOption {
  const CreditPurchaseOption({
    required this.product,
    required this.unitPrice,
    required this.unitLabel,
  });

  final MobileBillingProduct product;

  /// Price of one, as a number in the quote's currency.
  final double unitPrice;

  /// What the store calls that price. A single purchase is shown with this
  /// rather than re-formatted, because the store said it best.
  final String unitLabel;

  int get credits => product.creditAmount;

  double get pricePerCredit =>
      credits <= 0 ? double.infinity : unitPrice / credits;

  /// How many of these it takes to reach [wanted].
  int quantityFor(int wanted) =>
      credits <= 0 ? 1 : math.max(1, (wanted + credits - 1) ~/ credits);
}

/// What "I want this many credits" costs in the products actually on sale.
class CreditQuote {
  const CreditQuote({
    required this.credits,
    required this.options,
    required this.money,
    this.best,
    this.quantity = 1,
    this.betterPlan,
    this.betterPlanPrice,
  });

  /// What was asked for.
  final int credits;

  /// Everything on sale, best value first.
  final List<CreditPurchaseOption> options;

  final MoneyFormat money;

  /// The cheapest single purchase that covers [credits], or the best value on
  /// offer when nothing on the shelf reaches that far.
  final CreditPurchaseOption? best;

  /// How many of [best] the request takes. Above one only when it outgrew the
  /// largest pack — a store sells one at a time, so the sheet says so rather
  /// than quietly charging twice.
  final int quantity;

  /// A plan that delivers at least this many credits every month for less than
  /// this purchase costs once. Worth saying out loud even though it is not the
  /// sale the reader came for.
  final MobileBillingProduct? betterPlan;
  final double? betterPlanPrice;

  bool get isEmpty => best == null;

  int get creditsDelivered => best == null ? 0 : best!.credits * quantity;

  double get total => best == null ? 0 : best!.unitPrice * quantity;

  /// Credits beyond what was asked for. Never negative: [quantity] covers.
  int get surplus => math.max(0, creditsDelivered - credits);

  /// The best price per credit on offer — what an arbitrary number of credits
  /// would cost if it could be bought exactly.
  double get bestRate => options.isEmpty ? 0 : options.first.pricePerCredit;

  /// The asked-for number priced at [bestRate]. The answer to "what would this
  /// cost", as opposed to "what can I buy", which is [best].
  String get estimateLabel => money.format(credits * bestRate);

  /// The price of the purchase itself: the store's own words for one, ours for
  /// several.
  String get totalLabel =>
      quantity == 1 && best != null ? best!.unitLabel : money.format(total);

  String get ratePerThousandLabel => money.format(bestRate * 1000);

  String? get betterPlanPriceLabel =>
      betterPlanPrice == null ? null : money.format(betterPlanPrice!);
}

/// Prices a request for [credits] against the catalogue.
///
/// Store prices and the server's catalogue prices are never mixed inside one
/// comparison — the rule `billingPlanValue` already follows — so one pack the
/// store could not answer for falls the whole quote back to catalogue prices
/// rather than ranking a localized price against a dollar one.
CreditQuote quoteCredits({
  required int credits,
  required List<MobileBillingProduct> products,
  required Map<String, StoreProduct> storeProducts,
  List<MobileBillingProduct> plans = const [],
}) {
  bool hasStorePrice(MobileBillingProduct product) =>
      (storeProducts[product.sku]?.rawPrice ?? 0) > 0;

  // Credit packs are what this sells. An export unlock also carries credits,
  // but it is a different promise, so it only stands in when there are no packs
  // at all rather than turning up as a third way to buy credits.
  final packs = products
      .where((product) => product.productType == 'CREDIT_PACK')
      .where((product) => product.creditAmount > 0)
      .toList();
  final sellable = packs.isNotEmpty
      ? packs
      : products
            .where((product) => product.isConsumable)
            .where((product) => product.creditAmount > 0)
            .toList();
  final useStore = sellable.isNotEmpty && sellable.every(hasStorePrice);

  double priceOf(MobileBillingProduct product) => useStore
      ? storeProducts[product.sku]!.rawPrice
      : product.priceMicros / 1000000;
  String labelOf(MobileBillingProduct product) {
    if (useStore) {
      return storeProducts[product.sku]!.price;
    }
    final price = (product.priceMicros / 1000000).toStringAsFixed(2);
    return '${product.currency} $price';
  }

  final money = MoneyFormat.fromStorePrice(
    useStore ? storeProducts[sellable.first.sku]!.price : null,
    currencyCode: sellable.isEmpty ? null : sellable.first.currency,
  );

  final options =
      sellable
          .map(
            (product) => CreditPurchaseOption(
              product: product,
              unitPrice: priceOf(product),
              unitLabel: labelOf(product),
            ),
          )
          .where((option) => option.unitPrice > 0)
          .toList()
        ..sort((a, b) => a.pricePerCredit.compareTo(b.pricePerCredit));

  if (options.isEmpty || credits <= 0) {
    return CreditQuote(credits: credits, options: options, money: money);
  }

  // Cheapest way to cover the request in one purchase; the closest fit wins a
  // tie, so nobody is sold 2,000 credits when 1,000 costs the same.
  final covering =
      options.where((option) => option.credits >= credits).toList()
        ..sort((a, b) {
          final byPrice = a.unitPrice.compareTo(b.unitPrice);
          return byPrice != 0 ? byPrice : a.credits.compareTo(b.credits);
        });
  final best = covering.isNotEmpty ? covering.first : options.first;
  final quantity = covering.isNotEmpty ? 1 : best.quantityFor(credits);
  final total = best.unitPrice * quantity;

  // Plans only join the comparison when their price comes from the same source
  // as the packs'.
  final planOptions =
      plans
          .where((plan) => plan.creditAmount >= credits)
          .where((plan) => !useStore || hasStorePrice(plan))
          .map(
            (plan) => CreditPurchaseOption(
              product: plan,
              unitPrice: priceOf(plan),
              unitLabel: labelOf(plan),
            ),
          )
          .where((option) => option.unitPrice > 0 && option.unitPrice < total)
          .toList()
        ..sort((a, b) => a.unitPrice.compareTo(b.unitPrice));

  return CreditQuote(
    credits: credits,
    options: options,
    money: money,
    best: best,
    quantity: quantity,
    betterPlan: planOptions.isEmpty ? null : planOptions.first.product,
    betterPlanPrice: planOptions.isEmpty ? null : planOptions.first.unitPrice,
  );
}
