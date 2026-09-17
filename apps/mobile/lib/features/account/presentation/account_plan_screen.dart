import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_cancel_sheet.dart';
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
    final value = billing.asData?.value;
    final plan = value?.plan;
    final allowance = value?.allowance;
    final quota = value?.imageQuota;
    final paid = value?.isPaidPlan ?? false;
    final cancelling = plan?.cancelAtPeriodEnd ?? false;
    final nextPlan = value == null
        ? null
        : nextBetterPlan(
            value.products.where((product) => product.isSubscription).toList(),
            value.planTier,
          );
    final style = billingTierStyleForTier(value?.planTier ?? 'free');
    final accent = (value?.planTier ?? 'free') == 'free'
        ? colors.primary
        : style.accent(colors);

    return Card(
      key: const ValueKey('account-plan-card'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: style.accentContainer(colors),
                    borderRadius: BorderRadius.circular(AppRadii.compact),
                  ),
                  child: SizedBox.square(
                    dimension: 36,
                    child: Icon(style.emblem, color: accent, size: 20),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    plan == null ? 'Your plan' : '${plan.label} plan',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (allowance != null && allowance.monthlyCredits > 0) ...[
              Text(
                monthlyCreditsLeftLine(allowance),
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 8),
              LinearProgressIndicator(
                value: (allowance.planCredits / allowance.monthlyCredits).clamp(
                  0,
                  1,
                ),
              ),
            ] else if (billing.isLoading)
              Text(
                'Checking your plan',
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            if (quota != null) ...[
              const SizedBox(height: 4),
              Text(
                '${quota.used} of ${quota.limit} illustrated books used this month',
                style: TextStyle(
                  color: quota.isExhausted
                      ? colors.error
                      : colors.onSurfaceVariant,
                ),
              ),
            ],
            if (!paid && value != null) ...[
              const SizedBox(height: 4),
              // What free grants each month, so the card describes the plan and
              // not only what is left of it.
              Text(
                freeTierGrantLine(value.freeTier),
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
            if (paid && plan?.renewsAt != null) ...[
              const SizedBox(height: 4),
              Text(
                renewsLine(context, plan!.renewsAt!),
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
            if (paid && cancelling && plan?.endsAt != null) ...[
              const SizedBox(height: 4),
              Text(
                endsLine(context, plan!.endsAt!, thenFree: true),
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: 12),
            if (paid)
              Wrap(
                spacing: 8,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (nextPlan != null)
                    AppButton.primary(
                      key: const ValueKey('account-upgrade-plan'),
                      onPressed: onUpgrade,
                      leading: const Icon(Icons.arrow_upward),
                      label: 'Upgrade plan',
                    ),
                  AppButton.outlined(
                    key: const ValueKey('account-manage-subscription'),
                    onPressed: () => onManageSubscription(plan?.productSku),
                    leading: const Icon(Icons.open_in_new),
                    label: 'Manage subscription',
                  ),
                  // Already cancelling: the only thing left to do in Play is
                  // change your mind, so the button says that instead.
                  if (cancelling)
                    AppButton.text(
                      key: const ValueKey('account-resume-subscription'),
                      onPressed: () => onManageSubscription(plan?.productSku),
                      label: 'Resume in Play',
                    )
                  else if (value != null)
                    AppButton.text(
                      key: const ValueKey('account-cancel-subscription'),
                      onPressed: () => onCancelSubscription(value),
                      label: 'Cancel subscription',
                    ),
                ],
              )
            else if (nextPlan != null)
              AppButton.primary(
                key: const ValueKey('account-upgrade-plan'),
                onPressed: onUpgrade,
                leading: const Icon(Icons.arrow_upward),
                label: 'Upgrade plan',
              ),
          ],
        ),
      ),
    );
  }
}

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
    final value = billing.asData?.value;
    final balance = billing.when(
      data: (billingValue) =>
          '${billingValue.credits.available} credits available',
      loading: () => 'Checking your credit balance',
      error: (error, stackTrace) => userFacingError(error),
    );
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
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.account_balance_wallet_outlined,
                  color: colors.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Book credits',
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(balance, style: TextStyle(color: colors.onSurfaceVariant)),
            if (purchased > 0) ...[
              const SizedBox(height: 4),
              Text(
                '$purchased purchased credits that do not expire',
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
            if (billing.hasValue) ...[
              const SizedBox(height: 8),
              Text(
                planningCopy,
                style: TextStyle(color: colors.onSurfaceVariant),
              ),
            ],
            const SizedBox(height: 12),
            billing.hasError
                ? AppButton.outlined(
                    onPressed: onRetry,
                    leading: const Icon(Icons.refresh),
                    label: 'Retry',
                  )
                : AppButton.primary(
                    onPressed: onAddCredits,
                    leading: const Icon(Icons.add_card_outlined),
                    label: 'Add credits',
                  ),
          ],
        ),
      ),
    );
  }
}
