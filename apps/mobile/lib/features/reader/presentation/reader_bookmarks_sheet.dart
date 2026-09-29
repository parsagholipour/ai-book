import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../domain/reader_models.dart';
import 'reader_sheet_parts.dart';

/// The saved-places sheet.
///
/// A bookmark records a physical PDF page, so a recompile that repaginates the
/// book can move it. Rather than dropping bookmarks on every edit, one made
/// against an older revision is kept and labelled as approximate.
///
/// It edits in place. Removing a bookmark used to close the sheet, which is the
/// wrong shape for a list someone is tidying: the sheet now keeps its own copy
/// of the list, reports each change as it is made, and offers the way back for
/// the last removal without leaving. Saving the page being read is a button on
/// the sheet as well as the one on the bar, because this is where a reader
/// already is when they are thinking about their bookmarks.
class ReaderBookmarksSheet extends StatefulWidget {
  const ReaderBookmarksSheet({
    required this.state,
    required this.currentRevision,
    required this.onSelect,
    required this.onRemove,
    this.onRestore,
    this.onAddCurrent,
    this.chapterFor,
    this.hasCoverPage = false,
    super.key,
  });

  final ReaderState state;
  final int? currentRevision;
  final void Function(ReaderBookmark bookmark) onSelect;

  /// Called as soon as a bookmark is removed; the sheet stays open.
  final void Function(ReaderBookmark bookmark) onRemove;

  /// Puts back a bookmark the sheet just removed. Without it the sheet offers no
  /// undo.
  final void Function(ReaderBookmark bookmark)? onRestore;

  /// Saves the page being read and answers with what it saved, or null when it
  /// could not. Null disables the button — a PDF whose revision is unknown
  /// cannot have bookmarks made against it.
  final ReaderBookmark? Function()? onAddCurrent;

  /// The chapter a physical page falls in, when the book has an outline.
  final String? Function(int page)? chapterFor;

  /// Whether PDF sheet 1 is an unnumbered cover. Labels skip it; taps still
  /// go to the physical sheet the bookmark recorded.
  final bool hasCoverPage;

  @override
  State<ReaderBookmarksSheet> createState() => _ReaderBookmarksSheetState();
}

class _ReaderBookmarksSheetState extends State<ReaderBookmarksSheet> {
  late List<ReaderBookmark> _bookmarks = [...widget.state.bookmarks];

  /// The last one removed, while the way back is on offer.
  ReaderBookmark? _removed;

  int get _readingPage => widget.state.lastPage;

  bool get _canAddCurrent =>
      widget.onAddCurrent != null &&
      !_bookmarks.any((bookmark) => bookmark.page == _readingPage);

  void _remove(ReaderBookmark bookmark) {
    setState(() {
      _bookmarks = _bookmarks.where((e) => e.page != bookmark.page).toList();
      _removed = bookmark;
    });
    widget.onRemove(bookmark);
  }

  void _restore() {
    final bookmark = _removed;
    final restore = widget.onRestore;
    if (bookmark == null || restore == null) return;
    setState(() {
      _bookmarks = [..._bookmarks, bookmark]
        ..sort((a, b) => a.page.compareTo(b.page));
      _removed = null;
    });
    restore(bookmark);
  }

  void _addCurrent() {
    final added = widget.onAddCurrent?.call();
    if (added == null) return;
    setState(() {
      _bookmarks = [..._bookmarks.where((e) => e.page != added.page), added]
        ..sort((a, b) => a.page.compareTo(b.page));
      _removed = null;
    });
  }

  String get _subtitle => switch (_bookmarks.length) {
    0 => 'Nothing saved yet',
    1 => '1 saved place',
    final count => '$count saved places',
  };

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ReaderSheetHeader(title: 'Bookmarks', subtitle: _subtitle),
          if (_removed != null && widget.onRestore != null) _undoRow(context),
          if (_bookmarks.isEmpty)
            AppEmptyState(
              icon: Icons.bookmark_outline,
              title: 'No bookmarks yet',
              message:
                  'Tap the bookmark icon while you read to save your place.',
              actionLabel: _canAddCurrent ? 'Bookmark this page' : null,
              onAction: _canAddCurrent ? _addCurrent : null,
            )
          else ...[
            if (_canAddCurrent) _addRow(context),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                itemCount: _bookmarks.length,
                itemBuilder: (context, index) =>
                    _tile(context, _bookmarks[index]),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _addRow(BuildContext context) {
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.lg - 4,
        0,
        AppSpacing.md,
        AppSpacing.xs,
      ),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: AppButton.outlined(
          leading: const Icon(Icons.bookmark_add_outlined),
          label:
              'Bookmark ${printedPageLabel(_readingPage, hasCoverPage: widget.hasCoverPage).toLowerCase()}',
          onPressed: _addCurrent,
        ),
      ),
    );
  }

  Widget _undoRow(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.xs,
      ),
      child: Semantics(
        liveRegion: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(AppRadii.control),
          ),
          child: Padding(
            padding: const EdgeInsetsDirectional.only(
              start: AppSpacing.md,
              end: AppSpacing.xxs,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Bookmark removed',
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
                TextButton(
                  onPressed: _restore,
                  style: TextButton.styleFrom(
                    minimumSize: const Size(64, AppSizes.minimumTouchTarget),
                  ),
                  child: const Text('Undo'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _tile(BuildContext context, ReaderBookmark bookmark) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final approximate = bookmark.isApproximateFor(widget.currentRevision);
    final chapter = widget.chapterFor?.call(bookmark.page);
    final here = bookmark.page == _readingPage;
    final notes = <Widget>[
      if (chapter != null && chapter.isNotEmpty)
        Text(
          chapter,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodySmall?.copyWith(
            color: colors.onSurfaceVariant,
          ),
        ),
      if (approximate)
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(
                  Icons.history,
                  size: 14,
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(width: AppSpacing.xxs),
              Expanded(
                child: Text(
                  'Saved before the last edit — may have moved',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ),
    ];

    return InkWell(
      onTap: () => widget.onSelect(bookmark),
      child: Padding(
        padding: const EdgeInsetsDirectional.only(
          start: AppSpacing.lg - 4,
          end: AppSpacing.xxs,
          top: AppSpacing.xxs,
          bottom: AppSpacing.xxs,
        ),
        child: Row(
          children: [
            Icon(
              approximate ? Icons.bookmark_outline : Icons.bookmark,
              color: approximate ? colors.onSurfaceVariant : colors.primary,
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  minHeight: AppSizes.minimumTouchTarget,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            bookmark.displayedLabel(
                              hasCoverPage: widget.hasCoverPage,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodyLarge?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        if (here) ...[
                          const SizedBox(width: AppSpacing.xs),
                          Text(
                            'You are here',
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: colors.primary,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ],
                      ],
                    ),
                    ...notes,
                  ],
                ),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Remove bookmark',
              onPressed: () => _remove(bookmark),
            ),
          ],
        ),
      ),
    );
  }
}
