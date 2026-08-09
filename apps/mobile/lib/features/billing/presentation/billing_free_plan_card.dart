import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart';
import 'billing_tier_style.dart';

/// The bottom rung of the plan ladder.
///
/// Free is not a product, so it has no card of its own from the catalogue — and
/// without one the paywall only ever said what a free reader had *left*, never
/// what the tier grants. It says both things a decision needs: what free
/// includes every month, and — for someone on a paid plan — that this is where
/// cancelling lands them.
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

/// What the free tier grants, in the same shape as [planBenefits].
///
/// Stated as an entitlement rather than as a remainder: "3 illustrated books a
/// month" is the fact someone weighing a plan — or a cancellation — needs, and
/// it is true whether or not they have used any yet.
List<String> freePlanBenefits(MobileFreeTier freeTier) {
  return <String>[
    '${formatCredits(freeTier.monthlyCredits)} credits every month',
    '${freeTier.illustratedBooksPerMonth} illustrated books a month',
    'Books you have already made stay yours',
  ];
}
