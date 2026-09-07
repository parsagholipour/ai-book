import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/billing_models.dart';
import '../domain/credit_purchase_quote.dart';
import 'billing_controller.dart';
import 'billing_credits_needed.dart';
import 'billing_free_plan_card.dart';
import 'billing_offer_checkout.dart';
import 'billing_offer_content.dart';
import 'billing_plan_tiles.dart';
import 'billing_product_option.dart';
import 'billing_tier_style.dart';

/// Browsing leads with plans; a blocked action leads with the pack that covers
/// its shortfall. Both options stay one tap away and share one checkout.
class BillingOffers extends StatefulWidget {
  const BillingOffers({
    required this.state,
    required this.onBuy,
    required this.onClose,
    required this.onRestore,
    required this.onRetry,
    required this.onCustomAmount,
    required this.onSwitchToFree,
    this.title,
    this.message,
    this.creditsNeeded,
    super.key,
  });

  final BillingPurchaseState state;
  final ValueChanged<MobileBillingProduct> onBuy;
  final VoidCallback onClose;
  final VoidCallback onRestore;
  final VoidCallback onRetry;
  final void Function(int? shortfall, VoidCallback onSeePlans) onCustomAmount;
  final VoidCallback? onSwitchToFree;
  final String? title;
  final String? message;
  final PaywallCreditsNeeded? creditsNeeded;

  @override
  State<BillingOffers> createState() => _BillingOffersState();
}

class _BillingOffersState extends State<BillingOffers> {
  bool? _monthly;
  String? _planSku;
  String? _packSku;
  ScrollController? _scrollController;

  bool _isCurrent(MobileBillingProduct product) =>
      product.isSubscription &&
      (product.sku == widget.state.billing?.plan?.productSku ||
          billingTierForSku(product.sku) == widget.state.billing?.planTier);

  void _chooseMode(bool monthly) {
    AppHaptics.selection();
    setState(() => _monthly = monthly);
  }

  void _showPlans() {
    if (!mounted) return;
    _chooseMode(true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final scroll = _scrollController;
      if (mounted && scroll != null && scroll.hasClients) scroll.jumpTo(0);
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final billing = state.billing;
    final plans =
        billing?.products.where((p) => p.isSubscription).toList() ?? [];
    plans.sort(
      (a, b) => planTierOrder
          .indexOf(billingTierForSku(a.sku))
          .compareTo(planTierOrder.indexOf(billingTierForSku(b.sku))),
    );
    final topUps =
        billing?.products.where((p) => !p.isSubscription).toList() ?? [];
    final packs = topUps.where((p) => p.productType == 'CREDIT_PACK').toList();
    final choices = packs.isEmpty ? topUps : packs;
    choices.sort((a, b) => a.creditAmount.compareTo(b.creditAmount));
    final monthly =
        _monthly ?? (widget.creditsNeeded == null || choices.isEmpty);
    final shortfall = widget.creditsNeeded?.shortfallFrom(
      billing?.credits.available,
    );
    final quote = quotePurchasableCredits(
      credits: shortfall ?? 1000,
      products: topUps,
      storeProducts: state.storeProducts,
      plans: billing?.isPaidPlan == true ? const [] : plans,
    );
    final availablePlans = plans
        .where((p) => state.storeProducts.containsKey(p.sku) && !_isCurrent(p))
        .toList();
    final defaultPlan =
        quote.betterPlan ??
        nextBetterPlan(availablePlans, billing?.planTier ?? 'free') ??
        plans.where(_isCurrent).firstOrNull ??
        availablePlans.firstOrNull;
    final options = monthly ? plans : choices;
    final selection = monthly ? _planSku : _packSku;
    final selected =
        options.where((p) => p.sku == selection).firstOrNull ??
        (monthly ? defaultPlan : quote.best?.product) ??
        options.firstOrNull;
    final busy =
        state.pendingProductIds.isNotEmpty ||
        state.restoring ||
        state.subscriptionBusy;
    final pricedPlans = plans
        .where((p) => state.storeProducts.containsKey(p.sku))
        .toList();
    final currencies = pricedPlans
        .map((p) => state.storeProducts[p.sku]!.currencyCode)
        .toSet();
    final value = currencies.length == 1
        ? billingPlanValue(pricedPlans, state.storeProducts)
        : BillingPlanValue.empty;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.94,
      minChildSize: 0.65,
      maxChildSize: 0.98,
      builder: (context, scrollController) {
        _scrollController = scrollController;
        return Column(
          children: [
            Expanded(
              child: ListView(
                controller: scrollController,
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
                children: [
                  BillingOfferHeader(
                    key: widget.creditsNeeded == null
                        ? null
                        : const ValueKey('paywall-credits-needed'),
                    billing: billing,
                    creditsNeeded: widget.creditsNeeded,
                    title: widget.title,
                    message: widget.message,
                    onClose: widget.onClose,
                  ),
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    child: SegmentedButton<bool>(
                      showSelectedIcon: false,
                      segments: const [
                        ButtonSegment(
                          value: true,
                          label: Text(
                            'Monthly plans',
                            key: ValueKey('paywall-upgrade-plan'),
                          ),
                        ),
                        ButtonSegment(
                          value: false,
                          label: Text(
                            'One-time credits',
                            key: ValueKey('paywall-buy-credits'),
                          ),
                        ),
                      ],
                      selected: {monthly},
                      onSelectionChanged: busy
                          ? null
                          : (selection) => _chooseMode(selection.single),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    monthly
                        ? 'Monthly credits + Word export + manuscript import'
                        : 'Pay once. Keep your credits until you need them.',
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (state.loading)
                    const BillingPlanSkeleton(cards: 1)
                  else if (options.isEmpty)
                    AppInlineNotice(
                      title:
                          'No ${monthly ? 'plans' : 'credit packs'} available right now',
                      message: 'Try again to refresh your purchase options.',
                      actionLabel: 'Try again',
                      onAction: widget.onRetry,
                    )
                  else
                    for (final product in options) ...[
                      BillingProductOption(
                        key: ValueKey(
                          'paywall-${monthly ? 'plan' : 'topup'}-${product.sku}',
                        ),
                        product: product,
                        storeProduct: state.storeProducts[product.sku],
                        selected: selected?.sku == product.sku,
                        isCurrent: _isCurrent(product),
                        bestValue: monthly && product.sku == value.bestValueSku,
                        recommendation: monthly
                            ? product.sku == defaultPlan?.sku
                                  ? 'Recommended'
                                  : null
                            : shortfall != null &&
                                  shortfall > 0 &&
                                  product.sku == quote.best?.product.sku
                            ? quote.quantity == 1
                                  ? 'Covers your gap'
                                  : 'Best per credit'
                            : null,
                        onSelect: busy
                            ? null
                            : () {
                                AppHaptics.selection();
                                setState(() {
                                  if (monthly) {
                                    _planSku = product.sku;
                                  } else {
                                    _packSku = product.sku;
                                  }
                                });
                              },
                      ),
                      const SizedBox(height: 8),
                    ],
                  if (!state.loading && !state.storeAvailable) ...[
                    const SizedBox(height: 4),
                    AppInlineNotice(
                      title: 'Google Play is unavailable',
                      message:
                          'Purchases are temporarily unavailable. Your current credits and books are still here.',
                      actionLabel: 'Try again',
                      onAction: widget.onRetry,
                    ),
                  ],
                  if (!monthly && choices.isNotEmpty) ...[
                    Align(
                      alignment: Alignment.centerLeft,
                      child: AppButton.text(
                        key: const ValueKey('paywall-choose-amount'),
                        onPressed: busy
                            ? null
                            : () =>
                                  widget.onCustomAmount(shortfall, _showPlans),
                        leading: const Icon(Icons.calculate_outlined, size: 18),
                        label: 'Choose an amount',
                      ),
                    ),
                    if (plans.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      AppInlineNotice(
                        icon: Icons.auto_stories_outlined,
                        title: quote.betterPlan != null
                            ? 'More credits for less upfront'
                            : 'Writing more than one book?',
                        message: quote.betterPlan != null
                            ? '${billingPlanName(quote.betterPlan!)} includes ${formatCredits(quote.betterPlan!.creditAmount)} credits for ${quote.betterPlanPriceLabel} per month. Renews monthly.'
                            : 'Get credits every month, Word exports, and manuscript import with a plan.',
                        actionLabel: 'Compare monthly plans',
                        onAction: busy ? null : _showPlans,
                      ),
                    ],
                  ],
                  const SizedBox(height: 16),
                  BillingOfferDetails(monthly: monthly),
                  if (monthly) ...[
                    const SizedBox(height: 16),
                    BillingFreePlanCard(
                      key: const ValueKey('paywall-plan-free'),
                      freeTier: billing?.freeTier ?? const MobileFreeTier(),
                      isCurrentPlan: !(billing?.isPaidPlan ?? false),
                      onSwitchToFree: busy ? null : widget.onSwitchToFree,
                    ),
                  ] else if (packs.isNotEmpty) ...[
                    for (final product in topUps.where(
                      (p) => p.productType != 'CREDIT_PACK',
                    )) ...[
                      const SizedBox(height: 12),
                      BillingTopUpTile(
                        key: ValueKey('paywall-topup-${product.sku}'),
                        product: product,
                        storeProduct: state.storeProducts[product.sku],
                        pending: busy,
                        onBuy: () => widget.onBuy(product),
                      ),
                    ],
                  ],
                  const SizedBox(height: 12),
                  BillingOfferFooter(
                    restoring: state.restoring,
                    onRestore: busy || state.loading ? null : widget.onRestore,
                  ),
                ],
              ),
            ),
            BillingOfferCheckout(
              key: const ValueKey('paywall-checkout'),
              state: state,
              product: selected,
              requiredCredits: widget.creditsNeeded?.credits,
              isCurrent: selected != null && _isCurrent(selected),
              covered: shortfall == 0,
              onDone: widget.onClose,
              onBuy: selected == null ? null : () => widget.onBuy(selected),
            ),
          ],
        );
      },
    );
  }
}
