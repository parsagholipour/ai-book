import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../../billing/presentation/billing_paywall.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';
import 'book_shelf.dart';
import 'creation_chat_controller.dart';
import 'creation_chat_navigation.dart';
import 'pending_chat_sessions.dart';

class ChatHistoryDrawer extends ConsumerWidget {
  const ChatHistoryDrawer({super.key, this.activeDraftId});

  final String? activeDraftId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(chatSessionsProvider);
    // Chats whose first send is still in flight (or just resolved but not yet
    // in the fetched list) so a brand-new chat is never invisible.
    final fetchedIds =
        sessions.value?.map((session) => session.draftId).toSet() ??
        const <String>{};
    final pending = [
      for (final entry in ref.watch(pendingChatSessionsProvider))
        if (entry.draftId == null || !fetchedIds.contains(entry.draftId)) entry,
    ];
    final billing = ref.watch(billingProvider);
    final colors = Theme.of(context).colorScheme;
    final drawerBackground =
        DrawerTheme.of(context).backgroundColor ?? colors.surfaceContainerLow;

    return Drawer(
      backgroundColor: drawerBackground,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ColoredBox(
              color: drawerBackground,
              child: const Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  _DrawerHeader(),
                  _NewBookButton(),
                  SizedBox(height: 8),
                  BookShelf(),
                ],
              ),
            ),
            Expanded(
              child: ClipRect(
                key: const ValueKey('chat-history-scroll-clip'),
                child: sessions.when(
                  data: (items) => items.isEmpty && pending.isEmpty
                      ? const AppEmptyState(
                          title: 'No chats yet',
                          message: 'Start a new book to begin a conversation.',
                          icon: Icons.chat_bubble_outline,
                        )
                      : _ChatList(
                          sessions: items,
                          activeDraftId: activeDraftId,
                          pending: pending,
                        ),
                  loading: () =>
                      const Center(child: CircularProgressIndicator()),
                  error: (_, _) => AppErrorState(
                    title: 'Chats unavailable',
                    message: 'Could not load your chats.',
                    onRetry: () => ref.invalidate(chatSessionsProvider),
                  ),
                ),
              ),
            ),
            const Divider(height: 1),
            _DrawerFooter(billing: billing, colors: colors),
          ],
        ),
      ),
    );
  }
}

class _DrawerHeader extends StatelessWidget {
  const _DrawerHeader();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
      child: Row(
        children: [
          Icon(Icons.auto_stories, color: colors.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'Tomeza',
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
            ),
          ),
          IconButton(
            tooltip: 'Close',
            icon: const Icon(Icons.close),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

class _NewBookButton extends StatelessWidget {
  const _NewBookButton();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: AppButton.primary(
        label: 'New book',
        onPressed: () {
          AppHaptics.tap();
          Navigator.of(context).pop();
          context.go(newBookChatLocation());
        },
        leading: const Icon(Icons.edit_document),
        expanded: true,
        alignStart: true,
      ),
    );
  }
}

class _GroupData {
  const _GroupData({required this.label, required this.sessions});
  final String label;
  final List<MobileChatSession> sessions;
}

List<_GroupData> _groupByDate(List<MobileChatSession> sorted) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final yesterday = today.subtract(const Duration(days: 1));
  final sevenDaysAgo = today.subtract(const Duration(days: 7));

  final todayItems = <MobileChatSession>[];
  final yesterdayItems = <MobileChatSession>[];
  final last7Items = <MobileChatSession>[];
  final olderItems = <MobileChatSession>[];

  for (final s in sorted) {
    final at = s.lastMessageAt.toLocal();
    final date = DateTime(at.year, at.month, at.day);
    if (!date.isBefore(today)) {
      todayItems.add(s);
    } else if (!date.isBefore(yesterday)) {
      yesterdayItems.add(s);
    } else if (!date.isBefore(sevenDaysAgo)) {
      last7Items.add(s);
    } else {
      olderItems.add(s);
    }
  }

  return [
    if (todayItems.isNotEmpty) _GroupData(label: 'Today', sessions: todayItems),
    if (yesterdayItems.isNotEmpty)
      _GroupData(label: 'Yesterday', sessions: yesterdayItems),
    if (last7Items.isNotEmpty)
      _GroupData(label: 'Last 7 days', sessions: last7Items),
    if (olderItems.isNotEmpty) _GroupData(label: 'Older', sessions: olderItems),
  ];
}

class _ChatList extends StatelessWidget {
  const _ChatList({
    required this.sessions,
    required this.activeDraftId,
    this.pending = const [],
  });

  final List<MobileChatSession> sessions;
  final String? activeDraftId;
  final List<PendingChatSession> pending;

  @override
  Widget build(BuildContext context) {
    if (sessions.isEmpty && pending.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text(
          'No chats yet. Start your first book.',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }

    final groups = _groupByDate(sessions);
    final headerExtent = _groupHeaderExtent(context);
    final background =
        DrawerTheme.of(context).backgroundColor ??
        Theme.of(context).colorScheme.surfaceContainerLow;

    return CustomScrollView(
      slivers: [
        if (pending.isNotEmpty)
          SliverMainAxisGroup(
            slivers: [
              SliverPersistentHeader(
                pinned: true,
                delegate: _GroupHeaderDelegate(
                  label: 'In progress',
                  extent: headerExtent,
                  background: background,
                ),
              ),
              SliverList.builder(
                itemCount: pending.length,
                itemBuilder: (context, index) =>
                    _PendingChatTile(entry: pending[index]),
              ),
            ],
          ),
        for (final group in groups)
          SliverMainAxisGroup(
            slivers: [
              SliverPersistentHeader(
                pinned: true,
                delegate: _GroupHeaderDelegate(
                  label: group.label,
                  extent: headerExtent,
                  background: background,
                ),
              ),
              SliverList.builder(
                itemCount: group.sessions.length,
                itemBuilder: (context, index) {
                  final session = group.sessions[index];
                  return _ChatTile(
                    session: session,
                    isSelected: session.draftId == activeDraftId,
                  );
                },
              ),
            ],
          ),
      ],
    );
  }
}

/// Height of a pinned group label, scaled with the user's text size so the
/// fixed-extent header never clips its own text.
double _groupHeaderExtent(BuildContext context) {
  final fontSize = Theme.of(context).textTheme.labelSmall?.fontSize ?? 11;
  return MediaQuery.textScalerOf(context).scale(fontSize) * 1.4 + 16;
}

class _GroupHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _GroupHeaderDelegate({
    required this.label,
    required this.extent,
    required this.background,
  });

  final String label;
  final double extent;
  final Color background;

  @override
  double get minExtent => extent;

  @override
  double get maxExtent => extent;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        // Opaque so chats scroll underneath the label instead of through it.
        color: background,
        border: overlapsContent
            ? Border(
                bottom: BorderSide(
                  color: colors.outlineVariant.withValues(alpha: 0.5),
                ),
              )
            : null,
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: colors.onSurfaceVariant,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  @override
  bool shouldRebuild(_GroupHeaderDelegate oldDelegate) {
    return oldDelegate.label != label ||
        oldDelegate.extent != extent ||
        oldDelegate.background != background;
  }
}

class _PendingChatTile extends StatelessWidget {
  const _PendingChatTile({required this.entry});

  final PendingChatSession entry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: ListTile(
        dense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
        minVerticalPadding: 2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        leading: Icon(
          Icons.chat_bubble_outline,
          size: 20,
          color: colors.onSurfaceVariant,
        ),
        title: Text(
          entry.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        subtitle: Text(
          'Creating…',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
        ),
        trailing: entry.draftId == null
            ? const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : null,
        onTap: () => _open(context),
      ),
    );
  }

  void _open(BuildContext context) {
    final draftId = entry.draftId;
    if (draftId == null) {
      // The session does not exist server-side until the first turn finishes,
      // so there is nothing to navigate to yet.
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(
          content: Text(
            'Still creating this chat — it will be ready in a moment.',
          ),
        ),
      );
      return;
    }
    Navigator.of(context).pop();
    context.go('/books/chat/$draftId');
  }
}

class _ChatTile extends ConsumerStatefulWidget {
  const _ChatTile({required this.session, required this.isSelected});

  final MobileChatSession session;
  final bool isSelected;

  @override
  ConsumerState<_ChatTile> createState() => _ChatTileState();
}

class _ChatTileState extends ConsumerState<_ChatTile> {
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final selected = widget.isSelected;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(12),
    );

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
          leading: Icon(
            Icons.chat_bubble_outline,
            size: 20,
            color: selected
                ? colors.onPrimaryContainer
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
          onLongPress: () {
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
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
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
      ref.invalidate(chatSessionsProvider);
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

  Future<void> _doDelete() async {
    try {
      await ref
          .read(creationRepositoryProvider)
          .deleteSession(widget.session.draftId);
      ref
          .read(creationConversationCacheProvider)
          .remove(widget.session.draftId);
      ref.invalidate(chatSessionsProvider);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showAppSnackBar(
          const SnackBar(content: Text('Could not delete the chat.')),
        );
      }
    }
  }
}

class _DrawerFooter extends StatelessWidget {
  const _DrawerFooter({required this.billing, required this.colors});

  final AsyncValue<MobileBilling> billing;
  final ColorScheme colors;

  @override
  Widget build(BuildContext context) {
    final creditLabel = billing.whenOrNull(
      data: (b) => '${b.credits.available} credits',
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      child: Row(
        children: [
          AppButton.text(
            label: 'Account',
            onPressed: () {
              Navigator.of(context).pop();
              context.push('/account');
            },
            leading: const Icon(Icons.account_circle_outlined),
          ),
          if (creditLabel != null) ...[
            const SizedBox(width: 8),
            Flexible(
              child: Align(
                alignment: Alignment.centerRight,
                child: Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Theme(
                    data: Theme.of(context).copyWith(
                      textButtonTheme: TextButtonThemeData(
                        style:
                            (Theme.of(context).textButtonTheme.style ??
                                    const ButtonStyle())
                                .copyWith(
                                  foregroundColor: WidgetStatePropertyAll(
                                    colors.onSurfaceVariant,
                                  ),
                                  textStyle: WidgetStatePropertyAll(
                                    Theme.of(context).textTheme.labelSmall,
                                  ),
                                ),
                      ),
                    ),
                    child: AppButton.text(
                      label: creditLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      onPressed: () {
                        final navigator = Navigator.of(context);
                        navigator.pop();
                        showBillingPaywall(
                          navigator.context,
                          title: 'Add book credits',
                          message:
                              'Credits are used when you approve a full book or unlock finished exports.',
                        );
                      },
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
