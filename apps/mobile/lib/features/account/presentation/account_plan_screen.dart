import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_cancel_sheet.dart';
import '../../billing/presentation/billing_shared_parts.dart';
import '../../billing/presentation/billing_tier_style.dart';
import '../../billing/presentation/message_allowance_banner.dart';
import '../../billing/presentation/play_subscriptions_link.dart';
import 'account_billing_copy.dart';
import 'account_credit_history_row.dart';
import 'account_paywall.dart';

class AccountPlanScreen extends ConsumerWidget {
  const AccountPlanScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final billing = ref.watch(billingProvider);
    final allowance = billing.asData?.value.messageAllowance;
    return Scaffold(
      appBar: AppBar(title: const Text('Plan & billing')),
      body: AppScreenLayout(
        children: [
          AccountPlanCard(
            billing: billing,
            onUpgrade: () => openAccountBillingPaywall(context, ref),
            onManageSubscription: (sku) =>
                ref.read(playSubscriptionsLauncherProvider)(sku),
            onCancelSubscription: (value) =>
                _openCancelSheet(context, ref, value),
          ),
          const SizedBox(height: AppSpacing.sm),
          AccountCreditsCard(
            billing: billing,
            onAddCredits: () => openAccountBillingPaywall(context, ref),
            onRetry: () => ref.invalidate(billingProvider),
          ),
          const SizedBox(height: AppSpacing.sm),
          Card(
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                AppSettingsRow(
                  icon: allowance?.isExhausted == true
                      ? Icons.hourglass_empty_rounded
                      : Icons.chat_bubble_outline_rounded,
                  title: 'Daily messages',
                  subtitle: allowance == null
                      ? null
                      : allowance.isExhausted
                      ? 'Daily message limit reached'
                      : '${allowance.remaining} of ${allowance.limit} messages left',
                  onTap: () => showMessageAllowance(context),
                ),
                const Divider(height: 1),
                const AccountCreditHistoryRow(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Future<void> _openCancelSheet(
  BuildContext context,
  WidgetRef ref,
  MobileBilling value,
) async {
  await showCancelSubscriptionSheet(context, billing: value);
  if (context.mounted) {
    ref.invalidate(billingProvider);
  }
}

/// The plan at a glance: which tier, when it renews or ends, what is left of
/// its allowance — then the ways to change it.
///
/// Public so it can be pumped on its own, like [AccountCreditsCard].
class AccountPlanCard extends StatelessWidget {
  const AccountPlanCard({
    required this.billing,
    required this.onUpgrade,
    required this.onManageSubscription,
    required this.onCancelSubscription,
    super.key,
  });

  final AsyncValue<MobileBilling> billing;
  final VoidCallback onUpgrade;
  final void Function(String? sku) onManageSubscription;
  final void Function(MobileBilling billing) onCancelSubscription;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final value = billing.asData?.value;
    final plan = value?.plan;
    final allowance = value?.allowance;
    final quota = value?.imageQuota;
    final paid = value?.isPaidPlan ?? false;
    final cancelling = plan?.cancelAtPeriodEnd ?? false;
    final tier = value?.planTier ?? 'free';
    final nextPlan = value == null
        ? null
        : nextBetterPlan(
            value.products.where((product) => product.isSubscription).toList(),
            value.planTier,
          );
    final style = billingTierStyleForTier(tier);
    final accent = tier == 'free' ? colors.primary : style.accent(colors);

    return Card(
      key: const ValueKey('account-plan-card'),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: style.accentContainer(colors),
                        borderRadius: BorderRadius.circular(AppRadii.control),
                      ),
                      child: SizedBox.square(
                        dimension: 44,
                        child: Icon(style.emblem, color: accent, size: 24),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            value == null
                                ? 'Your plan'
                                : '${plan?.label ?? 'Free'} plan',
                            style: text.titleLarge?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          if (paid && !cancelling && plan?.renewsAt != null)
                            Text(
                              renewsLine(context, plan!.renewsAt!),
                              style: text.bodyMedium?.copyWith(
                                color: colors.onSurfaceVariant,
                              ),
                            )
                          else if (billing.isLoading && value == null)
                            Text(
                              'Checking your plan',
                              style: text.bodyMedium?.copyWith(
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (paid && cancelling && plan?.endsAt != null) ...[
                  const SizedBox(height: AppSpacing.sm),
                  // Ending is the one thing on this card that changes what the
                  // reader has, so it is said in a warning notice, not in grey.
                  BillingNoticeLine(
                    tone: AppTone.warning,
                    message: endsLine(context, plan!.endsAt!, thenFree: true),
                  ),
                ],
                if (allowance != null && allowance.monthlyCredits > 0) ...[
                  const SizedBox(height: AppSpacing.md),
                  BillingUsageMeter(
                    label: monthlyCreditsLeftLine(
                      allowance,
                      formatCredits: formatCredits,
                    ),
                    remaining: allowance.planCredits / allowance.monthlyCredits,
                    caption: allowance.resetsAt == null
                        ? null
                        : 'Resets ${billingDate(context, allowance.resetsAt!)}',
                  ),
                ],
                if (quota != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  BillingUsageMeter(
                    label:
                        '${quota.used} of ${quota.limit} illustrated books used this month',
                    remaining: quota.limit == 0
                        ? 0
                        : quota.remaining / quota.limit,
                    caption: quota.isExhausted
                        ? 'Resets ${billingDate(context, quota.resetsAt)}'
                        : null,
                  ),
                ],
                if (!paid && value != null) ...[
                  const SizedBox(height: AppSpacing.sm),
                  // What free grants each month, so the card describes the plan
                  // and not only what is left of it.
                  Text(
                    freeTierGrantLine(
                      value.freeTier,
                      formatCredits: formatCredits,
                    ),
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
                if (nextPlan != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  AppButton.primary(
                    key: const ValueKey('account-upgrade-plan'),
                    onPressed: onUpgrade,
                    leading: const Icon(Icons.arrow_upward),
                    label: 'Upgrade plan',
                    expanded: true,
                  ),
                ],
              ],
            ),
          ),
          // Managing and cancelling are ordinary rows, not buttons competing
          // with the upgrade: always there, easy to find, never pushed.
          if (paid && value != null) ...[
            const Divider(),
            AppSettingsRow(
              key: const ValueKey('account-manage-subscription'),
              icon: Icons.open_in_new,
              title: 'Manage subscription',
              subtitle: 'Payment method and billing in Google Play',
              external: true,
              onTap: () => onManageSubscription(plan?.productSku),
            ),
            const Divider(),
            // Already cancelling: the only thing left to do in Play is change
            // your mind, so the row says that instead.
            if (cancelling)
              AppSettingsRow(
                key: const ValueKey('account-resume-subscription'),
                icon: Icons.restart_alt,
                title: 'Resume in Play',
                subtitle: 'Keep your plan past the end date',
                external: true,
                onTap: () => onManageSubscription(plan?.productSku),
              )
            else
              AppSettingsRow(
                key: const ValueKey('account-cancel-subscription'),
                icon: Icons.cancel_outlined,
                title: 'Cancel subscription',
                subtitle: 'See what you keep before you cancel',
                onTap: () => onCancelSubscription(value),
              ),
          ],
        ],
      ),
    );
  }
}

/// Where the balance stands, and the one way to add to it.
///
/// Public so it can be pumped on its own, like [AccountPlanCard].
class AccountCreditsCard extends StatelessWidget {
  const AccountCreditsCard({
    required this.billing,
    required this.onAddCredits,
    required this.onRetry,
    super.key,
  });

  final AsyncValue<MobileBilling> billing;
  final VoidCallback onAddCredits;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final value = billing.asData?.value;
    final planCredits = value?.planGenerationCredits;
    final planningCopy = planCredits == null
        ? 'Building a book plan uses credits. The current amount depends on '
              'your Effort setting.'
        : 'Building a book plan uses credits. Balanced planning currently '
              'costs $planCredits credits; other Effort settings cost a '
              'different amount. Writing the book after you approve is a '
              'separate charge.';
    final purchased = value?.credits.purchased ?? 0;

    return Card(
      key: const ValueKey('account-credits-card'),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.account_balance_wallet_outlined,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    'Book credits',
                    style: text.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            if (billing.hasError)
              Text(
                userFacingError(billing.error!),
                style: text.bodyMedium?.copyWith(color: colors.error),
              )
            else if (value == null)
              const _BalanceSkeleton()
            else ...[
              Semantics(
                container: true,
                label: '${value.credits.available} credits available',
                child: ExcludeSemantics(
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: formatCredits(value.credits.available),
                          style: text.displaySmall?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        TextSpan(
                          text: '  credits available',
                          style: text.bodyMedium?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              if (purchased > 0) ...[
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  '${formatCredits(purchased)} purchased credits that do not expire',
                  style: text.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.sm),
              Text(
                planningCopy,
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            billing.hasError
                ? AppButton.outlined(
                    onPressed: onRetry,
                    leading: const Icon(Icons.refresh),
                    label: 'Retry',
                  )
                // Outlined: the plan card above owns the screen's one filled
                // action, and adding credits is the quieter of the two.
                : AppButton.outlined(
                    onPressed: onAddCredits,
                    leading: const Icon(Icons.add_card_outlined),
                    label: 'Add credits',
                    expanded: true,
                  ),
          ],
        ),
      ),
    );
  }
}

/// A balance-shaped placeholder, so the card does not jump when the number
/// arrives.
class _BalanceSkeleton extends StatelessWidget {
  const _BalanceSkeleton();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Checking your credit balance',
      liveRegion: true,
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Container(
            width: 160,
            height: 40,
            decoration: BoxDecoration(
              color: colors.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(AppRadii.compact),
            ),
          ),
        ),
      ),
    );
  }
}
