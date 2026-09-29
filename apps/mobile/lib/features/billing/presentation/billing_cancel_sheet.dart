import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/billing_models.dart';
import 'billing_controller.dart';
import 'billing_free_plan_card.dart';
import 'billing_plan_tiles.dart';
import 'billing_shared_parts.dart';
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
  return showAppBottomSheet<void>(
    context,
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
        final endsAt = plan?.periodEndsAt;
        final handsOffToPlay = !(plan?.canCancelInApp ?? false);
        return SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    'Cancel your $label plan?',
                    style: text.titleLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.md),
                _FactCard(
                  tone: _FactTone.keep,
                  heading: 'What you keep',
                  icon: Icons.check_circle_outline,
                  lines: _whatYouKeep(context, plan, label, purchased),
                ),
                const SizedBox(height: AppSpacing.sm),
                _FactCard(
                  tone: _FactTone.after,
                  heading: _moveLine(context, plan),
                  icon: Icons.arrow_forward_rounded,
                  lines: _freePlanGrants(freeTier),
                ),
                if (_sentToPlay) ...[
                  const SizedBox(height: AppSpacing.sm),
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
                ] else if (handsOffToPlay) ...[
                  const SizedBox(height: AppSpacing.sm),
                  // The app cannot end a Google Play subscription itself, so
                  // it says where the button goes before the reader taps it.
                  Text(
                    endsAt == null
                        ? 'Google Play manages this subscription, so we will '
                              'open it there for you to cancel.'
                        : 'Google Play manages this subscription, so we will '
                              'open it there for you to cancel. It stays active '
                              'until ${billingDate(context, endsAt)}.',
                    style: text.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ],
                if (controller.state.error != null) ...[
                  const SizedBox(height: AppSpacing.sm),
                  AppInlineNotice(
                    tone: AppTone.error,
                    icon: Icons.error_outline,
                    title: 'That did not work',
                    message: controller.state.error!,
                  ),
                ],
                const SizedBox(height: AppSpacing.lg - 4),
                AppActionGroup(
                  primary: AppButton.primary(
                    key: const ValueKey('cancel-subscription-confirm'),
                    onPressed: busy ? null : () => _confirm(controller),
                    loading: busy,
                    loadingLabel: 'Working',
                    leading: handsOffToPlay && !_sentToPlay
                        ? const Icon(Icons.open_in_new, size: 18)
                        : null,
                    label: _actionLabel(plan),
                    expanded: true,
                  ),
                  secondary: [
                    AppButton.outlined(
                      key: const ValueKey('cancel-subscription-keep'),
                      onPressed: busy
                          ? null
                          : () => Navigator.of(context).pop(),
                      label: 'Keep $label',
                      expanded: true,
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

/// Monthly credits, welcome credits, illustrated books — not the trailing
/// "stay yours" line, which [_whatYouKeep] already says in its own words.
List<String> _freePlanGrants(MobileFreeTier freeTier) {
  final benefits = freePlanBenefits(freeTier);
  if (benefits.isNotEmpty &&
      benefits.last == 'Books you have already made stay yours') {
    return benefits.sublist(0, benefits.length - 1);
  }
  return benefits;
}

List<String> _whatYouKeep(
  BuildContext context,
  MobileSubscriptionPlan? plan,
  String label,
  int purchasedCredits,
) {
  final endsAt = plan?.periodEndsAt;
  return <String>[
    if (endsAt != null) 'You keep $label until ${billingDate(context, endsAt)}',
    if (purchasedCredits > 0)
      'Your ${formatCredits(purchasedCredits)} purchased credits never expire',
    'Every book you have made stays yours',
  ];
}

String _moveLine(BuildContext context, MobileSubscriptionPlan? plan) {
  final endsAt = plan?.periodEndsAt;
  return endsAt == null
      ? 'Then you move to Free:'
      : 'After ${billingDate(context, endsAt)} you move to Free:';
}

enum _FactTone { keep, after }

/// A short list of facts under one heading: what stays, or what changes.
///
/// The two lists are told apart by more than colour — a filled check against a
/// plain arrow, and their headings — since they are the whole point of the
/// sheet.
class _FactCard extends StatelessWidget {
  const _FactCard({
    required this.tone,
    required this.heading,
    required this.icon,
    required this.lines,
  });

  final _FactTone tone;
  final String heading;
  final IconData icon;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final keep = tone == _FactTone.keep;
    final accent = keep ? colors.primary : colors.onSurfaceVariant;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: keep
            ? colors.primaryContainer.withValues(alpha: 0.55)
            : colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              header: true,
              child: Text(
                heading,
                style: text.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            for (final line in lines)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ExcludeSemantics(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Icon(icon, size: 18, color: accent),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(child: Text(line, style: text.bodyMedium)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
