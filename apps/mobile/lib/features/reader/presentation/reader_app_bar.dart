import 'package:flutter/material.dart';

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
    required this.bookmarked,
    required this.immersive,
    required this.markupCount,
    required this.markingUp,
    required this.onSearch,
    required this.onToggleMarkup,
    required this.onMenuAction,
    super.key,
  });

  final String title;
  final bool bookmarked;
  final bool immersive;
  final int markupCount;
  final bool markingUp;

  /// Null while the searcher does not exist yet — it cannot until the viewer
  /// has a document.
  final VoidCallback? onSearch;

  final VoidCallback onToggleMarkup;
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
    );
    if (action == null || !mounted) return;
    widget.onMenuAction(action);
  }

  @override
  Widget build(BuildContext context) {
    return AppBar(
      title: Text(
        widget.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
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
          tooltip: widget.markingUp ? 'Put the tools away' : 'Mark up this book',
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
