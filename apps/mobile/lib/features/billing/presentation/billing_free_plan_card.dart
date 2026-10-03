import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart';
import 'billing_tier_style.dart';

/// The bottom rung of the plan ladder.
///
/// Free is not a product, so it has no card of its own from the catalogue — and
/// without one the paywall only ever said what a free reader had *left*, never
/// what the tier grants. Welcome credits are one-time; usage spends credits.
/// Paid readers can also see where cancelling lands them.
class BillingFreePlanCard extends StatelessWidget {
  const BillingFreePlanCard({
    required this.freeTier,
    required this.isCurrentPlan,
    this.onSwitchToFree,
    super.key,
  });

  final MobileFreeTier freeTier;
  final bool isCurrentPlan;

  /// Opens the cancel flow. Null while a cancel is already running.
  final VoidCallback? onSwitchToFree;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final style = billingTierStyleForTier('free');
    // Free stays deliberately neutral: it must not read as a rung worth buying.
    final accent = colors.onSurfaceVariant;

    return Container(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(AppRadii.card),
        border: Border.all(
          color: isCurrentPlan
              ? accent.withValues(alpha: 0.45)
              : colors.outlineVariant,
        ),
      ),
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(style.emblem, color: accent),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Free',
                      style: text.titleLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      style.tagline,
                      style: text.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              if (isCurrentPlan)
                Text(
                  'YOUR PLAN',
                  style: text.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.2,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 16),
          for (final benefit in freePlanBenefits(freeTier)) ...[
            BillingBenefitRow(label: benefit, accent: accent),
            const SizedBox(height: 8),
          ],
          if (!isCurrentPlan) ...[
            const SizedBox(height: 8),
            AppButton.outlined(
              key: const ValueKey('paywall-switch-to-free'),
              onPressed: onSwitchToFree,
              label: 'Switch to Free',
              expanded: true,
            ),
          ],
        ],
      ),
    );
  }
}

/// The one-time gift and the limits on credit-funded usage.
List<String> freePlanBenefits(MobileFreeTier freeTier) {
  return <String>[
    if (freeTier.welcomeCredits > 0)
      '${formatCredits(freeTier.welcomeCredits)} one-time welcome credits',
    'Messages and generation spend credits',
    'No monthly credit refill',
    'Up to ${freeTier.illustratedBooksPerMonth} illustrated books a month using credits',
    'Books up to ${freeTier.maxBookPages} pages',
    'Books you have already made stay yours',
  ];
}
