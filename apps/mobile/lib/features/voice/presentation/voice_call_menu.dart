import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import 'voice_call_controller.dart';

/// The overflow menu on the call screen.
///
/// One item today. It lives behind a menu rather than as a fourth control in
/// the footer because the three that are there are the ones a caller reaches
/// for without looking — mute, end, speaker — and a download sitting next to
/// "End" at thumb size is a mistap waiting to happen.
class VoiceCallMenu extends ConsumerWidget {
  const VoiceCallMenu({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(voiceCallControllerProvider);
    if (!state.recordingAvailable) {
      return const SizedBox.shrink();
    }
    final colors = Theme.of(context).colorScheme;

    if (state.exportingRecording) {
      // In place of the button rather than over it, so the row does not resize
      // and shove the avatar sideways mid-encode.
      return const Padding(
        padding: EdgeInsets.all(12),
        child: SizedBox.square(
          dimension: 24,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    return PopupMenuButton<String>(
      key: const ValueKey('call-menu'),
      icon: Icon(Icons.more_vert, color: colors.onSurfaceVariant),
      tooltip: 'More',
      onSelected: (value) {
        if (value == 'download') {
          AppHaptics.tap();
          unawaited(downloadCallRecording(context: context, ref: ref));
        }
      },
      itemBuilder: (context) => [
        const PopupMenuItem(
          key: ValueKey('call-menu-download'),
          value: 'download',
          child: ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.download_outlined),
            title: Text('Download recording'),
          ),
        ),
      ],
    );
  }
}

/// Asks, encodes, and hands the file to the system share sheet.
///
/// The confirmation is not ceremony: a call is a private conversation, the
/// recording has the caller's own voice in it, and the next screen after this
/// is a list of every app on the phone that will take an audio file. Naming
/// what is about to be shared before that list appears is the whole point.
Future<void> downloadCallRecording({
  required BuildContext context,
  required WidgetRef ref,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final character = ref.read(voiceCallControllerProvider).character?.name;

  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Download recording'),
      content: Text(
        character == null
            ? 'This saves the call so far as an audio file — your voice and '
                  'theirs. It is put together on this device and never uploaded.'
            : 'This saves your call with $character so far as an audio file — '
                  'your voice and theirs. It is put together on this device and '
                  'never uploaded.',
      ),
      actions: [
        AppButton.text(
          onPressed: () => Navigator.of(context).pop(false),
          label: 'Cancel',
        ),
        AppButton.primary(
          key: const ValueKey('call-recording-proceed'),
          onPressed: () => Navigator.of(context).pop(true),
          label: 'Proceed',
        ),
      ],
    ),
  );
  if (confirmed != true) {
    return;
  }

  try {
    final file = await ref
        .read(voiceCallControllerProvider.notifier)
        .exportRecording();
    if (file == null) {
      return;
    }
    final filename = file.path.split('/').last;
    // The same hand-off a book export uses: the app has no save-to-Downloads
    // path on either platform, so the share sheet is how a file is saved.
    await SharePlus.instance.share(
      ShareParams(
        title: filename,
        subject: filename,
        files: [XFile(file.path, mimeType: 'audio/mp4')],
        fileNameOverrides: [filename],
      ),
    );
    AppHaptics.success();
  } catch (error) {
    AppHaptics.error();
    messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
  }
}
