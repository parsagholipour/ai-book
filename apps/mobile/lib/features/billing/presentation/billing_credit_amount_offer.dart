import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/credit_purchase_quote.dart';
import 'billing_controller.dart';
import 'billing_offer_checkout.dart';
import 'billing_plan_tiles.dart';
import 'billing_product_option.dart';
import 'billing_shared_parts.dart';

/// Turns an amount into a real pack purchase. The checkout always describes
/// one transaction, even when reaching the requested goal takes several.
class BillingCreditAmountOffer extends StatelessWidget {
  const BillingCreditAmountOffer({
    required this.state,
    required this.amount,
    required this.quote,
    required this.onSetAmount,
    required this.onCoverShortfall,
    required this.onBuy,
    required this.onRetry,
    required this.onClose,
    this.shortfall,
    this.requiredCredits,
    this.onSeePlans,
    super.key,
  });

  final BillingPurchaseState state;
  final TextEditingController amount;
  final CreditQuote quote;
  final int? shortfall;
  final int? requiredCredits;
  final ValueChanged<int> onSetAmount;
  final VoidCallback onCoverShortfall;
  final VoidCallback? onBuy;
  final VoidCallback onRetry;
  final VoidCallback onClose;
  final VoidCallback? onSeePlans;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final busy = state.pendingProductIds.isNotEmpty || state.restoring;
    final best = quote.best;
    // Smallest first: a row of amounts reads left to right, or top to bottom,
    // as a ladder. The quote itself is sorted by price per credit.
    final packs = [...quote.options]
      ..sort((a, b) => a.credits.compareTo(b.credits));
    final bestRate = quote.options.isEmpty ? null : quote.options.first;
    final available = state.billing?.credits.available;
    final requested = int.tryParse(amount.text) ?? 0;
    final storeDown = !state.loading && !state.storeAvailable;

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: DraggableScrollableSheet(
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
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.only(top: AppSpacing.sm),
                          child: Semantics(
                            header: true,
                            child: Text(
                              'How much room\ndo you need?',
                              style: text.headlineSmall?.copyWith(
                                fontWeight: FontWeight.w800,
                                height: 1.15,
                              ),
                            ),
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
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    available == null
                        ? 'Choose an amount. We’ll find the pack that fits.'
                        : 'You have ${formatCredits(available)} credits. We’ll find the pack that fits your goal.',
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  TextField(
                    key: const ValueKey('buy-credits-amount'),
                    controller: amount,
                    enabled: !busy,
                    keyboardType: TextInputType.number,
                    textInputAction: TextInputAction.done,
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(6),
                    ],
                    style: text.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                    decoration: InputDecoration(
                      labelText: 'How many credits?',
                      suffixText: 'credits',
                      errorText: requested <= 0
                          ? 'Enter at least 1 credit.'
                          : null,
                    ),
                  ),
                  if (shortfall != null && shortfall! > 0) ...[
                    const SizedBox(height: AppSpacing.xs),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: ActionChip(
                        key: const ValueKey('buy-credits-cover-shortfall'),
                        avatar: const Icon(
                          Icons.check_circle_outline,
                          size: 16,
                        ),
                        label: const Text('Cover my shortfall'),
                        onPressed: busy ? null : onCoverShortfall,
                      ),
                    ),
                  ],
                  if (!state.loading && best != null) ...[
                    const SizedBox(height: AppSpacing.sm),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.primaryContainer.withValues(alpha: 0.6),
                        borderRadius: BorderRadius.circular(AppRadii.control),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.sm),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(
                              Icons.info_outline,
                              size: 18,
                              color: colors.onPrimaryContainer,
                            ),
                            const SizedBox(width: AppSpacing.xs),
                            Expanded(
                              child: Text(
                                quote.quantity > 1
                                    ? 'Your ${formatCredits(quote.credits)}-credit goal needs ${quote.quantity} purchases of this pack. '
                                          '${formatCredits(quote.creditsDelivered)} credits cost ${quote.totalLabel} in total. '
                                          'The button below buys one pack for ${best.unitLabel}.'
                                    : quote.surplus == 0
                                    ? 'Exactly what you asked for. No subscription.'
                                    : 'Covers your ${formatCredits(quote.credits)}, with ${formatCredits(quote.surplus)} to spare.',
                                key: const ValueKey('buy-credits-explanation'),
                                style: text.bodySmall?.copyWith(
                                  color: colors.onPrimaryContainer,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.md),
                  if (packs.isNotEmpty || state.loading)
                    Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.xs),
                      child: Semantics(
                        header: true,
                        child: Text(
                          'Or pick a pack',
                          style: text.titleSmall?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                    ),
                  if (state.loading)
                    const BillingPlanSkeleton(cards: 2)
                  else ...[
                    if (packs.isNotEmpty)
                      _PackGrid(
                        children: [
                          for (final option in packs)
                            _PackChoice(
                              key: ValueKey(
                                'buy-credits-pack-${option.product.sku}',
                              ),
                              option: option,
                              selected: best?.product.sku == option.product.sku,
                              bestRate:
                                  packs.length > 1 &&
                                  bestRate?.product.sku == option.product.sku,
                              onSelect: busy
                                  ? null
                                  : () => onSetAmount(option.credits),
                            ),
                        ],
                      ),
                    if (best == null && requested > 0)
                      AppInlineNotice(
                        tone: storeDown ? AppTone.warning : AppTone.neutral,
                        icon: storeDown
                            ? Icons.cloud_off_outlined
                            : Icons.info_outline,
                        title: 'Credit packs are unavailable',
                        message: storeDown
                            ? 'Google Play is not reachable right now. Try again in a moment.'
                            : 'We couldn’t load a pack from Google Play. Try again in a moment.',
                        actionLabel: 'Try again',
                        onAction: onRetry,
                      ),
                  ],
                  if (onSeePlans != null) ...[
                    const SizedBox(height: AppSpacing.md),
                    AppInlineNotice(
                      icon: Icons.auto_stories_outlined,
                      title: quote.betterPlan != null
                          ? 'A monthly plan costs less upfront'
                          : 'Need credits every month?',
                      message: quote.betterPlan != null
                          ? '${billingPlanName(quote.betterPlan!)} includes ${formatCredits(quote.betterPlan!.creditAmount)} credits for ${quote.betterPlanPriceLabel} per month. Renews monthly.'
                          : 'Compare monthly credits, Word exports, and manuscript import.',
                    ),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: AppButton.text(
                        key: const ValueKey('buy-credits-see-plans'),
                        onPressed: busy ? null : onSeePlans,
                        label: 'See plans',
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.md),
                  Text(
                    'Purchased credits never expire. They are spent after your monthly '
                    'allowance, and your current plan stays the same.',
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            BillingOfferCheckout(
              key: const ValueKey('buy-credits-checkout'),
              buttonKey: const ValueKey('buy-credits-buy'),
              state: state,
              unavailableLabel: requested <= 0
                  ? 'Enter an amount to continue'
                  : 'Temporarily unavailable',
              product: best?.product,
              requiredCredits: requiredCredits,
              onBuy: onBuy,
              onRetry: onRetry,
            ),
          ],
        ),
      ),
    );
  }
}

/// The packs as a row of cards — a ladder of amounts read at a glance — that
/// stacks into one column when type is large enough to need the width.
class _PackGrid extends StatelessWidget {
  const _PackGrid({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final columns = billingLargeText(context)
        ? 1
        : children.length <= 3
        ? children.length
        : 2;
    return LayoutBuilder(
      builder: (context, constraints) {
        const gap = AppSpacing.xs;
        final width = (constraints.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final child in children) SizedBox(width: width, child: child),
          ],
        );
      },
    );
  }
}

/// One pack: how many credits and what they cost. The selected pack is the one
/// the checkout bar will buy, so tapping a card and typing an amount agree.
class _PackChoice extends StatelessWidget {
  const _PackChoice({
    required this.option,
    required this.selected,
    required this.bestRate,
    required this.onSelect,
    super.key,
  });

  final CreditPurchaseOption option;
  final bool selected;
  final bool bestRate;
  final VoidCallback? onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final credits = '${formatCredits(option.credits)} credits';
    final enabled = onSelect != null;
    return Semantics(
      container: true,
      button: true,
      selected: selected,
      enabled: enabled,
      inMutuallyExclusiveGroup: true,
      onTap: onSelect,
      label:
          '$credits, ${option.unitLabel}, one time'
          '${bestRate ? ', best price per credit' : ''}',
      child: ExcludeSemantics(
        child: Material(
          color: selected
              ? colors.primaryContainer
              : colors.surfaceContainerLowest,
          animationDuration: AppMotion.reducedMotion(context)
              ? Duration.zero
              : AppMotion.fast,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.card),
            side: BorderSide(
              color: selected ? colors.primary : colors.outlineVariant,
              width: selected ? 2 : 1,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onSelect,
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    selected
                        ? Icons.check_circle_rounded
                        : Icons.circle_outlined,
                    size: 22,
                    color: selected ? colors.primary : colors.outline,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  // One line, shrunk if it must: "1,000" and "credits" split
                  // over two lines make three cards look like three sizes.
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: AlignmentDirectional.centerStart,
                    child: Text(
                      credits,
                      maxLines: 1,
                      softWrap: false,
                      style: text.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  Text(
                    option.unitLabel,
                    style: text.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  Text(
                    bestRate ? 'Best per credit' : 'One time',
                    style: text.labelSmall?.copyWith(
                      color: bestRate
                          ? colors.primary
                          : colors.onSurfaceVariant,
                      fontWeight: bestRate ? FontWeight.w800 : FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
