import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/creation_repository.dart';
import 'creation_chat_controller.dart';

/// Archives or restores a chat and reports the result on [messenger].
///
/// Callers keep their own busy flags; this only performs the request and
/// shows the matching snackbar. Returns whether [ChatArchiveActions.setArchived]
/// succeeded.
Future<bool> setChatArchivedWithFeedback({
  required WidgetRef ref,
  required ScaffoldMessengerState messenger,
  required String draftId,
  required bool archived,
}) async {
  try {
    await ref
        .read(chatArchiveActionsProvider)
        .setArchived(draftId: draftId, archived: archived);
    if (ref.read(creationChatControllerProvider).draftId == draftId) {
      ref.read(creationChatControllerProvider.notifier).setArchived(archived);
    }
    if (messenger.mounted) {
      messenger.showAppSnackBar(
        archived
            ? const SnackBar(
                content: Text(
                  'Chat archived. Find it in Account → Archived chats.',
                ),
              )
            : const SnackBar(content: Text('Chat restored to the sidebar.')),
      );
    }
    return true;
  } catch (_) {
    if (messenger.mounted) {
      messenger.showAppSnackBar(
        archived
            ? const SnackBar(
                content: Text('Could not archive the chat. Try again.'),
              )
            : const SnackBar(
                content: Text('Could not unarchive the chat. Try again.'),
              ),
      );
    }
    return false;
  }
}

/// Shown on an open archived creation chat. Restore keeps the thread live.
class ArchivedChatBanner extends StatelessWidget {
  const ArchivedChatBanner({super.key, this.onRestore});

  final VoidCallback? onRestore;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.inventory_2_outlined,
              size: 18,
              color: colors.onTertiaryContainer,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'This chat is archived and hidden from the sidebar.',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onTertiaryContainer,
                ),
              ),
            ),
            TextButton(
              onPressed: onRestore,
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
              child: const Text('Restore'),
            ),
          ],
        ),
      ),
    );
  }
}
