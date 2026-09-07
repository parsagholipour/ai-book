import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_plan_tiles.dart';
import 'billing_product_option.dart';

/// The exact next purchase, outside the scrolling offer. Multi-pack goals still
/// charge for one pack here; the total goal belongs in the quote above it.
class BillingOfferCheckout extends StatelessWidget {
  const BillingOfferCheckout({
    required this.state,
    required this.product,
    required this.onBuy,
    this.requiredCredits,
    this.isCurrent = false,
    this.covered = false,
    this.unavailableLabel = 'Temporarily unavailable',
    this.onDone,
    this.buttonKey = const ValueKey('paywall-checkout-buy'),
    super.key,
  });

  final BillingPurchaseState state;
  final MobileBillingProduct? product;
  final int? requiredCredits;
  final bool isCurrent;
  final bool covered;
  final String unavailableLabel;
  final VoidCallback? onBuy;
  final VoidCallback? onDone;
  final Key buttonKey;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final item = product;
    final store = state.storeProducts[item?.sku];
    final pending = state.pendingProductIds.isNotEmpty;
    final busy = pending || state.restoring || state.subscriptionBusy;
    final enabled =
        item != null &&
        store != null &&
        state.storeAvailable &&
        !state.loading &&
        !busy &&
        !isCurrent;
    final status = state.error ?? state.message;
    final subscription = item?.isSubscription ?? false;
    final after = !subscription && item != null && state.billing != null
        ? state.billing!.credits.available + item.creditAmount
        : null;
    final remaining = after == null || requiredCredits == null
        ? null
        : (requiredCredits! - after).clamp(0, requiredCredits!);

    return Container(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (status != null) ...[
            Semantics(
              liveRegion: true,
              child: Text(
                status,
                style: text.bodySmall?.copyWith(
                  color: state.error == null
                      ? colors.onSurfaceVariant
                      : colors.error,
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
          if (covered || (item != null && !state.loading)) ...[
            Text(
              covered
                  ? 'You have enough credits to continue.'
                  : '${subscription ? billingPlanName(item!) : '${formatCredits(item!.creditAmount)} credits'}'
                        ' · ${store?.price ?? fallbackPrice(item)} ${subscription ? '/ month' : 'once'}',
              textAlign: TextAlign.center,
              style: text.labelLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
          ],
          AppButton.primary(
            key: covered ? const ValueKey('paywall-credits-done') : buttonKey,
            onPressed: covered
                ? onDone
                : enabled
                ? onBuy
                : null,
            loading: busy,
            loadingLabel: state.restoring
                ? 'Restoring purchases'
                : 'Purchase pending',
            label: covered
                ? 'Back to your book'
                : state.loading
                ? 'Loading options…'
                : isCurrent
                ? 'Your current plan'
                : !enabled
                ? unavailableLabel
                : subscription
                ? 'Choose ${billingPlanName(item)}'
                : 'Add ${formatCredits(item.creditAmount)} credits',
          ),
          const SizedBox(height: 8),
          Text(
            covered
                ? 'Return to your book and try again.'
                : subscription
                ? 'Renews monthly · Cancel anytime in Google Play'
                : 'One-time purchase · Credits never expire',
            textAlign: TextAlign.center,
            style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
          ),
          if (!covered && after != null) ...[
            const SizedBox(height: 4),
            Text(
              'Balance after this pack: ${formatCredits(after)}'
              '${remaining == null
                  ? ' credits'
                  : remaining == 0
                  ? ' · Enough to continue'
                  : ' · ${formatCredits(remaining)} more needed'}',
              key: const ValueKey('purchase-balance-after'),
              textAlign: TextAlign.center,
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}
