import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/voice_disclosure_store.dart';
import '../domain/voice_models.dart';
import 'voice_call_screen.dart';

/// The two gates every call passes, and then the call screen.
///
/// One place rather than one per surface, because the cast sheet of a book
/// and the page of a saved character both place calls and the rules are the
/// rules: a balance that cannot cover the opening hold is told the number
/// rather than silently refused, and the microphone disclosure is shown once,
/// before the first call ever, whichever surface it comes from.
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
      content: const Text(
        'Your microphone audio is sent in real time to the selected AI voice provider. '
        'Ravanix does not retain live-call audio on its server, but transcript text, call duration, billing records, and call telemetry may be stored with the project. '
        'Your device will ask for microphone permission next.',
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
