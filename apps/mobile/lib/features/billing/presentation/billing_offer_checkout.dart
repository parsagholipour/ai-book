import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_plan_tiles.dart';
import 'billing_product_option.dart';
import 'billing_shared_parts.dart';
import 'billing_tier_style.dart';

/// The exact next purchase, outside the scrolling offer. Multi-pack goals still
/// charge for one pack here; the total goal belongs in the quote above it.
///
/// It is the one place a purchase starts, so everything the reader needs to
/// agree to sits in it: what is being bought, the price, how it renews, and
/// what happened if the last attempt failed.
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
    this.onRetry,
    this.onManage,
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

  /// Offered instead of a dead button while Google Play cannot be reached.
  final VoidCallback? onRetry;

  /// Where someone already on this plan goes to change or cancel it.
  final VoidCallback? onManage;
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
    final storeDown = !state.loading && !state.storeAvailable && !covered;
    final canRetry = storeDown && onRetry != null && !busy;
    final status = state.error ?? state.message;
    final subscription = item?.isSubscription ?? false;
    final switching =
        subscription &&
        !isCurrent &&
        state.billing?.plan != null &&
        state.billing!.plan!.tier != 'free';
    final after = !subscription && item != null && state.billing != null
        ? state.billing!.credits.available + item.creditAmount
        : null;
    final remaining = after == null || requiredCredits == null
        ? null
        : (requiredCredits! - after).clamp(0, requiredCredits!);
    final VoidCallback? action = covered
        ? onDone
        : enabled
        ? () {
            AppHaptics.commit();
            onBuy?.call();
          }
        : canRetry
        ? onRetry
        : null;

    return Container(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg - 4,
        AppSpacing.sm,
        AppSpacing.lg - 4,
        AppSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (status != null) ...[
            BillingNoticeLine(
              message: status,
              tone: state.error == null ? AppTone.neutral : AppTone.error,
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
          // The chosen row already shows this price, and while Play is down the
          // price is not something anyone can pay. At large text the line is
          // also the difference between seeing the button and not.
          if (covered ||
              (item != null &&
                  !state.loading &&
                  !storeDown &&
                  !billingLargeText(context))) ...[
            Text(
              covered
                  ? 'You have enough credits to continue.'
                  : '${subscription ? billingPlanName(item!) : '${formatCredits(item!.creditAmount)} credits'}'
                        ' · ${store?.price ?? fallbackPrice(item)} ${subscription ? '/ month' : 'once'}',
              textAlign: TextAlign.center,
              style: text.labelLarge?.copyWith(fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: AppSpacing.xs),
          ],
          AppButton.primary(
            key: covered ? const ValueKey('paywall-credits-done') : buttonKey,
            onPressed: action,
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
                : canRetry
                ? 'Try again'
                : !enabled
                ? unavailableLabel
                : subscription
                ? planCallToAction(item, state.billing?.planTier)
                : 'Add ${formatCredits(item.creditAmount)} credits',
          ),
          const SizedBox(height: AppSpacing.xxs),
          if (isCurrent && onManage != null)
            Center(
              child: AppButton.text(
                key: const ValueKey('paywall-manage-plan'),
                onPressed: onManage,
                leading: const Icon(Icons.open_in_new, size: 18),
                label: 'Manage or cancel in Google Play',
              ),
            )
          else
            Text(
              covered
                  ? 'Return to your book and try again.'
                  : storeDown
                  ? 'Google Play is not reachable right now.'
                  : switching
                  ? 'Switches now at full price. Credits reset; unused paid time carries over. '
                        'Renews monthly; cancel in Google Play.'
                  : subscription
                  ? 'Renews monthly · Cancel anytime in Google Play'
                  : 'One-time purchase · Credits never expire',
              textAlign: TextAlign.center,
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          if (!covered && after != null) ...[
            const SizedBox(height: AppSpacing.xxs),
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

/// What the checkout button says for a plan: "Choose Pro" from the free tier,
/// "Upgrade to Pro" from a smaller plan, "Switch to Creator" from a larger one.
/// It said "Choose" to every subscriber, which read as a second plan on top of
/// the one they pay for.
String planCallToAction(MobileBillingProduct product, String? currentTier) {
  final name = billingPlanName(product);
  final from = planTierOrder.indexOf(currentTier ?? 'free');
  final to = planTierOrder.indexOf(billingTierForSku(product.sku));
  if (from <= 0 || to < 0) {
    return 'Choose $name';
  }
  return to > from ? 'Upgrade to $name' : 'Switch to $name';
}
