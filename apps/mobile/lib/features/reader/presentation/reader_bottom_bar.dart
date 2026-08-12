import 'package:flutter/material.dart';

import 'reader_annotation_controller.dart';
import 'reader_annotation_painter.dart';
import 'reader_markup_toolbar.dart';

/// Everything the reader keeps at the bottom of the screen.
///
/// The bar used to be a horizontal slider under a vertically scrolling
/// document — the wrong axis, and 400 discrete stops on a long book. Travel now
/// belongs to the handle on the right edge, which leaves this space for what a
/// reader actually wants mid-page: where they are, and the three things they
/// reach for without leaving the page.
///
/// It owns the markup tray as well, because the two share the slot: while
/// marking up, the tray stacks below the bar and the bar gives up its own
/// safe-area padding to it.
class ReaderBottomChrome extends StatelessWidget {
  const ReaderBottomChrome({
    required this.annotations,
    required this.palette,
    required this.currentPage,
    required this.pageCount,
    required this.chapterTitle,
    required this.bookmarked,
    required this.onContents,
    required this.onToggleBookmark,
    required this.onListen,
    super.key,
  });

  final ReaderAnnotationController annotations;
  final List<ReaderMarkupColor> palette;
  final int currentPage;
  final int pageCount;

  /// The chapter the reader is in, or null when the book has no usable
  /// outline — books compiled before bookmarks were emitted have none.
  final String? chapterTitle;
  final bool bookmarked;
  final VoidCallback onContents;
  final VoidCallback? onToggleBookmark;
  final VoidCallback onListen;

  /// Height of the bar, excluding safe-area padding.
  ///
  /// Fixed on purpose, and asserted by the tests. Anything unconstrained in a
  /// `Scaffold.bottomNavigationBar` can take the whole bounded height it is
  /// offered and leave the body with none — which reads as "the book will not
  /// render".
  static const barHeight = 62.0;

  /// The progress line drawn along the bar's top edge.
  static const progressLineHeight = 2.0;

  /// Everything the bar covers, safe-area padding included.
  ///
  /// The page is laid out with exactly this much blank space after its last
  /// line, so the end of the book can be pushed clear of the bar lying over it.
  static double heightFor(BuildContext context) =>
      progressLineHeight + barHeight + MediaQuery.paddingOf(context).bottom;

  @override
  Widget build(BuildContext context) {
    final bar = _bar(context);
    if (!annotations.isMarkingUp) {
      return bar;
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // The readout and its buttons stay reachable while marking up, but the
        // safe-area padding at the bottom of the screen belongs to the tray
        // below it now.
        MediaQuery.removePadding(
          context: context,
          removeBottom: true,
          child: bar,
        ),
        _toolbar(),
      ],
    );
  }

  Widget _bar(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.outlineVariant)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _progressLine(colors),
          SafeArea(
            top: false,
            child: SizedBox(
              height: barHeight,
              child: Row(
                children: [
                  IconButton(
                    tooltip: 'Contents',
                    onPressed: onContents,
                    icon: const Icon(Icons.list_alt_outlined),
                  ),
                  Expanded(child: _readout(context)),
                  IconButton(
                    tooltip: bookmarked ? 'Remove bookmark' : 'Bookmark',
                    onPressed: onToggleBookmark,
                    isSelected: bookmarked,
                    icon: Icon(
                      bookmarked ? Icons.bookmark : Icons.bookmark_outline,
                    ),
                  ),
                  IconButton(
                    tooltip: 'Listen instead',
                    onPressed: onListen,
                    icon: const Icon(Icons.headphones_outlined),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// How far through the book, drawn along the top edge of the bar.
  Widget _progressLine(ColorScheme colors) {
    return SizedBox(
      height: progressLineHeight,
      child: LinearProgressIndicator(
        value: pageCount < 1 ? 0 : (currentPage / pageCount).clamp(0.0, 1.0),
        minHeight: progressLineHeight,
        backgroundColor: Colors.transparent,
        valueColor: AlwaysStoppedAnimation(colors.primary),
      ),
    );
  }

  /// Where the reader is, in the two units that mean something: the chapter
  /// they are in and how far through the book that is.
  Widget _readout(BuildContext context) {
    // Before the viewer reports its page count there is no position to state,
    // and inventing "page 0 of 0" is worse than the buttons standing alone.
    if (pageCount < 1) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    final page = currentPage.clamp(1, pageCount);
    final percent = ((page / pageCount) * 100).round();
    return Column(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (chapterTitle != null)
          Text(
            chapterTitle!,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: theme.textTheme.labelMedium,
          ),
        Text(
          'Page $page of $pageCount · $percent%',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  Widget _toolbar() {
    return ReaderMarkupToolbar(
      tool: annotations.tool,
      settings: annotations.settings,
      palette: palette,
      canUndo: annotations.canUndo,
      pendingMoveLabel: annotations.pendingMoveId == null
          ? null
          : 'Tap the page where it should go.',
      onToolChanged: annotations.setTool,
      onColorChanged: annotations.setActiveColor,
      onWidthChanged: (width) => annotations.updateSettings(
        annotations.settings.copyWith(inkWidth: width),
      ),
      onUndo: annotations.undo,
      onDone: annotations.closeMarkup,
    );
  }
}
