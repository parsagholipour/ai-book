import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';

/// Under a chat reply that ran into the free tier's book length: the way to
/// unlock it, right where the reader learned they need it.
///
/// The edit's card follows the reply, priced and ready, so this does not run
/// the edit — once the plan is bought, that card's Apply does. It disappears
/// on its own once the reader is on a plan, so an old reply never keeps
/// selling something they already have. Self-contained, because both chats
/// draw replies (the book chat and the creation chat after a book is built)
/// and neither has to learn a new callback for it.
class PageLimitUnlockRow extends ConsumerWidget {
  const PageLimitUnlockRow({
    required this.limit,
    required this.projectId,
    super.key,
  });

  final BookPageLimit limit;
  final String projectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final billing = ref.watch(billingProvider).asData?.value;
    // Unknown is shown: the reply itself says a plan is needed, and a row that
    // flickers in after a load reads as an afterthought.
    if (billing != null && billing.maxBookPages == null) {
      return const SizedBox.shrink();
    }
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Container(
      key: const ValueKey('page-limit-unlock'),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(AppRadii.control),
        border: Border.all(color: colors.primary.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.menu_book_outlined, size: 20, color: colors.primary),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: Text(
                  'Books up to ${limit.maxPages} pages with a plan',
                  style: text.labelLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: colors.onSurface,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          AppButton.primary(
            key: const ValueKey('page-limit-unlock-button'),
            onPressed: () => unawaited(_unlock(context, ref)),
            leading: const Icon(Icons.lock_open_outlined),
            label: 'Unlock ${limit.requestedPages} pages',
          ),
        ],
      ),
    );
  }

  Future<void> _unlock(BuildContext context, WidgetRef ref) async {
    final choice = await showLongBookOffer(
      context,
      projectId: projectId,
      limit: limit,
      canShorten: false,
    );
    ref.invalidate(billingProvider);
    if (choice == LongBookChoice.unlocked && context.mounted) {
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(
          content: Text('Your plan is active. Tap Apply to make the change.'),
        ),
      );
    }
  }
}
