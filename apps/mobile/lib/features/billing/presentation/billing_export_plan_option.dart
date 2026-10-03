import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_plan_tiles.dart';
import 'billing_product_option.dart';

export 'billing_product_option.dart';

/// Checkout stays outside the scrollable comparison, including while a store
/// purchase is pending or failed, so the next action is always reachable.
///
/// Shared by every single-perk offer: the export offer passes only [format],
/// and an offer for some other perk (a longer book) says what it unlocks
/// through [includedLabel], [unlockLabel] and [includedActionLabel].
class BillingExportCheckout extends StatelessWidget {
  const BillingExportCheckout({
    required this.format,
    this.includedLabel,
    this.unlockLabel,
    this.includedActionLabel,
    this.buttonKey = const ValueKey('export-upgrade'),
    required this.product,
    required this.storeProduct,
    required this.loading,
    required this.pending,
    required this.restoring,
    required this.accessIncluded,
    required this.isCurrent,
    required this.error,
    required this.message,
    required this.onBuy,
    super.key,
  });

  final String format;

  /// The line over the button when the reader's plan already includes the perk.
  final String? includedLabel;

  /// The button's label for buying [product], given the plan's name.
  final String Function(String planName)? unlockLabel;

  /// The button's label when the plan already includes the perk.
  final String? includedActionLabel;
  final Key buttonKey;
  final MobileBillingProduct? product;
  final StoreProduct? storeProduct;
  final bool loading;
  final bool pending;
  final bool restoring;
  final bool accessIncluded;
  final bool isCurrent;
  final String? error;
  final String? message;
  final VoidCallback? onBuy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final plan = product;
    final name = plan == null ? null : billingPlanName(plan);
    final status = error ?? message;
    return Container(
      key: const ValueKey('export-checkout'),
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (status != null) ...[
            Semantics(
              liveRegion: true,
              child: Text(
                status,
                style: text.bodySmall?.copyWith(
                  color: error == null ? colors.onSurfaceVariant : colors.error,
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
          if (accessIncluded || (plan != null && !loading)) ...[
            Text(
              accessIncluded
                  ? includedLabel ?? '$format export is included in your plan.'
                  : '$name · ${storeProduct?.price ?? fallbackPrice(plan!)} / month',
              textAlign: TextAlign.center,
              style: text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
          ],
          AppButton.primary(
            key: buttonKey,
            onPressed: onBuy,
            loading: pending || restoring,
            loadingLabel: restoring
                ? 'Restoring purchases'
                : 'Purchase pending',
            label: loading
                ? 'Loading plans…'
                : accessIncluded
                ? includedActionLabel ?? 'Back to your book'
                : isCurrent
                ? 'Your current plan'
                : onBuy == null
                ? 'Plan unavailable'
                : unlockLabel?.call(name ?? 'a plan') ??
                      'Unlock $format with $name',
          ),
          if (!accessIncluded) ...[
            const SizedBox(height: 8),
            Text(
              'Renews monthly · Cancel anytime in Google Play',
              textAlign: TextAlign.center,
              style: text.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}
