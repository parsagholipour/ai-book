import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart';
import 'billing_tier_style.dart';

/// Compact, fully visible plan rows replace a separate sales card per tier.
class BillingProductOption extends StatelessWidget {
  const BillingProductOption({
    required this.product,
    required this.storeProduct,
    required this.selected,
    required this.isCurrent,
    this.format,
    this.bestValue = false,
    this.recommendation,
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
    final price = storeProduct?.price ?? fallbackPrice(product);
    final enabled = onSelect != null && storeProduct != null && !isCurrent;

    return Semantics(
      container: true,
      button: true,
      selected: selected,
      enabled: enabled,
      inMutuallyExclusiveGroup: true,
      onTap: enabled ? onSelect : null,
      label:
          '${product.title}, $price ${product.isSubscription ? 'per month' : 'one time'}, '
          '${formatCredits(product.creditAmount)} credits'
          '${format == null ? '' : ', $format export included'}'
          '${badge == null ? '' : ', $badge'}',
      child: ExcludeSemantics(
        child: Material(
          color: selected
              ? colors.primaryContainer
              : colors.surfaceContainerLowest,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.card),
            side: BorderSide(
              color: selected ? colors.primary : colors.outlineVariant,
              width: selected ? 2 : 1,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: enabled ? onSelect : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Row(
                children: [
                  Icon(
                    selected
                        ? Icons.check_circle_rounded
                        : Icons.circle_outlined,
                    size: 22,
                    color: selected ? colors.primary : colors.outline,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 5,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          crossAxisAlignment: WrapCrossAlignment.center,
                          spacing: 8,
                          runSpacing: 4,
                          children: [
                            Text(
                              product.isSubscription
                                  ? billingPlanName(product)
                                  : '${formatCredits(product.creditAmount)} credits',
                              style: text.titleMedium?.copyWith(
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            if (badge != null)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 7,
                                  vertical: 3,
                                ),
                                decoration: BoxDecoration(
                                  color: colors.surfaceContainerLowest,
                                  borderRadius: BorderRadius.circular(
                                    AppRadii.pill,
                                  ),
                                ),
                                child: Text(
                                  badge,
                                  style: text.labelSmall?.copyWith(
                                    color: style.accent(colors),
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 3),
                        Text(
                          product.isSubscription
                              ? '${formatCredits(product.creditAmount)} credits / month'
                              : 'Yours until you use them',
                          style: text.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    flex: 3,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          price,
                          textAlign: TextAlign.end,
                          style: text.titleLarge?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Text(
                          product.isSubscription ? '/ month' : 'one time',
                          style: text.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

String billingPlanName(MobileBillingProduct product) =>
    switch (billingTierForSku(product.sku)) {
      'creator' => 'Creator',
      'pro' => 'Pro',
      'max' => 'Max',
      _ => product.title,
    };
