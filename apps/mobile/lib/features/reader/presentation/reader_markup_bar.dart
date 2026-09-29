import 'package:flutter/material.dart';

import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
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
    this.markupEnabled = true,
    super.key,
  });

  final List<ReaderMarkupColor> palette;

  /// The colour underline and strikethrough use — the last one the reader
  /// picked, so those two do not need a colour decision of their own.
  final int defaultColorIndex;
  final bool markupEnabled;

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
    final barColor = theme.colorScheme.surfaceContainerHigh;
    return AppBar(
      backgroundColor: barColor,
      leading: IconButton(
        icon: const Icon(Icons.close),
        tooltip: 'Done',
        onPressed: onDismiss,
      ),
      // The close button is 48 wide, not the 56 an app bar gives its leading
      // slot: on a 360-pixel phone those eight pixels are what lets Copy sit
      // inside the bar rather than on its edge.
      leadingWidth: 48,
      titleSpacing: 0,
      title: _ScrollFade(
        color: barColor,
        // Resting at the start, so when the row is wider than the screen — a
        // narrow phone, a large text scale — it is the share and copy icons
        // that run off the end, never the colours. The fade at the end says
        // there is more there.
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var index = 0; index < highlightSwatches; index++)
              _Swatch(
                color: readerMarkupColor(palette, index).color,
                label: '${readerMarkupColor(palette, index).name} highlight',
                onTap: markupEnabled
                    ? () {
                        AppHaptics.selection();
                        onMarkup(ReaderMarkupStyle.highlight, index);
                      }
                    : null,
              ),
            _divider(theme),
            _IconAction(
              icon: Icons.format_underlined,
              label: 'Underline',
              onTap: markupEnabled
                  ? () {
                      AppHaptics.selection();
                      onMarkup(ReaderMarkupStyle.underline, defaultColorIndex);
                    }
                  : null,
            ),
            _IconAction(
              icon: Icons.format_strikethrough,
              label: 'Strike through',
              onTap: markupEnabled
                  ? () {
                      AppHaptics.selection();
                      onMarkup(
                        ReaderMarkupStyle.strikethrough,
                        defaultColorIndex,
                      );
                    }
                  : null,
            ),
            _divider(theme),
            _IconAction(
              icon: Icons.sticky_note_2_outlined,
              label: 'Add a note',
              onTap: markupEnabled ? onNote : null,
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
  const _Swatch({required this.color, required this.label, this.onTap});

  final Color color;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: onTap != null,
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
  const _IconAction({required this.icon, required this.label, this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

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

/// A row that scrolls sideways and shows, with a fade at its end, that it does.
///
/// The bar above is wider than a phone once every action is on it. Scrolling is
/// the right answer; a scroll nobody knows is there is not — the last two
/// actions were simply off the edge.
class _ScrollFade extends StatefulWidget {
  const _ScrollFade({required this.color, required this.child});

  /// The colour behind the row, which the fade dissolves into.
  final Color color;
  final Widget child;

  @override
  State<_ScrollFade> createState() => _ScrollFadeState();
}

class _ScrollFadeState extends State<_ScrollFade> {
  final _controller = ScrollController();
  bool _more = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_update);
    WidgetsBinding.instance.addPostFrameCallback((_) => _update());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _update() {
    if (!mounted || !_controller.hasClients) return;
    final position = _controller.position;
    final more = position.pixels < position.maxScrollExtent - 1;
    if (more != _more) setState(() => _more = more);
  }

  @override
  Widget build(BuildContext context) {
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.fast;
    return NotificationListener<ScrollMetricsNotification>(
      onNotification: (_) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _update());
        return false;
      },
      child: Stack(
        children: [
          SingleChildScrollView(
            controller: _controller,
            scrollDirection: Axis.horizontal,
            child: widget.child,
          ),
          PositionedDirectional(
            end: 0,
            top: 0,
            bottom: 0,
            width: 32,
            child: IgnorePointer(
              child: AnimatedOpacity(
                opacity: _more ? 1 : 0,
                duration: duration,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: AlignmentDirectional.centerStart,
                      end: AlignmentDirectional.centerEnd,
                      colors: [widget.color.withValues(alpha: 0), widget.color],
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
