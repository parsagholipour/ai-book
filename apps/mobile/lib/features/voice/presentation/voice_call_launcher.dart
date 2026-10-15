import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/voice_disclosure_store.dart';
import '../domain/voice_models.dart';
import 'voice_call_screen.dart';

/// The sentence the server's 403 `SUBSCRIPTION_REQUIRED` carries for a call.
const voiceCallsPlanMessage = 'Voice calls are part of the Creator plan.';

/// Whether calls are a plan perk this reader does not have yet. Unknown
/// billing is not locked — the server rules on the call, and a refused one
/// ends on the plan offer (`VoiceCallState.planRequired`).
bool voiceCallsLockedByPlan(MobileBilling? billing) =>
    billing != null && !billing.hasCreatorSubscription;

/// The plan offer a free reader gets instead of a call.
Future<void> showVoiceCallPlanOffer(
  BuildContext context,
  WidgetRef ref, {
  String? projectId,
}) async {
  await showBillingPaywall(
    context,
    projectId: projectId,
    title: 'Talk to your characters',
    message:
        '$voiceCallsPlanMessage Choose a plan to call the characters in your '
        'books and the ones you saved.',
    trigger: PaywallTrigger.other,
  );
  ref.invalidate(billingProvider);
}

/// The three gates every call passes, and then the call screen.
///
/// One place rather than one per surface, because the cast sheet of a book
/// and the page of a saved character both place calls and the rules are the
/// rules: a free account is offered a plan (calls are a plan perk), a balance
/// that cannot cover the opening hold is told the number rather than silently
/// refused, and the microphone disclosure is shown once, before the first call
/// ever, whichever surface it comes from. The plan offer opens over the
/// calling surface rather than after [leave], so a reader who buys one is
/// still looking at the character they meant to ring.
///
/// [leave] is what a caller that has to get out of the way does — a bottom
/// sheet pops itself — and runs right before the toast or the push. A screen
/// that stays where it is passes nothing.
Future<void> launchVoiceCall({
  required BuildContext context,
  required WidgetRef ref,
  required String? projectId,
  required VoiceCharacter character,
  required VoiceCast cast,
  int? pageIndex,
  VoidCallback? leave,
}) async {
  // Both captured before [leave] runs: a popped sheet's context has neither.
  final messenger = ScaffoldMessenger.of(context);
  final navigator = Navigator.of(context);
  if (voiceCallsLockedByPlan(ref.read(billingProvider).asData?.value)) {
    AppHaptics.tap();
    await showVoiceCallPlanOffer(context, ref, projectId: projectId);
    return;
  }
  if (!cast.canAfford) {
    AppHaptics.warning();
    leave?.call();
    messenger
      ..hideCurrentSnackBar()
      ..showAppSnackBar(
        SnackBar(
          content: Text(creditsNeededToStartCallMessage(cast.creditsToStart)),
        ),
      );
    return;
  }
  if (!await ensureVoiceDisclosureAcknowledged(context, ref)) return;
  if (!context.mounted) return;
  AppHaptics.commit();
  leave?.call();
  await navigator.push(
    MaterialPageRoute<void>(
      builder: (context) => VoiceCallScreen(
        projectId: projectId,
        character: character,
        pageIndex: pageIndex,
      ),
    ),
  );
}

/// Shows the microphone and provider disclosure the first time, and remembers
/// the answer. True when the call may go ahead.
Future<bool> ensureVoiceDisclosureAcknowledged(
  BuildContext context,
  WidgetRef ref,
) async {
  final store = ref.read(voiceDisclosureStoreProvider);
  if (await store.hasAcknowledged()) return true;
  if (!context.mounted) return false;
  final accepted = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (context) => AlertDialog(
      icon: const Icon(Icons.mic_outlined),
      title: const Text('Before your first voice call'),
      scrollable: true,
      // Three plain facts, one per row, instead of one paragraph nobody reads.
      // The wording is the disclosure the store requires; only its shape is new.
      content: const Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _DisclosureRow(
            icon: Icons.graphic_eq,
            heading: 'Live, with an AI voice',
            body:
                'Your microphone audio is sent in real time through Ravanix’s server to the selected AI voice provider.',
          ),
          _DisclosureRow(
            icon: Icons.description_outlined,
            heading: 'What is kept',
            body:
                'Ravanix does not retain live-call audio on its server, but transcript text, call duration, billing records, and call telemetry may be stored with the project.',
          ),
          _DisclosureRow(
            icon: Icons.mic_none,
            heading: 'Your permission',
            body: 'Your device will ask for microphone permission next.',
          ),
        ],
      ),
      actions: [
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(false),
          label: 'Not now',
        ),
        AppButton.primary(
          onPressed: () => Navigator.of(context).pop(true),
          label: 'Continue',
        ),
      ],
    ),
  );
  if (accepted != true) return false;
  await store.acknowledge();
  return true;
}

class _DisclosureRow extends StatelessWidget {
  const _DisclosureRow({
    required this.icon,
    required this.heading,
    required this.body,
  });

  final IconData icon;
  final String heading;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ExcludeSemantics(
            child: Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: colors.primaryContainer,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, size: 20, color: colors.onPrimaryContainer),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  heading,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
