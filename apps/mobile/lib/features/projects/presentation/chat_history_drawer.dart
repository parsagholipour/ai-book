import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../data/creation_repository.dart';
import '../domain/creation_models.dart';
import 'book_shelf.dart';
import 'chat_drawer_chrome.dart';
import 'chat_history_list.dart';
import 'pending_chat_sessions.dart';

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
  var _searchOpen = false;

  @override
  void initState() {
    super.initState();
    _searchFocus.addListener(_focusChanged);
    _scroll.addListener(_loadNearEnd);
  }

  void _focusChanged() {
    // Leaving an empty field without a query is leaving search, so the box
    // goes away rather than sitting empty over the list it was meant to hide.
    if (!_searchFocus.hasFocus && _search.text.trim().isEmpty && _searchOpen) {
      setState(() => _searchOpen = false);
      return;
    }
    setState(() {});
  }

  void _openSearch() {
    AppHaptics.tap();
    setState(() => _searchOpen = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _searchFocus.requestFocus();
    });
  }

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

    // With the keyboard up the footer is noise: it would take the room the
    // search results need, and nobody reaches for "New book" mid-search.
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    final showFooter = !(keyboardOpen && _searchOpen);

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
                ChatDrawerHeader(onSearchChats: _openSearch),
                if (_searchOpen)
                  Padding(
                    padding: const EdgeInsetsDirectional.fromSTEB(16, 4, 8, 8),
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
                              prefixIcon: const Icon(Icons.search, size: 21),
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
                                      icon: const Icon(Icons.close, size: 18),
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
                Expanded(
                  child: ClipRect(
                    key: const ValueKey('chat-history-scroll-clip'),
                    child: ChatHistoryList(
                      history: history,
                      activeDraftId: widget.activeDraftId,
                      pending: pending,
                      controller: _scroll,
                      searching: searching,
                      loading: sessions.isLoading && history == null,
                      failed: sessions.hasError && history == null,
                      onRetry: () => ref.invalidate(provider),
                      onRetryMore: () =>
                          ref.read(provider.notifier).loadMore(retry: true),
                      // Searching is about the chats: the shortcuts and the
                      // shelf step aside so results have the whole drawer.
                      header: _searchOpen ? null : const _DrawerShortcuts(),
                    ),
                  ),
                ),
                if (showFooter)
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

/// Characters and the shelf of books: what sits above the chats.
class _DrawerShortcuts extends StatelessWidget {
  const _DrawerShortcuts();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [DrawerCharactersRow(), BookShelf()],
    );
  }
}
