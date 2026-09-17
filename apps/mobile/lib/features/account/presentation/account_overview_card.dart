import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_plan_tiles.dart';
import '../../billing/presentation/billing_tier_style.dart';
import 'account_billing_copy.dart';

class AccountOverviewCard extends StatelessWidget {
  const AccountOverviewCard({
    required this.billing,
    required this.onAddCredits,
    required this.onManagePlan,
    required this.onRetry,
    super.key,
  });

  final AsyncValue<MobileBilling> billing;
  final VoidCallback onAddCredits;
  final VoidCallback onManagePlan;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return billing.when(
      skipLoadingOnReload: true,
      loading: () => const AppCard(
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: AppSpacing.sm),
          child: Text('Checking your plan'),
        ),
      ),
      error: (error, _) => AppInlineNotice(
        title: 'Could not load your plan',
        message: userFacingError(error),
        tone: AppTone.error,
        actionLabel: 'Retry',
        onAction: onRetry,
      ),
      data: (value) => _OverviewBody(
        billing: value,
        onAddCredits: onAddCredits,
        onManagePlan: onManagePlan,
      ),
    );
  }
}

class _OverviewBody extends StatelessWidget {
  const _OverviewBody({
    required this.billing,
    required this.onAddCredits,
    required this.onManagePlan,
  });

  final MobileBilling billing;
  final VoidCallback onAddCredits;
  final VoidCallback onManagePlan;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final plan = billing.plan;
    final style = billingTierStyleForTier(billing.planTier);
    final contextLine = _overviewContext(context, billing);

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _TierPill(style: style, label: plan?.label ?? 'Free'),
          const SizedBox(height: 10),
          Semantics(
            container: true,
            label: '${billing.credits.available} credits available',
            child: ExcludeSemantics(
              child: Text(
                formatCredits(billing.credits.available),
                style: text.displaySmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
          ),
          if (contextLine != null) ...[
            const SizedBox(height: 6),
            Text(
              contextLine,
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          AppActionGroup(
            primary: AppButton.primary(
              onPressed: onAddCredits,
              leading: const Icon(Icons.add_card_outlined),
              label: 'Add credits',
            ),
            secondary: [
              AppButton.outlined(
                onPressed: onManagePlan,
                leading: const Icon(Icons.workspace_premium_outlined),
                label: 'Manage plan',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _TierPill extends StatelessWidget {
  const _TierPill({required this.style, required this.label});

  final BillingTierStyle style;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: style.accentContainer(colors),
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: style.onAccentContainer(colors),
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }
}

String? _overviewContext(BuildContext context, MobileBilling value) {
  final plan = value.plan;
  final cancelling = plan?.cancelAtPeriodEnd ?? false;
  if (value.isPaidPlan && cancelling && plan?.endsAt != null) {
    return endsLine(context, plan!.endsAt!);
  }
  if (value.isPaidPlan && plan?.renewsAt != null) {
    return renewsLine(context, plan!.renewsAt!);
  }
  final allowance = value.allowance;
  if (allowance != null && allowance.monthlyCredits > 0) {
    return monthlyCreditsLeftLine(allowance);
  }
  if (!value.isPaidPlan) {
    return freeTierGrantLine(value.freeTier);
  }
  return null;
}
