import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';
import 'chat_archive_feedback.dart';
import 'chat_session_activity.dart';
import 'creation_chat_controller.dart';

/// The leading glyph of a chat row: a spinner while that chat has work of its
/// own running — its book being planned, written or edited, or its own turn
/// still in flight — and the chat icon otherwise.
///
/// Both are drawn in the same 20px box, so a row does not shift sideways when
/// the work starts or stops.
class ChatHistoryGlyph extends StatelessWidget {
  const ChatHistoryGlyph({required this.busy, required this.color});

  final bool busy;

  /// Drawn in this colour either way. Rows pass the brand colour while busy,
  /// because work running is worth noticing from across the list.
  final Color color;

  @override
  Widget build(BuildContext context) {
    if (!busy) {
      return Icon(Icons.chat_bubble_outline, size: 20, color: color);
    }
    return Semantics(
      label: 'Working',
      child: SizedBox(
        width: 20,
        height: 20,
        child: CircularProgressIndicator(strokeWidth: 2, color: color),
      ),
    );
  }
}

class ChatHistoryTile extends ConsumerStatefulWidget {
  const ChatHistoryTile({
    required this.session,
    required this.isSelected,
    super.key,
  });

  final MobileChatSession session;
  final bool isSelected;

  @override
  ConsumerState<ChatHistoryTile> createState() => _ChatHistoryTileState();
}

class _ChatHistoryTileState extends ConsumerState<ChatHistoryTile> {
  bool _archiving = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final selected = widget.isSelected;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(12),
    );
    // Two kinds of work, one glyph: the book this chat is making being planned,
    // written or edited, and — for the chat that is open — its own turn still
    // running. The second is only knowable for the open chat, since that is the
    // only conversation the controller holds.
    final session = widget.session;
    final chatBusy = ref.watch(
      creationChatControllerProvider.select((state) => state.isBusy),
    );
    final busy =
        ref.watch(
          chatBookBusyProvider(
            session.activeProjectId ?? session.createdProjectId,
          ),
        ) ||
        (selected && chatBusy);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected
            ? colors.primaryContainer.withValues(alpha: 0.55)
            : Colors.transparent,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: ListTile(
          dense: true,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12),
          minVerticalPadding: 2,
          selected: selected,
          tileColor: Colors.transparent,
          selectedTileColor: Colors.transparent,
          shape: shape,
          leading: ChatHistoryGlyph(
            busy: busy,
            color: selected
                ? colors.onPrimaryContainer
                : busy
                ? colors.primary
                : colors.onSurfaceVariant,
          ),
          title: Text(
            widget.session.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: selected ? colors.onPrimaryContainer : null,
              fontWeight: selected ? FontWeight.w700 : null,
            ),
          ),
          subtitle: widget.session.preview.isNotEmpty
              ? Text(
                  widget.session.preview,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                )
              : null,
          onTap: () => _open(context),
          onLongPress: _archiving
              ? null
              : () {
                  AppHaptics.longPress();
                  _showOptions(context);
                },
        ),
      ),
    );
  }

  void _open(BuildContext context) {
    AppHaptics.tap();
    Navigator.of(context).pop();
    context.go('/books/chat/${widget.session.draftId}');
  }

  void _showOptions(BuildContext context) {
    showAppActionSheet<void>(
      context,
      builder: (ctx) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.edit_outlined),
            title: const Text('Rename'),
            onTap: () {
              Navigator.of(ctx).pop();
              _showRenameDialog(context);
            },
          ),
          ListTile(
            leading: const Icon(Icons.archive_outlined),
            title: const Text('Archive'),
            onTap: () {
              Navigator.of(ctx).pop();
              _archive();
            },
          ),
          ListTile(
            leading: Icon(
              Icons.delete_outline,
              color: Theme.of(context).colorScheme.error,
            ),
            title: Text(
              'Delete',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            onTap: () {
              Navigator.of(ctx).pop();
              _confirmDelete(context);
            },
          ),
        ],
      ),
    );
  }

  void _showRenameDialog(BuildContext context) {
    final controller = TextEditingController(text: widget.session.title);
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename chat'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLength: 160,
          decoration: const InputDecoration(hintText: 'Chat title'),
          textCapitalization: TextCapitalization.sentences,
          onSubmitted: (_) => _doRename(ctx, controller.text),
        ),
        actions: [
          AppButton.text(
            onPressed: () => Navigator.of(ctx).pop(),
            label: 'Cancel',
          ),
          AppButton.primary(
            onPressed: () => _doRename(ctx, controller.text),
            label: 'Save',
          ),
        ],
      ),
    );
  }

  Future<void> _doRename(BuildContext ctx, String newTitle) async {
    final trimmed = newTitle.trim();
    if (trimmed.isEmpty) return;
    Navigator.of(ctx).pop();
    try {
      await ref
          .read(creationRepositoryProvider)
          .renameSession(draftId: widget.session.draftId, title: trimmed);
      ref
          .read(creationConversationCacheProvider)
          .updateTitle(draftId: widget.session.draftId, title: trimmed);
      if (widget.isSelected) {
        ref
            .read(creationChatControllerProvider.notifier)
            .setSessionTitle(trimmed);
      }
      invalidateChatSessionLists(ref);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          const SnackBar(content: Text('Could not rename the chat.')),
        );
      }
    }
  }

  Future<void> _confirmDelete(BuildContext context) async {
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Delete chat?',
      message: 'This chat will be permanently deleted.',
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (confirmed && mounted) await _doDelete();
  }

  Future<void> _archive() async {
    if (_archiving) return;
    setState(() => _archiving = true);
    try {
      await setChatArchivedWithFeedback(
        ref: ref,
        messenger: ScaffoldMessenger.of(context),
        draftId: widget.session.draftId,
        archived: true,
      );
    } finally {
      if (mounted) setState(() => _archiving = false);
    }
  }

  Future<void> _doDelete() async {
    try {
      await ref
          .read(creationRepositoryProvider)
          .deleteSession(widget.session.draftId);
      ref
          .read(creationConversationCacheProvider)
          .remove(widget.session.draftId);
      invalidateChatSessionLists(ref);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          const SnackBar(content: Text('Could not delete the chat.')),
        );
      }
    }
  }
}
