import 'package:flutter/material.dart';

import '../domain/billing_models.dart';

/// The visual identity of one plan tier, and the arithmetic that ranks the
/// tiers against each other.
///
/// A ladder only reads as a ladder if the rungs look different, so each tier
/// takes a different accent — entry blue, brand teal for the one most people
/// should land on, gold for the top — rather than repeating the same primary
/// three times.
///
/// Only the top rung's gold is spelled out here. The other two are scheme
/// roles, but `secondary` is also what every tonal control in the app is
/// painted with, so gold cannot live there without turning up on buttons that
/// mean nothing by it.
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
    'max' => _gold(colors).accent,
    _ => colors.onSurfaceVariant,
  };

  Color onAccent(ColorScheme colors) => switch (tier) {
    'creator' => colors.onTertiary,
    'pro' => colors.onPrimary,
    'max' => _gold(colors).onAccent,
    _ => colors.surface,
  };

  Color accentContainer(ColorScheme colors) => switch (tier) {
    'creator' => colors.tertiaryContainer,
    'pro' => colors.primaryContainer,
    'max' => _gold(colors).container,
    _ => colors.surfaceContainerHigh,
  };

  Color onAccentContainer(ColorScheme colors) => switch (tier) {
    'creator' => colors.onTertiaryContainer,
    'pro' => colors.onPrimaryContainer,
    'max' => _gold(colors).onContainer,
    _ => colors.onSurface,
  };
}

({Color accent, Color onAccent, Color container, Color onContainer}) _gold(
  ColorScheme colors,
) {
  return colors.brightness == Brightness.light
      ? (
          accent: const Color(0xFF8A5A1F),
          onAccent: Colors.white,
          container: const Color(0xFFF7E7CB),
          onContainer: const Color(0xFF4E3005),
        )
      : (
          accent: const Color(0xFFE5C186),
          onAccent: const Color(0xFF3F2C08),
          container: const Color(0xFF5A4423),
          onContainer: const Color(0xFFF7E3C2),
        );
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
    tagline: 'For a book every week or so',
    emblem: Icons.edit_note_outlined,
  ),
  'pro': BillingTierStyle(
    tier: 'pro',
    tagline: 'For several books a week',
    emblem: Icons.workspace_premium_outlined,
  ),
  'max': BillingTierStyle(
    tier: 'max',
    tagline: 'For a few books a day',
    emblem: Icons.diamond_outlined,
  ),
};

/// The tier a subscription SKU grants. Mirrors `PLAN_TIER_BY_SKU` on the server;
/// anything else — a credit pack — is not a tier at all.
String billingTierForSku(String sku) => switch (sku) {
  'tomeza.creator_monthly' => 'creator',
  'tomeza.creator_yearly' => 'creator',
  'tomeza.pro_monthly' => 'pro',
  'tomeza.max_monthly' => 'max',
  _ => 'free',
};

BillingTierStyle billingTierStyleForTier(String tier) =>
    _tierStyles[tier] ?? _freeStyle;

/// The tier's name as the reader knows it. Mirrors
/// `MobileSubscriptionPlan.label`, for the places that have a tier string and
/// no plan object in hand.
String billingTierLabel(String tier) => switch (tier) {
  'creator' => 'Creator',
  'pro' => 'Pro',
  'max' => 'Max',
  _ => 'Free',
};

/// The rung directly above the one this account is on.
///
/// "Upgrade" is a direction, not a shelf: someone on Creator who ran out of
/// credits wants Pro, and sending them to the top of a ladder they are already
/// halfway up makes them find it themselves. Null on the top tier, where there
/// is nothing above — the only honest answer there is the ladder itself.
MobileBillingProduct? nextBetterPlan(
  List<MobileBillingProduct> plans,
  String currentTier,
) {
  final current = planTierOrder.indexOf(currentTier);
  MobileBillingProduct? next;
  var nextRank = planTierOrder.length;
  for (final plan in plans) {
    final rank = planTierOrder.indexOf(billingTierForSku(plan.sku));
    if (rank > current && rank < nextRank) {
      next = plan;
      nextRank = rank;
    }
  }
  return next;
}

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
    // What one payment buys in all against its price: twelve monthly grants
    // for a yearly plan.
    final credits = plan.creditAmount;
    if (price <= 0 || credits <= 0) {
      return BillingPlanValue.empty;
    }
    final rate = credits / price;
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

/// Whether [product] is the plan the reader holds now. By SKU whenever the
/// server names the held one, so a monthly Creator can still choose Creator
/// yearly; by tier only for a plan whose SKU is unknown.
bool isHeldPlan(MobileBillingProduct product, MobileBilling? billing) {
  if (!product.isSubscription) return false;
  final heldSku = billing?.plan?.productSku;
  if (heldSku != null) return product.sku == heldSku;
  return billingTierForSku(product.sku) == billing?.planTier;
}
