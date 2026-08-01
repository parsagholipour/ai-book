import 'package:flutter/material.dart';

import '../domain/billing_models.dart';

/// The visual identity of one plan tier, and the arithmetic that ranks the
/// tiers against each other.
///
/// A ladder only reads as a ladder if the rungs look different, so each tier
/// borrows a different accent from the scheme — entry blue, brand teal for the
/// one most people should land on, gold for the top — rather than repeating the
/// same primary three times.
class BillingTierStyle {
  const BillingTierStyle({
    required this.tier,
    required this.tagline,
    required this.emblem,
  });

  final String tier;

  /// One line on who the tier is for. Sits directly under the name.
  final String tagline;
  final IconData emblem;

  Color accent(ColorScheme colors) => switch (tier) {
    'creator' => colors.tertiary,
    'pro' => colors.primary,
    'max' => colors.secondary,
    _ => colors.onSurfaceVariant,
  };

  Color onAccent(ColorScheme colors) => switch (tier) {
    'creator' => colors.onTertiary,
    'pro' => colors.onPrimary,
    'max' => colors.onSecondary,
    _ => colors.surface,
  };

  Color accentContainer(ColorScheme colors) => switch (tier) {
    'creator' => colors.tertiaryContainer,
    'pro' => colors.primaryContainer,
    'max' => colors.secondaryContainer,
    _ => colors.surfaceContainerHigh,
  };

  Color onAccentContainer(ColorScheme colors) => switch (tier) {
    'creator' => colors.onTertiaryContainer,
    'pro' => colors.onPrimaryContainer,
    'max' => colors.onSecondaryContainer,
    _ => colors.onSurface,
  };
}

const _freeStyle = BillingTierStyle(
  tier: 'free',
  tagline: 'A taste of what the app can write',
  emblem: Icons.auto_stories_outlined,
);

const _tierStyles = <String, BillingTierStyle>{
  'free': _freeStyle,
  'creator': BillingTierStyle(
    tier: 'creator',
    tagline: 'For the occasional book',
    emblem: Icons.edit_note_outlined,
  ),
  'pro': BillingTierStyle(
    tier: 'pro',
    tagline: 'For a book a week',
    emblem: Icons.workspace_premium_outlined,
  ),
  'max': BillingTierStyle(
    tier: 'max',
    tagline: 'For a book a day',
    emblem: Icons.diamond_outlined,
  ),
};

/// The tier a subscription SKU grants. Mirrors `PLAN_TIER_BY_SKU` on the server;
/// anything else — a credit pack, an export unlock — is not a tier at all.
String billingTierForSku(String sku) => switch (sku) {
  'tomeza.creator_monthly' => 'creator',
  'tomeza.pro_monthly' => 'pro',
  'tomeza.max_monthly' => 'max',
  _ => 'free',
};

BillingTierStyle billingTierStyleForTier(String tier) =>
    _tierStyles[tier] ?? _freeStyle;

BillingTierStyle billingTierStyleForSku(String sku) =>
    billingTierStyleForTier(billingTierForSku(sku));

/// How the plans on offer compare on credits per unit of currency.
///
/// Prices are operator-editable and Google Play localises them, so which rung is
/// the best deal is worked out from the numbers actually on screen rather than
/// pinned to a SKU. Play's prices and the server's fallback prices are never
/// mixed into one comparison: it uses one source for every plan, or none.
class BillingPlanValue {
  const BillingPlanValue({
    required this.bestValueSku,
    required this.savingsPercentBySku,
  });

  static const empty = BillingPlanValue(
    bestValueSku: null,
    savingsPercentBySku: <String, int>{},
  );

  /// The plan with the most credits per unit of currency, when it beats the
  /// entry plan by enough to be worth saying out loud.
  final String? bestValueSku;

  /// Percent saved per credit against the cheapest plan. Only entries worth
  /// showing are present.
  final Map<String, int> savingsPercentBySku;

  int? savingsFor(String sku) => savingsPercentBySku[sku];
}

/// Below this a "save 4%" badge is noise rather than a reason to move up.
const _minimumSavingsPercent = 5;

BillingPlanValue billingPlanValue(
  List<MobileBillingProduct> plans,
  Map<String, StoreProduct> storeProducts,
) {
  if (plans.length < 2) {
    return BillingPlanValue.empty;
  }
  final useStorePrices = plans.every(
    (plan) => (storeProducts[plan.sku]?.rawPrice ?? 0) > 0,
  );

  // Credits per unit of currency, and the price that produced it — the cheapest
  // plan is the baseline, because that is the rung someone starts on.
  final rates = <String, double>{};
  var baselinePrice = double.infinity;
  var baselineRate = 0.0;
  for (final plan in plans) {
    final price = useStorePrices
        ? storeProducts[plan.sku]!.rawPrice
        : plan.priceMicros / 1000000;
    if (price <= 0 || plan.creditAmount <= 0) {
      return BillingPlanValue.empty;
    }
    final rate = plan.creditAmount / price;
    rates[plan.sku] = rate;
    if (price < baselinePrice) {
      baselinePrice = price;
      baselineRate = rate;
    }
  }
  if (baselineRate <= 0) {
    return BillingPlanValue.empty;
  }

  final savings = <String, int>{};
  String? bestSku;
  var bestRate = baselineRate;
  for (final entry in rates.entries) {
    final percent = ((1 - baselineRate / entry.value) * 100).round();
    if (percent >= _minimumSavingsPercent) {
      savings[entry.key] = percent;
    }
    if (entry.value > bestRate) {
      bestRate = entry.value;
      bestSku = entry.key;
    }
  }

  return BillingPlanValue(
    bestValueSku: savings.containsKey(bestSku) ? bestSku : null,
    savingsPercentBySku: savings,
  );
}
