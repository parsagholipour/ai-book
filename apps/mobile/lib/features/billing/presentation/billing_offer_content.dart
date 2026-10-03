import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/app_components.dart';
import '../../account/presentation/account_links.dart';
import '../domain/billing_models.dart';
import 'billing_credits_needed.dart';
import 'billing_shared_parts.dart';
import 'credit_log_screen.dart';

/// The top of the paywall: what this is about, and where the reader stands.
///
/// It stays short on purpose. The plans are what the reader came for, and on a
/// phone every line up here pushes one of them below the checkout bar.
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
    final needed = creditsNeeded?.credits;
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
        'Pick a monthly plan, or add credits once.';
    final short = shortfall != null && shortfall > 0 && needed != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (creditsNeeded != null) ...[
                      Text(
                        'Credits needed',
                        style: text.labelMedium?.copyWith(
                          color: colors.primary,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.4,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.xxs),
                    ],
                    Semantics(
                      header: true,
                      child: Text(
                        heading,
                        style: text.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w800,
                          height: 1.15,
                          letterSpacing: -0.6,
                        ),
                      ),
                    ),
                  ],
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
        // The stock line goes first when type is large: it says nothing the
        // plans below do not, and the plans are what needs the room.
        if (!(billingLargeText(context) &&
            creditsNeeded?.reason == null &&
            message == null)) ...[
          const SizedBox(height: AppSpacing.xs),
          Text(
            description,
            style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
        const SizedBox(height: AppSpacing.sm),
        DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerLow,
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.sm,
              vertical: 10,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Icon(
                      covered
                          ? Icons.check_circle_outline
                          : Icons.account_balance_wallet_outlined,
                      size: 18,
                      color: colors.primary,
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        balance == null
                            ? 'Checking your balance…'
                            : short
                            ? '${formatCredits(balance)} of ${formatCredits(needed)} credits · ${formatCredits(shortfall)} short'
                            : '${billing?.plan?.label ?? 'Free'} · ${formatCredits(balance)} credits available',
                        style: text.bodySmall?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                if (short && balance != null) ...[
                  const SizedBox(height: AppSpacing.xs),
                  // How far the balance already gets toward what the blocked
                  // action needs — the gap the purchase has to close.
                  ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                    child: LinearProgressIndicator(
                      value: (balance / needed).clamp(0.0, 1.0),
                      minHeight: 6,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// What every paid plan (or every top-up) has in common, so the plan rows above
/// can stick to what makes them different.
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
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            header: true,
            child: Text(
              monthly
                  ? 'Included in every paid plan'
                  : 'A little more, whenever you need it',
              style: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          for (final (index, benefit) in benefits.indexed) ...[
            SizedBox(height: index == 0 ? AppSpacing.sm : 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(benefit.$1, size: 22, color: colors.primary),
                const SizedBox(width: AppSpacing.sm),
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

/// The calm end of the paywall: how credits work, and the housekeeping links —
/// restore, history, terms — that are needed rarely but must always be there.
class BillingOfferFooter extends ConsumerWidget {
  const BillingOfferFooter({
    required this.restoring,
    required this.onRestore,
    super.key,
  });
  final bool restoring;
  final VoidCallback? onRestore;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final colors = Theme.of(context).colorScheme;
    final config = ref.watch(appConfigProvider);
    return Column(
      children: [
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          shape: const Border(),
          collapsedShape: const Border(),
          title: Text('How do credits work?', style: text.titleSmall),
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: Text(
                'Building a book plan uses credits; the current amount is listed in Account. '
                'Writing, edits, illustrations, and export unlocks also use credits. '
                'Writing costs depend on your book and settings. Monthly credits reset each billing period. '
                'Purchased credits never expire and are spent after your monthly credits. '
                'Paid plans remove the monthly illustrated-book limit; illustrations still use credits.',
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ),
          ],
        ),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: AppSpacing.xs,
          children: [
            AppButton.text(
              onPressed: onRestore,
              loading: restoring,
              loadingLabel: 'Restoring purchases',
              label: 'Restore purchases',
            ),
            AppButton.text(
              key: const ValueKey('paywall-credit-log'),
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const CreditLogScreen(),
                ),
              ),
              label: 'Credit history',
            ),
          ],
        ),
        Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            _FooterLink(
              key: const ValueKey('paywall-terms'),
              label: 'Terms',
              onPressed: () => openAccountUri(
                context,
                config.termsOfServiceUrl,
                'the terms of service',
              ),
            ),
            Text('·', style: text.bodySmall),
            _FooterLink(
              key: const ValueKey('paywall-privacy'),
              label: 'Privacy',
              onPressed: () => openAccountUri(
                context,
                config.privacyPolicyUrl,
                'the privacy policy',
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _FooterLink extends StatelessWidget {
  const _FooterLink({required this.label, required this.onPressed, super.key});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: Theme.of(context).colorScheme.onSurfaceVariant,
        textStyle: Theme.of(context).textTheme.bodySmall?.copyWith(
          decoration: TextDecoration.underline,
          fontWeight: FontWeight.w600,
        ),
      ),
      child: Text(label),
    );
  }
}
