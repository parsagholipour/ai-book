import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import 'billing_controller.dart';
import 'billing_plan_tiles.dart';

/// Plans first, top-ups underneath.
///
/// The same sheet answers both "I ran out of credits" and "I hit the free
/// tier's image limit", because in both cases the best answer is a plan and the
/// second-best is a one-off purchase — so it leads with the ladder and keeps the
/// packs available below rather than making them the whole offer.
Future<void> showBillingPaywall(
  BuildContext context, {
  String? projectId,
  String title = 'Upgrade your plan',
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
    this.title = 'Upgrade your plan',
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
        final currentSku = state.billing?.plan?.productSku;

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
                  Icon(Icons.workspace_premium_outlined, color: colors.primary),
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
              BillingPlanBanner(billing: state.billing),
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
                for (final plan in controller.plans) ...[
                  BillingPlanCard(
                    key: ValueKey('paywall-plan-${plan.sku}'),
                    product: plan,
                    storeProduct: state.storeProducts[plan.sku],
                    isCurrentPlan: plan.sku == currentSku,
                    pending: state.pendingProductIds.contains(plan.sku),
                    onBuy: () => controller.buy(plan),
                  ),
                  const SizedBox(height: 10),
                ],
                if (controller.topUps.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    'One-off top-ups',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Credits you buy outright never expire, and they are spent '
                    'only after your monthly allowance runs out.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 10),
                  for (final product in controller.topUps) ...[
                    BillingTopUpTile(
                      key: ValueKey('paywall-topup-${product.sku}'),
                      product: product,
                      storeProduct: state.storeProducts[product.sku],
                      pending: state.pendingProductIds.contains(product.sku),
                      onBuy: () => controller.buy(product),
                    ),
                    const SizedBox(height: 10),
                  ],
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
