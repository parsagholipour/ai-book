part of 'creation_chat_screen.dart';

// The top bar: the menu, where you are, one action that belongs to the stage,
// and one overflow that holds the rest. It used to be five bare icons and no
// words; a first-time reader could not tell "new chat" from "book" without
// tapping. Imports and shared state live in the parent library file.

enum _ChatBarAction { newBook, refresh, account }

class _CreationChatAppBar extends StatelessWidget
    implements PreferredSizeWidget {
  const _CreationChatAppBar({
    required this.drawerKey,
    required this.loading,
    required this.onNewBook,
    required this.onAccount,
    this.activeProjectId,
    this.onOpenBook,
    this.onOpenAdvanced,
    this.onRefresh,
  });

  final GlobalKey<EasyDrawerControllerState> drawerKey;

  /// The chat is still loading, so there is nothing to call it yet: "New book"
  /// would mislabel a resumed chat for as long as it takes to arrive.
  final bool loading;
  final VoidCallback onNewBook;
  final VoidCallback onAccount;

  /// Non-null once the chat has built a book: the stage's action is then
  /// "open it", and Refresh joins the overflow.
  final String? activeProjectId;
  final VoidCallback? onOpenBook;

  /// The pre-build stage's action: the presets that shape the book. Null while
  /// the chat is still loading.
  final VoidCallback? onOpenAdvanced;
  final VoidCallback? onRefresh;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    final built = activeProjectId != null;
    // Which stage this is, not what the book is called: the brief header below
    // names the book, and a chat's derived title is only its label in the
    // history drawer.
    final title = loading
        ? ''
        : built
        ? 'Your book'
        : 'New book';
    return AppBar(
      leading: EasyDrawerButton(controllerKey: drawerKey),
      // The leading button already carries its own 48dp; the default 16dp on
      // top of it pushed the title away from the thing it belongs to.
      titleSpacing: 0,
      title: title.isEmpty
          ? null
          : Semantics(
              header: true,
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.2,
                ),
              ),
            ),
      actions: [
        if (built)
          IconButton(
            tooltip: 'Open book',
            onPressed: onOpenBook,
            icon: const Icon(Icons.menu_book_outlined),
          )
        else
          IconButton(
            tooltip: 'Advanced settings',
            onPressed: onOpenAdvanced,
            icon: const Icon(Icons.tune),
          ),
        PopupMenuButton<_ChatBarAction>(
          key: const ValueKey('chat-app-bar-more'),
          tooltip: 'More options',
          icon: const Icon(Icons.more_vert),
          onSelected: (action) {
            switch (action) {
              case _ChatBarAction.newBook:
                onNewBook();
              case _ChatBarAction.refresh:
                onRefresh?.call();
              case _ChatBarAction.account:
                onAccount();
            }
          },
          itemBuilder: (context) => [
            const PopupMenuItem(
              value: _ChatBarAction.newBook,
              child: _ChatBarMenuRow(
                icon: Icons.add_circle_outline,
                label: 'New book',
              ),
            ),
            if (built && onRefresh != null)
              const PopupMenuItem(
                value: _ChatBarAction.refresh,
                child: _ChatBarMenuRow(icon: Icons.refresh, label: 'Refresh'),
              ),
            const PopupMenuItem(
              value: _ChatBarAction.account,
              child: _ChatBarMenuRow(
                icon: Icons.account_circle_outlined,
                label: 'Account',
              ),
            ),
          ],
        ),
        const SizedBox(width: 4),
      ],
    );
  }
}

class _ChatBarMenuRow extends StatelessWidget {
  const _ChatBarMenuRow({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 22),
        const SizedBox(width: AppSpacing.sm),
        Text(label),
      ],
    );
  }
}
