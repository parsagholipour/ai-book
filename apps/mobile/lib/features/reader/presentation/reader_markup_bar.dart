import 'package:flutter/material.dart';

import '../../../shared/ui/haptics.dart';
import '../domain/reader_annotation.dart';
import 'reader_annotation_painter.dart';
import 'reader_selection_actions.dart';

/// The top bar while a passage is selected.
///
/// Marking up lives here rather than in the bar over the text, and the whole
/// arrangement follows from which of the two matters more. Asking the book to
/// rewrite a passage is the reason this app exists, so that stays beside the
/// passage where the finger already is. Highlighting is frequent but shallow —
/// one tap, free, undone as easily as done — so it goes somewhere fixed and
/// learnable instead of somewhere close.
///
/// Two things follow from putting it up here. The floating bar shrinks to four
/// actions and stops covering the paragraph it acts on, and the swatches stop
/// moving: the yellow one is in the same place every time rather than wherever
/// the selection happened to be.
///
/// It replaces the reader's own top bar for as long as the selection lasts,
/// the way a contextual action bar does anywhere else, and it appears even in
/// full screen — someone who has just selected text has asked for tools.
class ReaderMarkupBar extends StatelessWidget implements PreferredSizeWidget {
  const ReaderMarkupBar({
    required this.palette,
    required this.defaultColorIndex,
    required this.onMarkup,
    required this.onNote,
    required this.onAction,
    required this.onDismiss,
    super.key,
  });

  final List<ReaderMarkupColor> palette;

  /// The colour underline and strikethrough use — the last one the reader
  /// picked, so those two do not need a colour decision of their own.
  final int defaultColorIndex;

  final void Function(ReaderMarkupStyle style, int colorIndex) onMarkup;
  final VoidCallback onNote;
  final void Function(ReaderSelectionAction action) onAction;
  final VoidCallback onDismiss;

  /// How many palette entries appear as highlight swatches. The rest of the
  /// palette is for the pen, where a strong colour is wanted rather than a
  /// wash the type still has to be read through.
  static const highlightSwatches = 4;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AppBar(
      backgroundColor: theme.colorScheme.surfaceContainerHigh,
      leading: IconButton(
        icon: const Icon(Icons.close),
        tooltip: 'Done',
        onPressed: onDismiss,
      ),
      titleSpacing: 0,
      title: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        // Resting at the start, so when the row is wider than the screen — a
        // narrow phone, a large text scale — it is the share and copy icons
        // that run off the end, never the colours.
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var index = 0; index < highlightSwatches; index++)
              _Swatch(
                color: readerMarkupColor(palette, index).color,
                label: '${readerMarkupColor(palette, index).name} highlight',
                onTap: () {
                  AppHaptics.selection();
                  onMarkup(ReaderMarkupStyle.highlight, index);
                },
              ),
            _divider(theme),
            _IconAction(
              icon: Icons.format_underlined,
              label: 'Underline',
              onTap: () {
                AppHaptics.selection();
                onMarkup(ReaderMarkupStyle.underline, defaultColorIndex);
              },
            ),
            _IconAction(
              icon: Icons.format_strikethrough,
              label: 'Strike through',
              onTap: () {
                AppHaptics.selection();
                onMarkup(ReaderMarkupStyle.strikethrough, defaultColorIndex);
              },
            ),
            _divider(theme),
            _IconAction(
              icon: Icons.sticky_note_2_outlined,
              label: 'Add a note',
              onTap: onNote,
            ),
            _IconAction(
              icon: Icons.copy_all_outlined,
              label: 'Copy',
              onTap: () => onAction(ReaderSelectionAction.copy),
            ),
            _IconAction(
              icon: Icons.ios_share_outlined,
              label: 'Share',
              onTap: () => onAction(ReaderSelectionAction.share),
            ),
          ],
        ),
      ),
    );
  }

  Widget _divider(ThemeData theme) => SizedBox(
    height: 22,
    child: VerticalDivider(
      width: 11,
      thickness: 1,
      color: theme.colorScheme.outlineVariant.withValues(alpha: 0.6),
    ),
  );
}

class _Swatch extends StatelessWidget {
  const _Swatch({
    required this.color,
    required this.label,
    required this.onTap,
  });

  final Color color;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: label,
        child: InkResponse(
          onTap: onTap,
          radius: 22,
          child: Padding(
            padding: const EdgeInsets.all(7),
            child: Container(
              width: 26,
              height: 26,
              decoration: BoxDecoration(
                color: color,
                shape: BoxShape.circle,
                border: Border.all(
                  color: Theme.of(
                    context,
                  ).colorScheme.outlineVariant.withValues(alpha: 0.7),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _IconAction extends StatelessWidget {
  const _IconAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 20),
      tooltip: label,
      visualDensity: VisualDensity.compact,
      onPressed: onTap,
    );
  }
}
