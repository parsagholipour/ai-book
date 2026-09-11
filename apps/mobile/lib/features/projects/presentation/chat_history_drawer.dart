import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/presentation/character_library_screen.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';
import 'book_shelf.dart';
import 'chat_drawer_chrome.dart';
import 'chat_history_tile.dart';
import 'pending_chat_sessions.dart';

/// Room for at least one chat row when the pinned chrome is taller than the
/// remaining viewport (large text plus a keyboard).
const double _minChatList = 160;

class ChatHistoryDrawer extends ConsumerStatefulWidget {
  const ChatHistoryDrawer({super.key, this.activeDraftId});

  final String? activeDraftId;

  @override
  ConsumerState<ChatHistoryDrawer> createState() => _ChatHistoryDrawerState();
}

class _ChatHistoryDrawerState extends ConsumerState<ChatHistoryDrawer> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _searchFocus.addListener(_focusChanged);
    _scroll.addListener(_loadNearEnd);
  }

  void _focusChanged() => setState(() {});

  String get _query => _search.text.trim().toLowerCase();

  AsyncNotifierProvider<ChatHistoryController, ChatHistoryState>
  get _historyProvider =>
      _query.isEmpty ? chatSessionsProvider : chatSearchProvider(_query);

  void _loadNearEnd() {
    if (!mounted || !_scroll.hasClients) {
      return;
    }
    final provider = _historyProvider;
    final history = ref.read(provider).value;
    final keepScanning =
        history != null &&
        history.nextCursor != null &&
        (history.sessions.isEmpty || _scroll.position.maxScrollExtent <= 240);
    if (!keepScanning && _scroll.position.extentAfter > 240) {
      return;
    }
    ref.read(provider.notifier).loadMore();
  }

  @override
  void dispose() {
    _searchFocus.removeListener(_focusChanged);
    _searchFocus.dispose();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _searchChanged(String value) {
    setState(() {});
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  @override
  Widget build(BuildContext context) {
    final query = _query;
    final provider = _historyProvider;
    final sessions = ref.watch(provider);
    // Also fill a tall viewport or a short page without requiring a new drag.
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadNearEnd());
    final searching = query.isNotEmpty;
    final focused = _searchFocus.hasFocus;
    final history = sessions.isReloading ? null : sessions.value;
    final fetched = history?.sessions ?? const <MobileChatSession>[];
    final fetchedIds = fetched.map((session) => session.draftId).toSet();
    final pending = [
      for (final entry in ref.watch(pendingChatSessionsProvider))
        if ((entry.draftId == null || !fetchedIds.contains(entry.draftId)) &&
            (!searching || entry.title.toLowerCase().contains(query)))
          entry,
    ];
    final colors = Theme.of(context).colorScheme;
    final drawerBackground =
        DrawerTheme.of(context).backgroundColor ?? colors.surfaceContainerLow;

    // Keep feedback above the drawer in both Material and EasyDrawer hosts.
    return Drawer(
      backgroundColor: drawerBackground,
      child: ScaffoldMessenger(
        child: Scaffold(
          primary: false,
          backgroundColor: drawerBackground,
          resizeToAvoidBottomInset: false,
          body: SafeArea(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: CustomMultiChildLayout(
                    delegate: _DrawerBodyDelegate(minListHeight: _minChatList),
                    children: [
                      LayoutId(
                        id: _DrawerBodyDelegate.chromeId,
                        child: ColoredBox(
                          color: drawerBackground,
                          child: const SingleChildScrollView(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                ChatDrawerHeader(),
                                SizedBox(height: 4),
                                _CharactersRow(),
                                BookShelf(),
                              ],
                            ),
                          ),
                        ),
                      ),
                      LayoutId(
                        id: _DrawerBodyDelegate.searchId,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                          child: Row(
                            children: [
                              Expanded(
                                child: TextField(
                                  controller: _search,
                                  maxLength: 200,
                                  focusNode: _searchFocus,
                                  onChanged: _searchChanged,
                                  textInputAction: TextInputAction.search,
                                  onSubmitted: (_) => _searchFocus.unfocus(),
                                  decoration: InputDecoration(
                                    hintText: 'Search chats',
                                    counterText: '',
                                    prefixIcon: const Icon(
                                      Icons.search,
                                      size: 21,
                                    ),
                                    contentPadding: const EdgeInsets.symmetric(
                                      vertical: 12,
                                    ),
                                    fillColor: colors.surfaceContainerHigh,
                                    enabledBorder: OutlineInputBorder(
                                      borderRadius: BorderRadius.circular(
                                        AppRadii.control,
                                      ),
                                      borderSide: BorderSide.none,
                                    ),
                                    suffixIcon: _search.text.isEmpty
                                        ? null
                                        : IconButton(
                                            tooltip: 'Clear search',
                                            icon: const Icon(
                                              Icons.close,
                                              size: 18,
                                            ),
                                            onPressed: () {
                                              _search.clear();
                                              _searchChanged('');
                                            },
                                          ),
                                  ),
                                ),
                              ),
                              if (focused)
                                IconButton(
                                  tooltip: 'Done searching',
                                  icon: const Icon(Icons.check),
                                  onPressed: () => _searchFocus.unfocus(),
                                ),
                            ],
                          ),
                        ),
                      ),
                      LayoutId(
                        id: _DrawerBodyDelegate.listId,
                        // The chat list fills the region and "New book" floats
                        // over its bottom-left corner, so the drawer's primary
                        // action stays put however far down a long history the
                        // reader has scrolled.
                        child: Stack(
                          children: [
                            Positioned.fill(
                              child: ClipRect(
                                key: const ValueKey('chat-history-scroll-clip'),
                                child: _ChatList(
                                  history: history,
                                  activeDraftId: widget.activeDraftId,
                                  pending: pending,
                                  controller: _scroll,
                                  searching: searching,
                                  loading:
                                      sessions.isLoading && history == null,
                                  failed: sessions.hasError && history == null,
                                  onRetry: () => ref.invalidate(provider),
                                  onRetryMore: () => ref
                                      .read(provider.notifier)
                                      .loadMore(retry: true),
                                ),
                              ),
                            ),
                            const Positioned(
                              left: 12,
                              bottom: 12,
                              child: ChatDrawerNewBookButton(),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1),
                ChatDrawerFooter(
                  billing: ref.watch(billingProvider),
                  colors: colors,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Pins Header / Characters / BookShelf above search and the chat list, and
/// shrinks that chrome first so a short viewport still shows search results.
class _DrawerBodyDelegate extends MultiChildLayoutDelegate {
  _DrawerBodyDelegate({required this.minListHeight});

  static const chromeId = 'chrome';
  static const searchId = 'search';
  static const listId = 'list';

  final double minListHeight;

  @override
  void performLayout(Size size) {
    final searchSize = layoutChild(searchId, BoxConstraints.loose(size));
    final listMin = math.min(
      minListHeight,
      math.max(0, size.height - searchSize.height),
    );
    final chromeSize = layoutChild(
      chromeId,
      BoxConstraints(
        maxWidth: size.width,
        maxHeight: math.max(0, size.height - searchSize.height - listMin),
      ),
    );
    layoutChild(
      listId,
      BoxConstraints.tight(
        Size(
          size.width,
          math.max(0, size.height - chromeSize.height - searchSize.height),
        ),
      ),
    );
    positionChild(chromeId, Offset.zero);
    positionChild(searchId, Offset(0, chromeSize.height));
    positionChild(listId, Offset(0, chromeSize.height + searchSize.height));
  }

  @override
  bool shouldRelayout(_DrawerBodyDelegate oldDelegate) {
    return oldDelegate.minListHeight != minListHeight;
  }
}

/// Entry to the account-wide character library, sitting above "Your books":
/// characters outlive any one book the same way the shelf's books outlive any
/// one chat.
class _CharactersRow extends ConsumerWidget {
  const _CharactersRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    // Count only when the library is already cached — the row must not make
    // the drawer wait, and the screen behind it always loads fresh.
    final count = ref.watch(charactersProvider).asData?.value.characters.length;
    // Own Material: the drawer's header block paints a background color, and a
    // bare ListTile's ink would vanish beneath it.
    return Material(
      type: MaterialType.transparency,
      child: ListTile(
        key: const ValueKey('drawer-characters-row'),
        dense: true,
        visualDensity: VisualDensity.compact,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16),
        leading: Icon(Icons.people_outline, color: colors.onSurfaceVariant),
        title: const Text('Characters'),
        subtitle: Text(
          'Reusable across all your books',
          style: Theme.of(
            context,
          ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (count != null && count > 0)
              Text(
                '$count',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            const SizedBox(width: 4),
            Icon(Icons.chevron_right, color: colors.onSurfaceVariant),
          ],
        ),
        onTap: () {
          AppHaptics.tap();
          Navigator.of(context).push<void>(
            MaterialPageRoute(builder: (_) => const CharacterLibraryScreen()),
          );
        },
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
    this.history,
    required this.activeDraftId,
    this.pending = const [],
    required this.controller,
    required this.searching,
    required this.loading,
    required this.failed,
    required this.onRetry,
    required this.onRetryMore,
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

  @override
  Widget build(BuildContext context) {
    final sessions = history?.sessions ?? const <MobileChatSession>[];
    final hasMore = history?.nextCursor != null;
    final loadingMore = history?.loadingMore ?? false;
    final loadMoreFailed = history?.loadMoreFailed ?? false;
    final resultCount = sessions.length + pending.length;
    final groups = searching
        ? [
            if (resultCount > 0)
              _GroupData(
                label: hasMore
                    ? ''
                    : '$resultCount ${resultCount == 1 ? 'result' : 'results'}',
                sessions: sessions,
              ),
          ]
        : _groupByDate(sessions);
    final headerExtent = _groupHeaderExtent(context);
    final background =
        DrawerTheme.of(context).backgroundColor ??
        Theme.of(context).colorScheme.surfaceContainerLow;

    return CustomScrollView(
      controller: controller,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        if (loading)
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            ),
          ),
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
        // Clearance for the floating "New book" button, so the last chat can
        // still be scrolled out from under it.
        const SliverToBoxAdapter(child: SizedBox(height: 76)),
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
    // Spinning until the server has the chat, and no longer: an entry that
    // already has its draftId is only waiting for its real tile to replace it,
    // which is not work being done.
    final creating = entry.draftId == null;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: ListTile(
        dense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
        minVerticalPadding: 2,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        leading: ChatHistoryGlyph(
          busy: creating,
          color: creating ? colors.primary : colors.onSurfaceVariant,
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
