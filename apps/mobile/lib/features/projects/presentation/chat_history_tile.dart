import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/creation_repository.dart';
import '../data/projects_repository.dart';
import '../domain/creation_models.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'book_status.dart';
import 'chat_archive_feedback.dart';
import 'chat_history_time.dart';
import 'chat_session_activity.dart';
import 'creation_chat_controller.dart';

/// Width of the leading slot every history row reserves, so a chat glyph, a
/// book cover and a spinner all start the title at the same place.
const double _leadingWidth = 40;

/// The leading glyph of a chat row: a spinner while that chat has work of its
/// own running — its book being planned, written or edited, or its own turn
/// still in flight — and the chat icon otherwise.
///
/// Both sit in the same rounded 40dp tile, so a row does not shift sideways when
/// the work starts or stops, and a chat without a book lines up with one that
/// has a cover.
class ChatHistoryGlyph extends StatelessWidget {
  const ChatHistoryGlyph({super.key, required this.busy, required this.color});

  final bool busy;

  /// Drawn in this colour either way. Rows pass the brand colour while busy,
  /// because work running is worth noticing from across the list.
  final Color color;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      width: _leadingWidth,
      height: _leadingWidth,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadii.control),
      ),
      child: busy
          ? Semantics(
              label: 'Working',
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2, color: color),
              ),
            )
          : Icon(Icons.chat_bubble_outline, size: 20, color: color),
    );
  }
}

/// A finished-or-in-progress book's cover as the row's leading picture, with a
/// small ring in the corner while that book is still being worked on.
class _CoverLeading extends StatelessWidget {
  const _CoverLeading({required this.project, required this.busy});

  final MobileProjectSummary project;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      width: _leadingWidth,
      child: Stack(
        clipBehavior: Clip.none,
        alignment: Alignment.center,
        children: [
          ExcludeSemantics(
            child: BookCover(
              title: project.title,
              seed: project.id,
              image: project.coverImage,
              width: 34,
              borderRadius: 5,
              elevated: false,
            ),
          ),
          if (busy)
            PositionedDirectional(
              end: -3,
              bottom: -3,
              child: Semantics(
                label: 'Working',
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.surface,
                    shape: BoxShape.circle,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(2),
                    child: SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: colors.primary,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The book a chat made, when the cached project list knows it and it has pages
/// to show. A book still only being planned is not a book yet — it keeps the
/// chat glyph — so this is the same rule the shelf and the library use.
MobileProjectSummary? _bookForChat(
  List<MobileProjectSummary>? projects,
  String? projectId,
) {
  if (projects == null || projectId == null) return null;
  for (final project in projects) {
    if (project.id == projectId) return project;
  }
  return null;
}

class ChatHistoryTile extends ConsumerStatefulWidget {
  const ChatHistoryTile({
    required this.session,
    required this.isSelected,
    this.showPreview = false,
    super.key,
  });

  final MobileChatSession session;
  final bool isSelected;

  /// Draws the last message under the row. The history shows it only while
  /// searching, where it is the reason the row matched; otherwise it is the
  /// same sentence on every chat that started from the same plan, and the time
  /// and the book's state are what tell chats apart.
  final bool showPreview;

  @override
  ConsumerState<ChatHistoryTile> createState() => _ChatHistoryTileState();
}

class _ChatHistoryTileState extends ConsumerState<ChatHistoryTile> {
  bool _archiving = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final selected = widget.isSelected;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadii.control),
    );
    // Two kinds of work, one glyph: the book this chat is making being planned,
    // written or edited, and — for the chat that is open — its own turn still
    // running. The second is only knowable for the open chat, since that is the
    // only conversation the controller holds.
    final session = widget.session;
    final projectId = session.activeProjectId ?? session.createdProjectId;
    final chatBusy = ref.watch(
      creationChatControllerProvider.select((state) => state.isBusy),
    );
    final busy =
        ref.watch(chatBookBusyProvider(projectId)) || (selected && chatBusy);

    final listed = ref.watch(
      projectsProvider.select((projects) => projects.value),
    );
    final summary = _bookForChat(listed, projectId);
    // A live book reads its progress off the status stream the busy provider
    // already follows, so the row's percentage moves with the book.
    final liveStatus = summary != null && summary.isLive
        ? ref.watch(projectStatusProvider(summary.id)).value
        : null;
    final book = summary == null
        ? null
        : liveStatus == null
        ? summary
        : projectWithLiveStatus(summary, liveStatus);
    final hasCover = book != null && book.pageCount > 0;
    final status = book == null
        ? null
        : hasCover
        ? bookStatusInfo(book)
        : _preBookStatus(book);

    final localizations = MaterialLocalizations.of(context);
    final when = relativeChatTime(
      session.lastMessageAt,
      now: DateTime.now(),
      localizations: localizations,
    );
    final foreground = selected ? colors.onPrimaryContainer : null;
    final supporting = selected
        ? colors.onPrimaryContainer.withValues(alpha: 0.82)
        : colors.onSurfaceVariant;
    final metaStyle = theme.textTheme.labelSmall?.copyWith(color: supporting);

    final Widget meta;
    if (status != null) {
      meta = Wrap(
        spacing: 8,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          BookStatusPill(info: status),
          Text(when, style: metaStyle),
        ],
      );
    } else {
      final preview = session.preview.trim();
      meta = Text(
        preview.isEmpty || widget.showPreview ? when : '$when · $preview',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: metaStyle,
      );
    }

    final leading = hasCover
        ? _CoverLeading(project: book, busy: busy)
        : ChatHistoryGlyph(
            busy: busy,
            color: selected
                ? colors.onPrimaryContainer
                : busy
                ? colors.primary
                : colors.onSurfaceVariant,
          );

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected
            ? colors.primaryContainer.withValues(alpha: 0.55)
            : Colors.transparent,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: Stack(
          children: [
            Semantics(
              onLongPressHint: 'Chat options',
              child: ListTile(
                contentPadding: const EdgeInsetsDirectional.only(
                  start: 12,
                  end: 12,
                ),
                minVerticalPadding: 10,
                minLeadingWidth: _leadingWidth,
                horizontalTitleGap: 12,
                selected: selected,
                tileColor: Colors.transparent,
                selectedTileColor: Colors.transparent,
                shape: shape,
                leading: leading,
                title: Text(
                  session.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: foreground,
                    fontWeight: selected ? FontWeight.w800 : FontWeight.w600,
                    height: 1.25,
                  ),
                ),
                subtitle: Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      meta,
                      if (widget.showPreview &&
                          session.preview.trim().isNotEmpty) ...[
                        const SizedBox(height: 2),
                        Text(
                          session.preview,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: metaStyle,
                        ),
                      ],
                    ],
                  ),
                ),
                onTap: () => _open(context),
                onLongPress: _archiving
                    ? null
                    : () {
                        AppHaptics.longPress();
                        _showOptions(context);
                      },
              ),
            ),
            // The open chat is marked twice — a tinted row and a bar on its
            // leading edge — so it still reads when the tint is the only thing
            // that differs between two rows of the same title.
            if (selected)
              PositionedDirectional(
                start: 0,
                top: 12,
                bottom: 12,
                width: 3,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.primary,
                      borderRadius: const BorderRadiusDirectional.horizontal(
                        end: Radius.circular(3),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// A chat whose project has no pages yet still says when the reader has
  /// something to do (a plan to review) or something went wrong.
  BookStatusInfo? _preBookStatus(MobileProjectSummary project) {
    return switch (project.status.toLowerCase()) {
      'plan_ready' => const BookStatusInfo(
        BookStatusKind.planReady,
        'Plan to review',
      ),
      'failed' => const BookStatusInfo(
        BookStatusKind.needsAttention,
        'Needs attention',
      ),
      _ => null,
    };
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
          // Which chat the sheet is about: two chats can share a first line.
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(24, 0, 24, 8),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(
                widget.session.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(
                  ctx,
                ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
          ),
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
