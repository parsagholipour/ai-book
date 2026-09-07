import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_export_offer_details.dart';
import 'billing_export_plan_option.dart';
import 'billing_plan_tiles.dart';
import 'billing_tier_style.dart';

/// A subscription offer for someone trying to export their book. Plan choices
/// share one checkout action; selecting a plan never starts a purchase.
class BillingExportOffer extends StatefulWidget {
  const BillingExportOffer({
    required this.format,
    required this.state,
    required this.plans,
    required this.onBuy,
    required this.onRestore,
    required this.onRetry,
    required this.onClose,
    super.key,
  });

  final String format;
  final BillingPurchaseState state;
  final List<MobileBillingProduct> plans;
  final ValueChanged<MobileBillingProduct> onBuy;
  final VoidCallback onRestore;
  final VoidCallback onRetry;
  final VoidCallback onClose;

  @override
  State<BillingExportOffer> createState() => _BillingExportOfferState();
}

class _BillingExportOfferState extends State<BillingExportOffer> {
  String? _selectedSku;

  bool _isCurrent(MobileBillingProduct plan) =>
      plan.sku == widget.state.billing?.plan?.productSku ||
      billingTierForSku(plan.sku) == widget.state.billing?.planTier;

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final accessIncluded = state.billing?.hasCreatorSubscription ?? false;
    // Only known paid tiers grant the export entitlement. A future product must
    // not be presented as unlocking Word until its entitlement is understood.
    final plans = widget.plans
        .where((plan) => billingTierForSku(plan.sku) != 'free')
        .toList();
    final available = plans.where(
      (plan) => state.storeProducts.containsKey(plan.sku) && !_isCurrent(plan),
    );
    final next = nextBetterPlan(
      available.toList(),
      state.billing?.planTier ?? 'free',
    );
    final selected =
        (accessIncluded ? plans.where(_isCurrent).firstOrNull : null) ??
        plans.where((plan) => plan.sku == _selectedSku).firstOrNull ??
        next ??
        available.firstOrNull ??
        plans.firstOrNull;
    final pending = state.pendingProductIds.isNotEmpty;
    final busy = pending || state.restoring || state.subscriptionBusy;
    final canBuy =
        selected != null &&
        !accessIncluded &&
        !state.loading &&
        state.storeAvailable &&
        state.storeProducts.containsKey(selected.sku) &&
        !_isCurrent(selected) &&
        !busy;
    final pricedPlans = plans
        .where((plan) => state.storeProducts.containsKey(plan.sku))
        .toList();
    final currencies = pricedPlans
        .map((plan) => state.storeProducts[plan.sku]!.currencyCode)
        .toSet();
    final value = currencies.length == 1
        ? billingPlanValue(pricedPlans, state.storeProducts)
        : BillingPlanValue.empty;

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
                BillingExportHero(
                  format: widget.format,
                  onClose: widget.onClose,
                ),
                const SizedBox(height: 20),
                Text(
                  accessIncluded ? 'Your plan is ready' : 'Choose your plan',
                  style: text.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  accessIncluded
                      ? 'Your subscription includes ${widget.format} export.'
                      : 'Every plan below includes ${widget.format} export.',
                  style: text.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 12),
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
                      key: ValueKey('export-plan-${plan.sku}'),
                      product: plan,
                      storeProduct: state.storeProducts[plan.sku],
                      selected: plan.sku == selected?.sku,
                      isCurrent: _isCurrent(plan),
                      format: widget.format,
                      bestValue: plan.sku == value.bestValueSku,
                      onSelect: busy || accessIncluded
                          ? null
                          : () {
                              AppHaptics.selection();
                              setState(() => _selectedSku = plan.sku);
                            },
                    ),
                    const SizedBox(height: 8),
                  ],
                  if (!state.storeAvailable ||
                      state.missingProductIds.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4, bottom: 8),
                      child: Text(
                        'Some plans are temporarily unavailable from Google Play.',
                        style: text.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
                const SizedBox(height: 12),
                BillingExportOfferDetails(
                  format: widget.format,
                  freeTier: state.billing?.freeTier ?? const MobileFreeTier(),
                  isFree: !(state.billing?.isPaidPlan ?? false),
                  onClose: widget.onClose,
                ),
                const SizedBox(height: 8),
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
            format: widget.format,
            product: selected,
            storeProduct: state.storeProducts[selected?.sku],
            loading: state.loading,
            pending: pending,
            restoring: state.restoring,
            accessIncluded: accessIncluded,
            isCurrent: selected != null && _isCurrent(selected),
            error: state.error,
            message: state.message,
            onBuy: accessIncluded
                ? widget.onClose
                : canBuy
                ? () => widget.onBuy(selected)
                : null,
          ),
        ],
      ),
    );
  }
}
