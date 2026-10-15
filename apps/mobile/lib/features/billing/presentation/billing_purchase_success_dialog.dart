import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../data/billing_repository.dart';
import 'billing_controller.dart';
import 'billing_plan_tiles.dart';
import 'billing_shared_parts.dart';
import 'billing_tier_style.dart';

Future<void> showBillingPurchaseSuccessDialog(
  BuildContext context,
  BillingPurchaseSuccess purchase,
) {
  return showDialog<void>(
    context: context,
    builder: (context) => BillingPurchaseSuccessDialog(purchase: purchase),
  );
}

/// The moment after a verified purchase: brief, and it says what changed.
///
/// The mark plays once — it scales in and a ring opens from it — and holds
/// still afterwards, so nothing here keeps a frame loop alive. A reader who
/// asked for reduced motion gets the finished state at once.
class BillingPurchaseSuccessDialog extends ConsumerStatefulWidget {
  const BillingPurchaseSuccessDialog({required this.purchase, super.key});

  final BillingPurchaseSuccess purchase;

  @override
  ConsumerState<BillingPurchaseSuccessDialog> createState() =>
      _BillingPurchaseSuccessDialogState();
}

class _BillingPurchaseSuccessDialogState
    extends ConsumerState<BillingPurchaseSuccessDialog>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 700),
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    if (AppMotion.reducedMotion(context)) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final purchase = widget.purchase;
    final tier = billingTierForSku(purchase.productId);
    final style = billingTierStyleForTier(tier);
    final balance = ref.watch(billingProvider).asData?.value;
    final fill = tier == 'free'
        ? colors.primaryContainer
        : style.accentContainer(colors);
    final mark = tier == 'free'
        ? colors.onPrimaryContainer
        : style.onAccentContainer(colors);
    final ring = tier == 'free' ? colors.primary : style.accent(colors);

    return AlertDialog(
      key: const ValueKey('billing-purchase-success-dialog'),
      scrollable: true,
      icon: ExcludeSemantics(
        child: SizedBox.square(
          dimension: 88,
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, _) {
              final pop = Curves.easeOutBack.transform(
                Interval(0, 0.6).transform(_controller.value),
              );
              final wave = Curves.easeOut.transform(
                Interval(0.25, 1).transform(_controller.value),
              );
              return Stack(
                alignment: Alignment.center,
                children: [
                  // The ring opens and fades: a single beat, not a pulse.
                  Opacity(
                    opacity: (1 - wave) * 0.6,
                    child: Transform.scale(
                      scale: 0.7 + wave * 0.5,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: ring, width: 3),
                        ),
                        child: const SizedBox.square(dimension: 72),
                      ),
                    ),
                  ),
                  Transform.scale(
                    scale: 0.55 + 0.45 * pop,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: fill,
                      ),
                      child: SizedBox.square(
                        dimension: 68,
                        child: Icon(Icons.check_rounded, size: 38, color: mark),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
      // A deferred downgrade bought nothing today; its message says when.
      title: Text(
        purchase.scheduled ? 'Plan change scheduled' : 'Purchase successful',
        textAlign: TextAlign.center,
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (tier != 'free') ...[
            BillingTierBadge(tier: tier, label: billingTierLabel(tier)),
            const SizedBox(height: AppSpacing.sm),
          ],
          Text(purchase.message, textAlign: TextAlign.center),
          if (balance != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              'Balance: ${formatCredits(balance.credits.available)} credits',
              textAlign: TextAlign.center,
              style: text.labelLarge?.copyWith(
                color: colors.onSurface,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        AppButton.primary(
          onPressed: () => Navigator.of(context).pop(),
          label: 'Done',
          expanded: true,
        ),
      ],
    );
  }
}
