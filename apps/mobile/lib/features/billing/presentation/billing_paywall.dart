import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';

Future<void> showBillingPaywall(
  BuildContext context, {
  String? projectId,
  String title = 'Add credits',
  String? message,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) =>
        BillingPaywall(projectId: projectId, title: title, message: message),
  );
}

class BillingPaywall extends ConsumerWidget {
  const BillingPaywall({
    this.projectId,
    this.title = 'Add credits',
    this.message,
    super.key,
  });

  final String? projectId;
  final String title;
  final String? message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final controller = ref.watch(billingControllerProvider(projectId));
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final state = controller.state;
        final colors = Theme.of(context).colorScheme;

        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.84,
          minChildSize: 0.45,
          maxChildSize: 0.96,
          builder: (context, scrollController) => ListView(
            controller: scrollController,
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 28),
            children: [
              Row(
                children: [
                  Icon(
                    Icons.account_balance_wallet_outlined,
                    color: colors.primary,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              if (message != null) ...[
                const SizedBox(height: 6),
                Text(
                  message!,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: 14),
              _BalanceStrip(billing: state.billing),
              const SizedBox(height: 14),
              if (state.loading)
                const AppLoadingState(message: 'Loading purchase options')
              else if (!state.storeAvailable)
                const AppInlineNotice(
                  icon: Icons.storefront_outlined,
                  title: 'Google Play billing unavailable',
                  message:
                      'Use an Android build installed from a Play testing track or a license tester account to buy credits.',
                )
              else ...[
                for (final product in controller.products) ...[
                  _ProductTile(
                    product: product,
                    storeProduct: state.storeProducts[product.sku],
                    pending: state.pendingProductIds.contains(product.sku),
                    onBuy: () => controller.buy(product),
                  ),
                  const SizedBox(height: 10),
                ],
                if (state.missingProductIds.isNotEmpty)
                  AppInlineNotice(
                    icon: Icons.info_outline,
                    title: 'Some products are not live yet',
                    message:
                        'Missing in Google Play: ${state.missingProductIds.join(', ')}',
                  ),
              ],
              if (state.message != null) ...[
                const SizedBox(height: 12),
                AppInlineNotice(
                  icon: Icons.check_circle_outline,
                  title: 'Purchase update',
                  message: state.message!,
                  tone: AppNoticeTone.success,
                ),
              ],
              if (state.error != null) ...[
                const SizedBox(height: 12),
                AppInlineNotice(
                  icon: Icons.error_outline,
                  title: 'Purchase issue',
                  message: state.error!,
                  tone: AppNoticeTone.error,
                ),
              ],
              const SizedBox(height: 14),
              OutlinedButton.icon(
                onPressed: state.restoring ? null : controller.restore,
                icon: state.restoring
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          semanticsLabel: 'Restoring purchases',
                        ),
                      )
                    : const Icon(Icons.restore_outlined),
                label: const Text('Restore purchases'),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _BalanceStrip extends StatelessWidget {
  const _BalanceStrip({this.billing});

  final MobileBilling? billing;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final credits = billing?.credits.available;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            const Icon(Icons.savings_outlined),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                credits == null
                    ? 'Checking your credit balance'
                    : '$credits credits available',
                style: Theme.of(
                  context,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProductTile extends StatelessWidget {
  const _ProductTile({
    required this.product,
    required this.pending,
    required this.onBuy,
    this.storeProduct,
  });

  final MobileBillingProduct product;
  final StoreProduct? storeProduct;
  final bool pending;
  final VoidCallback onBuy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final available = storeProduct != null;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(_iconFor(product), color: colors.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        product.title,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _productMessage(product),
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        product.benefitLabel,
                        style: Theme.of(context).textTheme.labelLarge,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton(
                onPressed: available && !pending ? onBuy : null,
                child: pending
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          semanticsLabel: 'Purchase pending',
                        ),
                      )
                    : Text(storeProduct?.price ?? _fallbackPrice(product)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  IconData _iconFor(MobileBillingProduct product) {
    if (product.isSubscription) {
      return Icons.workspace_premium_outlined;
    }
    if (product.productType == 'CREDIT_PACK') {
      return Icons.add_card_outlined;
    }
    return Icons.lock_open_outlined;
  }

  String _productMessage(MobileBillingProduct product) {
    return switch (product.sku) {
      'tomeza.one_book_export' =>
        'Best for unlocking one complete book package or topping up a project.',
      'tomeza.creator_monthly' =>
        'A steady monthly plan for creators and teachers making a few books.',
      'tomeza.pro_monthly' =>
        'More monthly credits for heavier publishing or classroom use.',
      _ => product.description,
    };
  }

  String _fallbackPrice(MobileBillingProduct product) {
    final price = product.priceMicros / 1000000;
    return '${product.currency} ${price.toStringAsFixed(2)}';
  }
}
