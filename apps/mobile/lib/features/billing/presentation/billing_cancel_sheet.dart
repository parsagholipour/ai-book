import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_free_plan_card.dart';
import 'billing_plan_tiles.dart';
import 'play_subscriptions_link.dart';

/// What cancelling actually costs, before it happens.
///
/// The sheet is the whole feature on the app's side: cancelling a real Google
/// Play subscription happens in Play, so the one thing the app can do well is
/// say — in this reader's own numbers — what they keep, when the plan ends, and
/// what free gives them afterwards. Nothing here is a surprise on the way back.
Future<void> showCancelSubscriptionSheet(
  BuildContext context, {
  required MobileBilling billing,
  String? projectId,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) =>
        _CancelSubscriptionSheet(billing: billing, projectId: projectId),
  );
}

class _CancelSubscriptionSheet extends ConsumerStatefulWidget {
  const _CancelSubscriptionSheet({required this.billing, this.projectId});

  final MobileBilling billing;
  final String? projectId;

  @override
  ConsumerState<_CancelSubscriptionSheet> createState() =>
      _CancelSubscriptionSheetState();
}

class _CancelSubscriptionSheetState
    extends ConsumerState<_CancelSubscriptionSheet> {
  /// Null until we have tried to hand the reader over to Play; then whether it
  /// actually opened. Cancelling there does not come back to us on its own, so
  /// from that point on the action here is "check what happened".
  bool? _playOpened;

  bool get _sentToPlay => _playOpened != null;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final controller = ref.watch(billingControllerProvider(widget.projectId));
    // The plan the sheet was opened about; the controller may not have loaded
    // its own copy yet, and this one is already on screen behind the sheet.
    final plan = widget.billing.plan;
    final label = plan?.label ?? 'your';
    final freeTier = widget.billing.freeTier;
    final purchased = widget.billing.credits.purchased;

    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final busy = controller.state.subscriptionBusy;
        return SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Cancel your $label plan?',
                  style: text.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 16),
                for (final kept in _whatYouKeep(plan, label, purchased)) ...[
                  BillingBenefitRow(label: kept, accent: colors.primary),
                  const SizedBox(height: 8),
                ],
                const SizedBox(height: 12),
                Text(
                  _moveLine(plan),
                  style: text.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 10),
                for (final benefit in freePlanBenefits(freeTier).take(2)) ...[
                  BillingBenefitRow(
                    label: benefit,
                    accent: colors.onSurfaceVariant,
                  ),
                  const SizedBox(height: 8),
                ],
                if (_sentToPlay) ...[
                  const SizedBox(height: 8),
                  AppInlineNotice(
                    icon: Icons.open_in_new,
                    title: 'Finish in Google Play',
                    message: _playOpened!
                        ? 'Cancel the subscription there, then come back and '
                              'check your plan.'
                        : 'Play would not open. Find Tomeza under Payments and '
                              'subscriptions in the Play Store, cancel there, '
                              'then come back and check your plan.',
                  ),
                ],
                if (controller.state.error != null) ...[
                  const SizedBox(height: 12),
                  AppInlineNotice(
                    tone: AppNoticeTone.error,
                    icon: Icons.error_outline,
                    title: 'That did not work',
                    message: controller.state.error!,
                  ),
                ],
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: TextButton(
                        onPressed: busy
                            ? null
                            : () => Navigator.of(context).pop(),
                        child: Text('Keep $label'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        key: const ValueKey('cancel-subscription-confirm'),
                        onPressed: busy ? null : () => _confirm(controller),
                        child: busy
                            ? const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  semanticsLabel: 'Working',
                                ),
                              )
                            : Text(_actionLabel(plan)),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  String _actionLabel(MobileSubscriptionPlan? plan) {
    if (_sentToPlay) {
      return 'Check my plan';
    }
    return plan?.canCancelInApp ?? false
        ? 'Cancel subscription'
        : 'Cancel in Play';
  }

  Future<void> _confirm(BillingController controller) async {
    final plan = widget.billing.plan;
    if (_sentToPlay) {
      // Play cancels without telling us, and the server's renewal sweep would
      // not look again until the period ended.
      final refreshed = await controller.refreshSubscription();
      if (refreshed && mounted) {
        Navigator.of(context).pop();
      }
      return;
    }
    if (!(plan?.canCancelInApp ?? false)) {
      // A device with no Play app still has to be told what to do next, so a
      // failed hand-off changes the wording rather than dead-ending here.
      var opened = false;
      try {
        opened = await ref.read(playSubscriptionsLauncherProvider)(
          plan?.productSku,
        );
      } catch (_) {
        opened = false;
      }
      if (mounted) {
        setState(() => _playOpened = opened);
      }
      return;
    }
    final cancelled = await controller.cancelSubscription();
    if (cancelled && mounted) {
      Navigator.of(context).pop();
    }
  }
}

List<String> _whatYouKeep(
  MobileSubscriptionPlan? plan,
  String label,
  int purchasedCredits,
) {
  final endsAt = plan?.periodEndsAt;
  return <String>[
    if (endsAt != null) 'You keep $label until ${_formatDate(endsAt)}',
    if (purchasedCredits > 0)
      'Your ${formatCredits(purchasedCredits)} purchased credits never expire',
    'Every book you have made stays yours',
  ];
}

String _moveLine(MobileSubscriptionPlan? plan) {
  final endsAt = plan?.periodEndsAt;
  return endsAt == null
      ? 'Then you move to Free:'
      : 'After ${_formatDate(endsAt)} you move to Free:';
}

String _formatDate(DateTime value) {
  final local = value.toLocal();
  return '${local.day}/${local.month}/${local.year}';
}
