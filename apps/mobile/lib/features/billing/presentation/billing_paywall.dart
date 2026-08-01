import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import 'billing_controller.dart';
import 'billing_plan_tiles.dart';
import 'billing_tier_style.dart';

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
        final currentSku = state.billing?.plan?.productSku;
        final currentTier = state.billing?.planTier ?? 'free';
        final plans = controller.plans;
        final value = billingPlanValue(plans, state.storeProducts);

        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.88,
          minChildSize: 0.45,
          maxChildSize: 0.96,
          builder: (context, scrollController) => ListView(
            controller: scrollController,
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 28),
            children: [
              _PaywallHero(
                title: title,
                message: message,
                onClose: () => Navigator.of(context).pop(),
              ),
              const SizedBox(height: 14),
              BillingPlanBanner(billing: state.billing),
              const SizedBox(height: 20),
              if (!state.storeAvailable && !state.loading) ...[
                const AppInlineNotice(
                  icon: Icons.storefront_outlined,
                  title: 'Google Play billing unavailable',
                  message:
                      'Use an Android build installed from a Play testing track or a license tester account to buy credits.',
                ),
                const SizedBox(height: 16),
              ],
              if (state.loading)
                const BillingPlanSkeleton()
              else ...[
                if (plans.isNotEmpty) ...[
                  _SectionLabel(
                    label: currentTier == 'free'
                        ? 'Choose a plan'
                        : 'Change your plan',
                  ),
                  const SizedBox(height: 12),
                  for (final (index, plan) in plans.indexed) ...[
                    AppEntrance(
                      index: index,
                      child: BillingPlanCard(
                        key: ValueKey('paywall-plan-${plan.sku}'),
                        product: plan,
                        storeProduct: state.storeProducts[plan.sku],
                        isCurrentPlan: plan.sku == currentSku,
                        currentTier: currentTier,
                        mostPopular:
                            plan.sku == 'tomeza.pro_monthly' &&
                            plan.sku != value.bestValueSku,
                        bestValue: plan.sku == value.bestValueSku,
                        savingsPercent: value.savingsFor(plan.sku),
                        pending: state.pendingProductIds.contains(plan.sku),
                        onBuy: () => controller.buy(plan),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                ],
                if (controller.topUps.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  const _SectionRule(label: 'OR TOP UP'),
                  const SizedBox(height: 16),
                  Text(
                    'Credits you buy outright never expire, and they are spent '
                    'only after your monthly allowance runs out.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 12),
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
                if (state.missingProductIds.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  AppInlineNotice(
                    icon: Icons.info_outline,
                    title: 'Some products are not live yet',
                    message:
                        'Missing in Google Play: ${state.missingProductIds.join(', ')}',
                  ),
                ],
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
              const SizedBox(height: 20),
              _PaywallFooter(
                restoring: state.restoring,
                onRestore: controller.restore,
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The masthead: an emblem, the reason the sheet opened, and the way out.
class _PaywallHero extends StatelessWidget {
  const _PaywallHero({
    required this.title,
    required this.onClose,
    this.message,
  });

  final String title;
  final String? message;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;

    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(TomezaRadii.card),
        border: Border.all(color: colors.primary.withValues(alpha: 0.22)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            colors.primary.withValues(alpha: 0.2),
            colors.tertiary.withValues(alpha: 0.08),
            colors.surfaceContainerLowest,
          ],
          stops: const [0, 0.5, 1],
        ),
      ),
      padding: const EdgeInsets.fromLTRB(18, 14, 12, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(14),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [colors.primary, colors.tertiary],
                  ),
                ),
                child: Icon(
                  Icons.auto_awesome,
                  size: 24,
                  color: colors.onPrimary,
                ),
              ),
              const Spacer(),
              IconButton(
                tooltip: 'Close',
                onPressed: onClose,
                icon: const Icon(Icons.close),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.only(right: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: text.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                if (message != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    message!,
                    style: text.bodyMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: Theme.of(context).textTheme.titleSmall?.copyWith(
        fontWeight: FontWeight.w800,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        letterSpacing: 0.4,
      ),
    );
  }
}

/// A centred rule that separates the ladder from the one-off purchases, so the
/// packs read as an alternative rather than as a fourth, cheaper tier.
class _SectionRule extends StatelessWidget {
  const _SectionRule({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final line = Expanded(child: Divider(color: colors.outlineVariant));
    return Row(
      children: [
        line,
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
            ),
          ),
        ),
        line,
      ],
    );
  }
}

class _PaywallFooter extends StatelessWidget {
  const _PaywallFooter({required this.restoring, required this.onRestore});

  final bool restoring;
  final VoidCallback onRestore;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(
                Icons.verified_user_outlined,
                size: 15,
                color: colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                'Billed through Google Play. Cancel any time — the books you '
                'have already made stay yours.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        TextButton.icon(
          onPressed: restoring ? null : onRestore,
          icon: restoring
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    semanticsLabel: 'Restoring purchases',
                  ),
                )
              : const Icon(Icons.restore_outlined, size: 18),
          label: const Text('Restore purchases'),
        ),
      ],
    );
  }
}
