import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../auth/presentation/verify_email_banner.dart';
import '../../auth/presentation/verify_email_location.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_tier_style.dart';
import 'account_billing_copy.dart';

/// The balance at a glance: which plan, how many credits, and the one thing to
/// do about it. Everything else about billing lives a tap deeper, in the Plan
/// and billing rows beneath, so this card carries a single action.
class AccountOverviewCard extends StatelessWidget {
  const AccountOverviewCard({
    required this.billing,
    required this.onGetCredits,
    required this.onRetry,
    super.key,
  });

  final AsyncValue<MobileBilling> billing;

  /// Opens the plans and credit packs.
  final VoidCallback onGetCredits;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return billing.when(
      skipLoadingOnReload: true,
      loading: () => const _OverviewSkeleton(),
      error: (error, _) => AppInlineNotice(
        title: 'Could not load your plan',
        message: userFacingError(error),
        tone: AppTone.error,
        actionLabel: 'Retry',
        onAction: onRetry,
      ),
      data: (value) =>
          _OverviewBody(billing: value, onGetCredits: onGetCredits),
    );
  }
}

class _OverviewBody extends StatelessWidget {
  const _OverviewBody({required this.billing, required this.onGetCredits});

  final MobileBilling billing;
  final VoidCallback onGetCredits;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final plan = billing.plan;
    final style = billingTierStyleForTier(billing.planTier);
    final contextLine = _overviewContext(context, billing);
    final reserved = billing.credits.reserved;
    final allowance = billing.allowance;
    final showAllowance =
        billing.isPaidPlan && allowance != null && allowance.monthlyCredits > 0;
    final awaitsVerification =
        !billing.isPaidPlan && verifyEmailCreditsLine(billing) != null;

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _TierPill(style: style, label: plan?.label ?? 'Free'),
          const SizedBox(height: AppSpacing.sm),
          Semantics(
            container: true,
            label: '${billing.credits.available} credits available',
            child: ExcludeSemantics(
              child: Wrap(
                crossAxisAlignment: WrapCrossAlignment.end,
                spacing: AppSpacing.xs,
                children: [
                  Text(
                    formatCredits(billing.credits.available),
                    style: text.displaySmall?.copyWith(
                      fontWeight: FontWeight.w800,
                      height: 1.1,
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text(
                      'credits',
                      style: text.titleSmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (showAllowance) ...[
            const SizedBox(height: AppSpacing.xs),
            ClipRRect(
              borderRadius: BorderRadius.circular(AppRadii.pill),
              child: LinearProgressIndicator(
                value: (allowance.planCredits / allowance.monthlyCredits).clamp(
                  0.0,
                  1.0,
                ),
                minHeight: 6,
              ),
            ),
          ],
          if (contextLine != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              contextLine,
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
          if (reserved > 0) ...[
            const SizedBox(height: AppSpacing.xxs),
            Text(
              '${formatCredits(reserved)} on hold for books in progress',
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          // Free credits waiting on the reader's email are the one thing
          // worth doing before any purchase, so Verify leads and the ladder
          // steps down beneath it rather than going away.
          if (awaitsVerification) ...[
            AppButton.primary(
              key: const ValueKey('account-verify-email'),
              onPressed: () => openVerifyEmail(context),
              leading: const Icon(Icons.verified_outlined),
              label: 'Verify email',
              expanded: true,
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
          // A free reader is offered the ladder; anyone already on it is
          // offered more credits. Both open the same plans-and-packs sheet.
          if (awaitsVerification)
            AppButton.outlined(
              onPressed: onGetCredits,
              leading: const Icon(Icons.workspace_premium_outlined),
              label: 'Upgrade',
              expanded: true,
            )
          else
            AppButton.primary(
              onPressed: onGetCredits,
              leading: Icon(
                billing.isPaidPlan
                    ? Icons.add_card_outlined
                    : Icons.workspace_premium_outlined,
              ),
              label: billing.isPaidPlan ? 'Add credits' : 'Upgrade',
              expanded: true,
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

/// The card's own shape while the plan loads: pill, balance, line, button.
class _OverviewSkeleton extends StatelessWidget {
  const _OverviewSkeleton();

  @override
  Widget build(BuildContext context) {
    final block = Theme.of(context).colorScheme.surfaceContainerHigh;

    Widget bar(double? width, double height, {double radius = 6}) => Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: block,
        borderRadius: BorderRadius.circular(radius),
      ),
    );

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Checking your plan',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                bar(64, 26, radius: AppRadii.pill),
                const SizedBox(height: AppSpacing.sm),
                bar(128, 40, radius: 10),
                const SizedBox(height: AppSpacing.xs),
                bar(220, 12),
                const SizedBox(height: AppSpacing.md),
                bar(double.infinity, AppSizes.controlHeight, radius: 14),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String? _overviewContext(BuildContext context, MobileBilling value) {
  final plan = value.plan;
  final cancelling = plan?.cancelAtPeriodEnd ?? false;
  // The line sits under the monthly allowance's bar, so a plan that refills
  // before it renews (Creator yearly) says when the bar refills first.
  final refill = creditsRefillLine(context, value);
  String withRefill(String line) => refill == null ? line : '$refill · $line';
  if (value.isPaidPlan && cancelling && plan?.endsAt != null) {
    return withRefill(endsLine(context, plan!.endsAt!));
  }
  final next = value.isPaidPlan ? paidPlanNextLine(context, value) : null;
  if (next != null) {
    return withRefill(next);
  }
  if (refill != null) {
    return refill;
  }
  final allowance = value.allowance;
  if (allowance != null && allowance.monthlyCredits > 0) {
    return monthlyCreditsLeftLine(allowance);
  }
  if (!value.isPaidPlan) {
    return value.welcomeCreditsPending
        ? verifyEmailCreditsLine(value) ?? welcomeCreditsPendingLine
        : freeTierGrantLine(value.freeTier);
  }
  return null;
}
