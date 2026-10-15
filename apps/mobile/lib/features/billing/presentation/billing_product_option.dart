import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart';
import 'billing_shared_parts.dart';
import 'billing_tier_style.dart';

/// One choice in a plan or credit-pack list: a radio, what it is, what it
/// gives, and the price.
///
/// Selecting only marks the row; the purchase happens from the checkout bar, so
/// a stray tap never opens Google Play. The selected row differs by shape (a
/// filled check where the others have an empty ring), by border weight and by
/// fill, so it does not depend on colour alone.
///
/// [detailed] adds the line saying who a plan is for. The export offer leaves it
/// off: there every plan does the same thing and the sheet has to fit three of
/// them beside a checkout bar on a small phone.
class BillingProductOption extends StatelessWidget {
  const BillingProductOption({
    required this.product,
    required this.storeProduct,
    required this.selected,
    required this.isCurrent,
    this.format,
    this.bestValue = false,
    this.recommendation,
    this.savingsPercent,
    this.detailed = false,
    this.creditCosts,
    required this.onSelect,
    super.key,
  });

  final MobileBillingProduct product;
  final StoreProduct? storeProduct;
  final bool selected;
  final bool isCurrent;
  final String? format;
  final String? recommendation;
  final bool bestValue;

  /// Percent more credits per unit of currency than the entry plan, when it is
  /// worth saying. Comes from `billingPlanValue`, never computed here.
  final int? savingsPercent;
  final bool detailed;

  /// The live price list. With it, a plan says how many books its credits buy
  /// rather than who it is for.
  final Map<String, dynamic>? creditCosts;
  final VoidCallback? onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final style = billingTierStyleForSku(product.sku);
    final badge = isCurrent
        ? 'Your plan'
        : storeProduct == null
        ? 'Unavailable'
        : recommendation ??
              (format != null && style.tier == 'creator'
                  ? 'Start here'
                  : bestValue
                  ? 'Best per credit'
                  : null);
    // Only Play's price is ever shown; a row it gave none for says so.
    final regularPrice = storeProduct?.price ?? billingPriceUnavailable;
    final intro = introOfferFor(product, storeProduct);
    final price = intro?.price ?? regularPrice;
    final priced = storeProduct != null;
    final enabled = onSelect != null && storeProduct != null && !isCurrent;
    // A row Play cannot sell is never drawn as chosen: the ring would promise a
    // purchase the checkout bar cannot make.
    final chosen = selected && (storeProduct != null || isCurrent);
    final subscription = product.isSubscription;
    final costs = creditCosts;
    final tagline = detailed && subscription
        ? (costs == null ? style.tagline : planBooksLine(product, costs))
        : null;
    final creditsLine = subscription
        ? planCreditsLine(product, intro)
        : 'Yours until you use them';
    final savings = savingsPercent == null
        ? null
        : 'Save $savingsPercent% per credit';
    final large = billingLargeText(context);
    final period = !priced
        ? 'No price yet'
        : intro != null
        ? intro.termLabel
        : subscription
        ? '/ ${product.periodNoun}'
        : 'one time';
    // An offer's price is never shown without the price it renews at.
    final renewsAt = intro == null
        ? null
        : 'Then $regularPrice / ${product.periodNoun}';

    // The name the row shows, and the one a screen reader says. A pack's
    // catalog title ("One extra credit") dates from when one credit was one
    // export, so read aloud it named a 1,000-credit pack a single credit.
    final name = subscription
        ? billingPlanName(product)
        : '${formatCredits(product.creditAmount)} credits';
    final titleRow = Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: AppSpacing.xs,
      runSpacing: AppSpacing.xxs,
      children: [
        Text(
          name,
          style: text.titleMedium?.copyWith(fontWeight: FontWeight.w800),
        ),
        if (badge != null)
          _OptionBadge(
            label: badge,
            current: isCurrent,
            muted: storeProduct == null && !isCurrent,
            style: style,
          ),
      ],
    );

    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (tagline != null)
          Text(
            tagline,
            style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
        if (renewsAt != null)
          Text(
            renewsAt,
            style: text.bodySmall?.copyWith(
              color: colors.onSurface,
              fontWeight: FontWeight.w600,
            ),
          ),
        Text(
          creditsLine,
          style: subscription && detailed
              ? text.bodyMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: colors.onSurface,
                )
              : text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
        ),
        if (savings != null)
          Text(
            savings,
            style: text.labelMedium?.copyWith(
              color: style.accent(colors),
              fontWeight: FontWeight.w700,
            ),
          ),
      ],
    );

    final priceBlock = Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          price,
          maxLines: 1,
          softWrap: false,
          textAlign: TextAlign.end,
          style: text.titleLarge?.copyWith(fontWeight: FontWeight.w800),
        ),
        Text(
          period,
          maxLines: 1,
          softWrap: false,
          style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
        ),
      ],
    );

    return Semantics(
      container: true,
      button: true,
      selected: chosen,
      enabled: enabled,
      inMutuallyExclusiveGroup: true,
      onTap: enabled ? onSelect : null,
      label:
          '$name, ${!priced
              ? 'price unavailable from Google Play'
              : intro != null
              ? '$price for the ${intro.termLabel}, then $regularPrice per ${product.periodNoun}'
              : '$price ${subscription ? 'per ${product.periodNoun}' : 'one time'}'}'
          '${subscription ? ', ${planCreditsLine(product, intro, per: 'per')}' : ''}'
          '${tagline == null ? '' : ', $tagline'}'
          '${savings == null ? '' : ', $savings'}'
          '${format == null ? '' : ', $format export included'}'
          '${badge == null ? '' : ', $badge'}',
      child: ExcludeSemantics(
        child: Material(
          color: chosen
              ? colors.primaryContainer
              : colors.surfaceContainerLowest,
          animationDuration: AppMotion.reducedMotion(context)
              ? Duration.zero
              : AppMotion.fast,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.card),
            side: BorderSide(
              color: chosen ? colors.primary : colors.outlineVariant,
              width: chosen ? 2 : 1,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: enabled ? onSelect : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppSizes.minimumTouchTarget + AppSpacing.md,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.md - 2,
                  vertical: AppSpacing.sm,
                ),
                child: Opacity(
                  opacity: storeProduct == null && !isCurrent ? 0.7 : 1,
                  child: Row(
                    crossAxisAlignment: large
                        ? CrossAxisAlignment.start
                        : CrossAxisAlignment.center,
                    children: [
                      Padding(
                        padding: EdgeInsets.only(top: large ? 2 : 0),
                        child: Icon(
                          chosen
                              ? Icons.check_circle_rounded
                              : Icons.circle_outlined,
                          size: 24,
                          color: chosen ? colors.primary : colors.outline,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.sm),
                      Expanded(
                        child: large
                            // Big type: the price goes under the name instead
                            // of beside it, so it always has the full row.
                            ? Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  titleRow,
                                  const SizedBox(height: AppSpacing.xxs),
                                  Wrap(
                                    crossAxisAlignment:
                                        WrapCrossAlignment.center,
                                    spacing: AppSpacing.xs,
                                    children: [
                                      Text(
                                        price,
                                        style: text.titleLarge?.copyWith(
                                          fontWeight: FontWeight.w800,
                                        ),
                                      ),
                                      Text(
                                        period,
                                        style: text.bodySmall?.copyWith(
                                          color: colors.onSurfaceVariant,
                                        ),
                                      ),
                                    ],
                                  ),
                                  const SizedBox(height: AppSpacing.xxs),
                                  details,
                                ],
                              )
                            : LayoutBuilder(
                                builder: (context, constraints) => Row(
                                  crossAxisAlignment: CrossAxisAlignment.center,
                                  children: [
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          titleRow,
                                          const SizedBox(height: 2),
                                          details,
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: AppSpacing.xs),
                                    // The price shrinks before it ever wraps:
                                    // a price broken over two lines is unreadable.
                                    ConstrainedBox(
                                      constraints: BoxConstraints(
                                        maxWidth: constraints.maxWidth * 0.42,
                                      ),
                                      child: FittedBox(
                                        fit: BoxFit.scaleDown,
                                        alignment:
                                            AlignmentDirectional.centerEnd,
                                        child: priceBlock,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The small label on a row: what it is (your plan), or why to look at it.
class _OptionBadge extends StatelessWidget {
  const _OptionBadge({
    required this.label,
    required this.current,
    required this.muted,
    required this.style,
  });

  final String label;
  final bool current;
  final bool muted;
  final BillingTierStyle style;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final Color background;
    final Color foreground;
    if (muted) {
      background = colors.surfaceContainerHigh;
      foreground = colors.onSurfaceVariant;
    } else if (current) {
      background = colors.surfaceContainerLowest;
      foreground = colors.onSurface;
    } else {
      background = style.accentContainer(colors);
      foreground = style.onAccentContainer(colors);
    }
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadii.pill),
        border: current
            ? Border.all(color: colors.outline.withValues(alpha: 0.5))
            : null,
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (current) ...[
              Icon(Icons.check_rounded, size: 12, color: foreground),
              const SizedBox(width: 3),
            ],
            Text(
              label,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: foreground,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String billingPlanName(MobileBillingProduct product) {
  final name = switch (billingTierForSku(product.sku)) {
    'creator' => 'Creator',
    'pro' => 'Pro',
    'max' => 'Max',
    _ => product.title,
  };
  return product.isYearly ? '$name yearly' : name;
}

/// [billingPlanName] for a plan known only by its id, read from [products]
/// when it is there — a yearly plan says so — and from its tier otherwise.
String billingPlanNameForSku(
  String sku,
  Iterable<MobileBillingProduct> products,
) {
  for (final product in products) {
    if (product.sku == sku) return billingPlanName(product);
  }
  return billingTierLabel(billingTierForSku(sku));
}
