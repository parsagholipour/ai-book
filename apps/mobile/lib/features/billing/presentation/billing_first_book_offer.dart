import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_export_plan_option.dart';
import 'billing_plan_tiles.dart';
import 'billing_shared_parts.dart';
import 'billing_tier_style.dart';

/// The offer a free reader meets once, the first time a book Tomeza wrote for
/// them is ready.
///
/// It celebrates first: the book is theirs to read, download and share,
/// whatever they choose. The plans follow — the intro offer marked "Start here" — with what a
/// plan adds to a book they now hold in their hands. Closing it is one tap,
/// "Keep reading for free", back to the book; it is never shown again on this
/// phone for this account (`FirstBookOfferStore`). Modelled on the long-book
/// offer, so the purchase runs through the paywall's own lifecycle.
class BillingFirstBookOffer extends StatefulWidget {
  const BillingFirstBookOffer({
    required this.bookTitle,
    required this.state,
    required this.plans,
    required this.onBuy,
    required this.onRestore,
    required this.onRetry,
    required this.onClose,
    super.key,
  });

  final String bookTitle;
  final BillingPurchaseState state;
  final List<MobileBillingProduct> plans;
  final ValueChanged<MobileBillingProduct> onBuy;
  final VoidCallback onRestore;
  final VoidCallback onRetry;
  final VoidCallback onClose;

  @override
  State<BillingFirstBookOffer> createState() => _BillingFirstBookOfferState();
}

class _BillingFirstBookOfferState extends State<BillingFirstBookOffer> {
  String? _selectedSku;

  bool _isCurrent(MobileBillingProduct plan) =>
      isHeldPlan(plan, widget.state.billing);

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    // A purchase that just landed: the sheet says so and leads back.
    final included = state.billing?.hasCreatorSubscription ?? false;
    final plans = widget.plans
        .where((plan) => billingTierForSku(plan.sku) != 'free')
        .toList();
    final available = plans.where(
      (plan) => state.storeProducts.containsKey(plan.sku) && !_isCurrent(plan),
    );
    final selected =
        (included ? plans.where(_isCurrent).firstOrNull : null) ??
        plans.where((plan) => plan.sku == _selectedSku).firstOrNull ??
        nextBetterPlan(available.toList(), state.billing?.planTier ?? 'free') ??
        available.firstOrNull ??
        plans.firstOrNull;
    final pending = state.pendingProductIds.isNotEmpty;
    final busy = pending || state.restoring || state.subscriptionBusy;
    final canBuy =
        selected != null &&
        !included &&
        !state.loading &&
        state.storeAvailable &&
        state.storeProducts.containsKey(selected.sku) &&
        !_isCurrent(selected) &&
        !busy;
    final storeDown = !state.loading && !state.storeAvailable;
    final forSale = plans.where((plan) => !_isCurrent(plan)).toList();
    final unpriced = state.unpricedAmong(forSale);
    final canRetry =
        !included &&
        !busy &&
        (storeDown ||
            (selected != null && unpriced.any((p) => p.sku == selected.sku)));
    final maxPages = state.billing?.paidMaxBookPages ?? maxPlanBookPages;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.94,
      minChildSize: 0.65,
      maxChildSize: 0.98,
      builder: (context, scrollController) => Column(
        children: [
          Expanded(
            child: ListView(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
              children: [
                _FirstBookHero(
                  bookTitle: widget.bookTitle,
                  onClose: widget.onClose,
                ),
                const SizedBox(height: AppSpacing.lg),
                _FirstBookPerks(maxPages: maxPages),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  included ? 'Your plan is ready' : 'Choose your plan',
                  style: text.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                if (state.loading)
                  const BillingPlanSkeleton(cards: 1)
                else if (plans.isEmpty)
                  AppInlineNotice(
                    icon: Icons.wifi_off_rounded,
                    title: 'Plans could not be loaded',
                    message: 'Try again to see your subscription options.',
                    actionLabel: 'Try again',
                    onAction: widget.onRetry,
                  )
                else ...[
                  for (final plan in plans) ...[
                    BillingProductOption(
                      key: ValueKey('first-book-plan-${plan.sku}'),
                      product: plan,
                      storeProduct: state.storeProducts[plan.sku],
                      selected: plan.sku == selected?.sku,
                      isCurrent: _isCurrent(plan),
                      recommendation:
                          billingTierForSku(plan.sku) == 'creator' &&
                              !_isCurrent(plan) &&
                              state.storeProducts.containsKey(plan.sku)
                          ? 'Start here'
                          : null,
                      onSelect: busy || included
                          ? null
                          : () {
                              AppHaptics.selection();
                              setState(() => _selectedSku = plan.sku);
                            },
                    ),
                    const SizedBox(height: AppSpacing.xs),
                  ],
                  if (storeDown || unpriced.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4, bottom: 8),
                      child: BillingStorePricesNotice(
                        storeDown: storeDown,
                        allUnpriced: unpriced.length == forSale.length,
                        onRetry: busy ? null : widget.onRetry,
                      ),
                    ),
                ],
                const SizedBox(height: AppSpacing.sm),
                if (!included) ...[
                  Text(
                    '${selected?.renewsLabel ?? 'Renews monthly'}; cancel '
                    'anytime in Google Play. Books you have already made stay '
                    'yours.',
                    textAlign: TextAlign.center,
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Center(
                    child: AppButton.text(
                      key: const ValueKey('first-book-keep-free'),
                      onPressed: widget.onClose,
                      label: 'Keep reading for free',
                    ),
                  ),
                ],
                Center(
                  child: AppButton.text(
                    onPressed: busy || state.loading ? null : widget.onRestore,
                    loading: state.restoring,
                    loadingLabel: 'Restoring purchases',
                    label: 'Restore purchases',
                  ),
                ),
              ],
            ),
          ),
          BillingExportCheckout(
            format: '',
            includedLabel: 'Your plan is active.',
            unlockLabel: (name) => 'Start $name',
            includedActionLabel: 'Back to your book',
            buttonKey: const ValueKey('first-book-upgrade'),
            product: selected,
            storeProduct: state.storeProducts[selected?.sku],
            loading: state.loading,
            pending: pending,
            restoring: state.restoring,
            accessIncluded: included,
            isCurrent: selected != null && _isCurrent(selected),
            error: state.error,
            message: state.message,
            onBuy: included
                ? widget.onClose
                : canBuy
                ? () => widget.onBuy(selected)
                : null,
            onRetry: canRetry ? widget.onRetry : null,
          ),
        ],
      ),
    );
  }
}

class _FirstBookHero extends StatelessWidget {
  const _FirstBookHero({required this.bookTitle, required this.onClose});

  final String bookTitle;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final title = bookTitle.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'YOUR FIRST BOOK IS READY',
                style: text.labelSmall?.copyWith(
                  color: colors.primary,
                  letterSpacing: 1.8,
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
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text(
                  title.isEmpty ? 'You made a book.' : '“$title”\nis yours.',
                  style: text.headlineMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    height: 1.1,
                    letterSpacing: -0.7,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
            ExcludeSemantics(
              child: Transform.rotate(
                angle: -0.08,
                child: Container(
                  width: 62,
                  height: 76,
                  decoration: BoxDecoration(
                    color: colors.primaryContainer,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Icon(
                    Icons.auto_stories_rounded,
                    size: 36,
                    color: colors.onPrimaryContainer,
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          'Read it, download it, share it — it is yours. A plan makes room for '
          'the next one.',
          style: text.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
        ),
      ],
    );
  }
}

class _FirstBookPerks extends StatelessWidget {
  const _FirstBookPerks({required this.maxPages});

  final int maxPages;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'What a plan adds',
            style: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.auto_stories_outlined,
            title: 'Credits every month',
            description:
                'A fresh allowance for your next books, edits and pictures.',
          ),
          const SizedBox(height: 14),
          _Perk(
            icon: Icons.menu_book_outlined,
            title: 'Books up to $maxPages pages',
            description: 'Room for every chapter, scene and example.',
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.palette_outlined,
            title: 'More illustrated books',
            description: 'No monthly cap on books with pictures.',
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.description_outlined,
            title: 'Word export',
            description: 'Download any book as an editable Word file.',
          ),
          const SizedBox(height: 14),
          const _Perk(
            icon: Icons.record_voice_over_outlined,
            title: 'Voice calls and audiobooks',
            description:
                'Talk with your characters, and hear your books read aloud.',
          ),
        ],
      ),
    );
  }
}

class _Perk extends StatelessWidget {
  const _Perk({
    required this.icon,
    required this.title,
    required this.description,
  });

  final IconData icon;
  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: colors.primary, size: 22),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: text.bodyMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 2),
              Text(
                description,
                style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
