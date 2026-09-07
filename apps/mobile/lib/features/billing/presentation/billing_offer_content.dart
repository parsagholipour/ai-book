import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_credits_needed.dart';
import 'billing_plan_tiles.dart';
import 'credit_log_screen.dart';

class BillingOfferHeader extends StatelessWidget {
  const BillingOfferHeader({
    required this.billing,
    required this.onClose,
    this.creditsNeeded,
    this.title,
    this.message,
    super.key,
  });

  final MobileBilling? billing;
  final PaywallCreditsNeeded? creditsNeeded;
  final String? title;
  final String? message;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final balance = billing?.credits.available;
    final shortfall = creditsNeeded?.shortfallFrom(balance);
    final covered = shortfall == 0;
    final heading = creditsNeeded != null
        ? covered
              ? 'You have enough credits'
              : shortfall != null
              ? '${formatCredits(shortfall)} credits to keep going.'
              : 'Keep your book moving.'
        : title == null || title == 'Upgrade your plan'
        ? 'More room for\nyour next book.'
        : title!;
    final description =
        creditsNeeded?.reason ??
        message ??
        'Write, edit, and illustrate. Choose the credits that fit your next chapter.';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                creditsNeeded != null ? 'Credits needed' : 'CREATE MORE',
                style: text.labelSmall?.copyWith(
                  color: colors.primary,
                  letterSpacing: 1.4,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            IconButton(
              tooltip: 'Close',
              onPressed: onClose,
              icon: const Icon(Icons.close_rounded),
            ),
          ],
        ),
        Text(
          heading,
          style: text.headlineSmall?.copyWith(
            fontWeight: FontWeight.w800,
            height: 1.15,
            letterSpacing: -0.6,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          description,
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              Icon(
                covered
                    ? Icons.check_circle_outline
                    : Icons.account_balance_wallet_outlined,
                size: 18,
                color: colors.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  balance == null
                      ? 'Checking your balance…'
                      : shortfall != null && shortfall > 0
                      ? '${formatCredits(balance)} of ${formatCredits(creditsNeeded!.credits!)} credits · ${formatCredits(shortfall)} short'
                      : '${billing?.plan?.label ?? 'Free'} · ${formatCredits(balance)} credits available',
                  style: text.bodySmall?.copyWith(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class BillingOfferDetails extends StatelessWidget {
  const BillingOfferDetails({required this.monthly, super.key});
  final bool monthly;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final benefits = monthly
        ? [
            (
              Icons.auto_stories_outlined,
              'Credits every month',
              'For new books, edits, and illustrations.',
            ),
            (
              Icons.edit_document,
              'Editable Word exports',
              'Take your manuscript into your own hands.',
            ),
            (
              Icons.upload_file_outlined,
              'Bring your own book',
              'Import a draft and keep developing it.',
            ),
          ]
        : [
            (
              Icons.all_inclusive,
              'Use them at your pace',
              'Purchased credits never expire.',
            ),
            (
              Icons.lock_open_outlined,
              'One payment. No renewal.',
              'Keep your current plan and add what you need.',
            ),
          ];
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            monthly
                ? 'Included in every paid plan'
                : 'A little more, whenever you need it',
            style: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
          for (final (index, benefit) in benefits.indexed) ...[
            SizedBox(height: index == 0 ? 14 : 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(benefit.$1, size: 22, color: colors.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        benefit.$2,
                        style: text.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        benefit.$3,
                        style: text.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class BillingOfferFooter extends StatelessWidget {
  const BillingOfferFooter({
    required this.restoring,
    required this.onRestore,
    super.key,
  });
  final bool restoring;
  final VoidCallback? onRestore;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Column(
      children: [
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text('How do credits work?', style: text.titleSmall),
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Text(
                'Writing, edits, illustrations, and export unlocks use credits. '
                'Costs depend on your book and settings. Monthly credits reset each billing period. '
                'Purchased credits never expire and are spent after your monthly credits. '
                'Paid plans remove the monthly illustrated-book limit; illustrations still use credits.',
                style: text.bodySmall,
              ),
            ),
          ],
        ),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 8,
          children: [
            AppButton.text(
              key: const ValueKey('paywall-credit-log'),
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const CreditLogScreen(),
                ),
              ),
              label: 'See credit logs',
            ),
            AppButton.text(
              onPressed: onRestore,
              loading: restoring,
              loadingLabel: 'Restoring purchases',
              label: 'Restore purchases',
            ),
          ],
        ),
      ],
    );
  }
}
