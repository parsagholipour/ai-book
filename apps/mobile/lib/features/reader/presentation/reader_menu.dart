import 'package:flutter/material.dart';

/// Everything the reader can reach from the overflow menu.
enum ReaderMenuAction {
  contents,
  callCharacter,
  toggleBookmark,
  savedPlaces,
  myMarkup,
  shareNotes,
  appearance,
  toggleFullScreen,
}

/// The reader's overflow menu.
///
/// Built like [showBookActionsMenu]: `showMenu` at the pointer, themed rows of
/// an outlined icon and a label. A popup rather than a sheet because it opens
/// from the top bar and covers almost nothing — the page the reader was on is
/// still there behind it.
///
/// Everything that is not search or markup lives here. The bar used to carry
/// five icons with nowhere left to grow, and none of them were things anyone
/// needs more than once in a sitting.
Future<ReaderMenuAction?> showReaderMenu({
  required BuildContext context,
  required Offset position,
  required bool bookmarked,
  required bool immersive,
  required int markupCount,
}) async {
  final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
  if (overlay is! RenderBox) return null;

  final hasMarkup = markupCount > 0;

  return showMenu<ReaderMenuAction>(
    context: context,
    position: RelativeRect.fromRect(
      Rect.fromPoints(position, position),
      Offset.zero & overlay.size,
    ),
    items: [
      _item(
        value: ReaderMenuAction.contents,
        icon: Icons.list_alt_outlined,
        label: 'Contents',
      ),
      _item(
        value: ReaderMenuAction.callCharacter,
        icon: Icons.record_voice_over_outlined,
        label: 'Call a character',
      ),
      _item(
        value: ReaderMenuAction.toggleBookmark,
        icon: bookmarked ? Icons.bookmark : Icons.bookmark_outline,
        label: bookmarked ? 'Remove bookmark' : 'Bookmark this page',
      ),
      _item(
        value: ReaderMenuAction.savedPlaces,
        icon: Icons.bookmarks_outlined,
        label: 'Saved places',
      ),
      const PopupMenuDivider(),
      _item(
        value: ReaderMenuAction.myMarkup,
        icon: Icons.format_list_bulleted,
        // The count is the whole point of the row: it is how someone knows
        // there is anything in there without opening it.
        label: hasMarkup ? 'My markup ($markupCount)' : 'My markup',
        enabled: hasMarkup,
      ),
      _item(
        value: ReaderMenuAction.shareNotes,
        icon: Icons.ios_share_outlined,
        label: 'Share my notes',
        enabled: hasMarkup,
      ),
      const PopupMenuDivider(),
      _item(
        value: ReaderMenuAction.appearance,
        icon: Icons.contrast_outlined,
        label: 'Appearance',
      ),
      _item(
        value: ReaderMenuAction.toggleFullScreen,
        icon: immersive ? Icons.fullscreen_exit : Icons.fullscreen,
        label: immersive ? 'Exit full screen' : 'Full screen',
      ),
    ],
  );
}

PopupMenuItem<ReaderMenuAction> _item({
  required ReaderMenuAction value,
  required IconData icon,
  required String label,
  bool enabled = true,
}) {
  return PopupMenuItem<ReaderMenuAction>(
    value: value,
    enabled: enabled,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon),
        const SizedBox(width: 12),
        // Flexible so long labels and large text scales shrink rather than
        // overflow the row.
        Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
      ],
    ),
  );
}
