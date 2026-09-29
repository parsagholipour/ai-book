import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/motion.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';
import 'chat_history_tile.dart';
import 'chat_history_time.dart';
import 'pending_chat_sessions.dart';

/// The scrolling body of the chat drawer: [header] (the shortcuts and the book
/// shelf) followed by the chats, sectioned by date.
///
/// One scroll view rather than a pinned block above a scrolling list. A pinned
/// block is what made the drawer unusable at large text — the shelf alone could
/// fill the screen and leave the chats a sliver to scroll in — and it is why the
/// floating "New book" button had to sit on top of the last rows. Here the
/// shelf scrolls away, the date labels pin, and the primary action lives in the
/// drawer's footer where nothing scrolls under it.
class ChatHistoryList extends StatelessWidget {
  const ChatHistoryList({
    required this.history,
    required this.activeDraftId,
    required this.controller,
    required this.searching,
    required this.loading,
    required this.failed,
    required this.onRetry,
    required this.onRetryMore,
    this.pending = const [],
    this.header,
    super.key,
  });

  final ChatHistoryState? history;
  final String? activeDraftId;
  final List<PendingChatSession> pending;
  final ScrollController controller;
  final bool searching;
  final bool loading;
  final bool failed;
  final VoidCallback onRetry;
  final VoidCallback onRetryMore;

  /// Scrolls away with the list. Null while searching, so results take the
  /// whole drawer.
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    final sessions = history?.sessions ?? const <MobileChatSession>[];
    final hasMore = history?.nextCursor != null;
    final loadingMore = history?.loadingMore ?? false;
    final loadMoreFailed = history?.loadMoreFailed ?? false;
    final resultCount = sessions.length + pending.length;
    final localizations = MaterialLocalizations.of(context);
    final groups = searching
        ? [
            if (resultCount > 0)
              ChatDateGroup(
                label: hasMore
                    ? ''
                    : '$resultCount ${resultCount == 1 ? 'result' : 'results'}',
                sessions: sessions,
              ),
          ]
        : groupChatSessions(
            sessions,
            now: DateTime.now(),
            monthLabel: localizations.formatMonthYear,
          );
    final headerExtent = _groupHeaderExtent(context);
    final background =
        DrawerTheme.of(context).backgroundColor ??
        Theme.of(context).colorScheme.surfaceContainerLow;

    return CustomScrollView(
      controller: controller,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        if (header != null) SliverToBoxAdapter(child: header),
        if (loading) const SliverToBoxAdapter(child: ChatHistorySkeleton()),
        if (failed)
          SliverToBoxAdapter(
            child: AppErrorState(
              title: 'Chats unavailable',
              message: 'Could not load your chats.',
              onRetry: onRetry,
            ),
          ),
        if (!loading &&
            !failed &&
            sessions.isEmpty &&
            pending.isEmpty &&
            !hasMore &&
            !loadingMore)
          SliverToBoxAdapter(
            child: AppEmptyState(
              title: searching ? 'No matching chats' : 'No chats yet',
              message: searching
                  ? 'Try another title or words from the latest message.'
                  : 'Start a new book. Your conversations will appear here.',
              icon: searching ? Icons.search_off : Icons.chat_bubble_outline,
            ),
          ),
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
              if (group.label.isNotEmpty)
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
                  return ChatHistoryTile(
                    key: ValueKey(session.draftId),
                    session: session,
                    isSelected: session.draftId == activeDraftId,
                    showPreview: searching,
                  );
                },
              ),
            ],
          ),
        if (loadingMore)
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(20),
              child: Center(
                child: SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    semanticsLabel: 'Loading older chats',
                  ),
                ),
              ),
            ),
          ),
        if (loadMoreFailed)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  const Text('Could not load more chats.'),
                  AppButton.text(label: 'Try again', onPressed: onRetryMore),
                ],
              ),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 12)),
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
      alignment: AlignmentDirectional.centerStart,
      padding: const EdgeInsets.symmetric(horizontal: 20),
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
      child: Semantics(
        header: true,
        child: Text(
          label,
          style: Theme.of(context).textTheme.labelSmall?.copyWith(
            color: colors.onSurfaceVariant,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5,
          ),
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
    // Spinning until the server has the chat, and no longer: an entry that
    // already has its draftId is only waiting for its real tile to replace it,
    // which is not work being done.
    final creating = entry.draftId == null;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: ListTile(
        contentPadding: const EdgeInsetsDirectional.only(start: 12, end: 12),
        minVerticalPadding: 10,
        minLeadingWidth: 40,
        horizontalTitleGap: 12,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.control),
        ),
        leading: ChatHistoryGlyph(
          busy: creating,
          color: creating ? colors.primary : colors.onSurfaceVariant,
        ),
        title: Text(
          entry.title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
        subtitle: Text(
          'Creating…',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: colors.onSurfaceVariant),
        ),
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

/// Placeholder rows shaped like real ones, shown while the first page loads.
///
/// A spinner tells the reader something is coming; rows in the right places
/// also tell them what, and the list does not jump when it arrives.
class ChatHistorySkeleton extends StatelessWidget {
  const ChatHistorySkeleton({this.rows = 6, super.key});

  final int rows;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final fill = colors.onSurface.withValues(alpha: 0.10);
    Widget bar(double widthFactor, double height) => FractionallySizedBox(
      alignment: AlignmentDirectional.centerStart,
      widthFactor: widthFactor,
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: fill,
          borderRadius: BorderRadius.circular(4),
        ),
      ),
    );

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Loading your chats',
      child: ExcludeSemantics(
        child: AppShimmer(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Column(
              children: [
                for (var i = 0; i < rows; i++)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 20,
                      vertical: 10,
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(
                            color: fill,
                            borderRadius: BorderRadius.circular(
                              AppRadii.control,
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              bar(i.isEven ? 0.9 : 0.75, 12),
                              const SizedBox(height: 8),
                              bar(i.isEven ? 0.45 : 0.6, 10),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
