import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/credit_purchase_quote.dart';
import 'billing_controller.dart';
import 'billing_offer_checkout.dart';
import 'billing_plan_tiles.dart';
import 'billing_product_option.dart';

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
    final presets =
        quote.options.map((option) => option.credits).toSet().toList()..sort();
    final available = state.billing?.credits.available;
    final requested = int.tryParse(amount.text) ?? 0;

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
                    children: [
                      Expanded(
                        child: Text(
                          'CREDITS, ON YOUR TERMS',
                          style: text.labelSmall?.copyWith(
                            color: colors.primary,
                            letterSpacing: 1.2,
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
                    'How much room\ndo you need?',
                    style: text.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                      height: 1.15,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    available == null
                        ? 'Choose an amount. We’ll find the pack that fits.'
                        : 'You have ${formatCredits(available)} credits. We’ll find the pack that fits your goal.',
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 18),
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
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      if (shortfall != null && shortfall! > 0)
                        ActionChip(
                          key: const ValueKey('buy-credits-cover-shortfall'),
                          avatar: const Icon(
                            Icons.check_circle_outline,
                            size: 16,
                          ),
                          label: const Text('Cover my shortfall'),
                          onPressed: busy ? null : onCoverShortfall,
                        ),
                      for (final credits in presets)
                        ActionChip(
                          label: Text(formatCredits(credits)),
                          onPressed: busy ? null : () => onSetAmount(credits),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (state.loading)
                    const BillingPlanSkeleton(cards: 1)
                  else if (best != null) ...[
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: colors.primaryContainer,
                        borderRadius: BorderRadius.circular(AppRadii.card),
                        border: Border.all(
                          color: colors.primary.withValues(alpha: 0.5),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            quote.quantity == 1
                                ? 'A pack that fits your goal'
                                : 'Start with this pack',
                            style: text.labelLarge?.copyWith(
                              color: colors.onPrimaryContainer,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            '${formatCredits(best.credits)} credits',
                            style: text.headlineSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
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
                            ),
                          ),
                        ],
                      ),
                    ),
                  ] else if (requested > 0)
                    AppInlineNotice(
                      title: 'Credit packs are unavailable',
                      message:
                          'We couldn’t load a pack from Google Play. Try again in a moment.',
                      actionLabel: 'Try again',
                      onAction: onRetry,
                    ),
                  if (onSeePlans != null) ...[
                    const SizedBox(height: 16),
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
                      alignment: Alignment.centerLeft,
                      child: AppButton.text(
                        key: const ValueKey('buy-credits-see-plans'),
                        onPressed: busy ? null : onSeePlans,
                        label: 'See plans',
                      ),
                    ),
                  ],
                  const SizedBox(height: 16),
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
            ),
          ],
        ),
      ),
    );
  }
}
