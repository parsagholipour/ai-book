import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'reader_menu.dart';

/// The reader's top bar.
///
/// Three actions, not the five it grew to: search, the markup tools, and
/// everything else behind the overflow. A reading screen that spends a third of
/// its width on buttons is a screen that is mostly about its buttons, and every
/// one of the things that moved into the menu is used once a session at most.
class ReaderAppBar extends StatefulWidget implements PreferredSizeWidget {
  const ReaderAppBar({
    required this.title,
    required this.projectId,
    required this.bookmarked,
    required this.immersive,
    required this.markupCount,
    required this.markingUp,
    required this.onSearch,
    required this.onToggleMarkup,
    required this.onMenuAction,
    this.bookmarkingEnabled = true,
    this.bookActionsEnabled = true,
    super.key,
  });

  final String title;

  /// The book being read, for the case where there is nothing behind it to pop.
  final String projectId;
  final bool bookmarked;
  final bool immersive;
  final int markupCount;
  final bool markingUp;
  final bool bookmarkingEnabled;
  final bool bookActionsEnabled;

  /// Null while the searcher does not exist yet — it cannot until the viewer
  /// has a document.
  final VoidCallback? onSearch;

  final VoidCallback? onToggleMarkup;
  final void Function(ReaderMenuAction action) onMenuAction;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  State<ReaderAppBar> createState() => _ReaderAppBarState();
}

class _ReaderAppBarState extends State<ReaderAppBar> {
  final _menuButtonKey = GlobalKey();

  Future<void> _openMenu() async {
    // Anchored under the button rather than at the pointer, so the menu drops
    // from the control that opened it however it was triggered.
    final button = _menuButtonKey.currentContext?.findRenderObject();
    final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
    if (button is! RenderBox || overlay is! RenderBox) return;
    final position = button.localToGlobal(
      button.size.bottomRight(Offset.zero),
      ancestor: overlay,
    );

    final action = await showReaderMenu(
      context: context,
      position: position,
      bookmarked: widget.bookmarked,
      immersive: widget.immersive,
      markupCount: widget.markupCount,
      bookmarkingEnabled: widget.bookmarkingEnabled,
      bookActionsEnabled: widget.bookActionsEnabled,
    );
    if (action == null || !mounted) return;
    widget.onMenuAction(action);
  }

  @override
  Widget build(BuildContext context) {
    return AppBar(
      title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
      // A reader who arrived by deep link has nothing behind them to pop, and
      // Android back would leave the app rather than the book. The same rule
      // the waiting scaffold states, applied to the screen that shows it for
      // the whole session rather than for a moment.
      leading: Navigator.of(context).canPop()
          ? null
          : IconButton(
              tooltip: 'Close',
              icon: const Icon(Icons.close),
              onPressed: () => context.go('/projects/${widget.projectId}'),
            ),
      actions: [
        IconButton(
          icon: const Icon(Icons.search),
          tooltip: 'Search this book',
          onPressed: widget.onSearch,
        ),
        IconButton(
          key: const Key('reader-markup-toggle'),
          isSelected: widget.markingUp,
          icon: const Icon(Icons.draw_outlined),
          selectedIcon: const Icon(Icons.draw),
          tooltip: widget.markingUp
              ? 'Put the tools away'
              : 'Mark up this book',
          onPressed: widget.onToggleMarkup,
        ),
        IconButton(
          key: _menuButtonKey,
          icon: const Icon(Icons.more_vert),
          tooltip: 'More',
          onPressed: () => _openMenu(),
        ),
      ],
    );
  }
}
