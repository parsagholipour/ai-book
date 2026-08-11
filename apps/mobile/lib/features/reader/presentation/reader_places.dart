import 'package:flutter/material.dart';

import '../../../shared/ui/haptics.dart';
import '../domain/reader_models.dart';
import 'reader_bookmarks_sheet.dart';
import 'reader_outline.dart';

/// The places in a book the reader can get to: its contents and their own
/// saved spots.
///
/// Split from the reading surface for the same reason as
/// [ReaderMarkupActions]: `ReaderView` is about rendering a PDF and holding the
/// viewer's parameters still, while these open sheets and wait. Built fresh at
/// each call site from the view's current state, and reporting changes back
/// through [onStateChanged] rather than holding any of its own.
class ReaderPlaces {
  const ReaderPlaces({
    required this.context,
    required this.state,
    required this.outline,
    required this.currentRevision,
    required this.onStateChanged,
    required this.onGoToPage,
  });

  final BuildContext context;
  final ReaderState state;
  final List<ReaderOutlineEntry> outline;

  /// The exact revision of the PDF on screen. Null disables creating a new
  /// bookmark, while still allowing an existing one to be removed.
  final int? currentRevision;
  final void Function(ReaderState state) onStateChanged;
  final void Function(int page) onGoToPage;

  void showContents() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => ReaderOutlineSheet(
        entries: outline,
        currentPage: state.lastPage,
        onSelect: (page) {
          Navigator.of(sheetContext).pop();
          onGoToPage(page);
        },
      ),
    );
  }

  void showBookmarks() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => ReaderBookmarksSheet(
        state: state,
        currentRevision: currentRevision,
        onSelect: (bookmark) {
          Navigator.of(sheetContext).pop();
          onGoToPage(bookmark.page);
        },
        onRemove: (bookmark) {
          onStateChanged(
            state.copyWith(
              bookmarks: state.bookmarks
                  .where((entry) => entry.page != bookmark.page)
                  .toList(growable: false),
            ),
          );
          Navigator.of(sheetContext).pop();
        },
      ),
    );
  }

  /// Saves or clears the reader's place on [page].
  void toggleBookmark(int page) {
    final bookmarks = [...state.bookmarks];
    final existing = bookmarks.indexWhere((bookmark) => bookmark.page == page);
    if (existing >= 0) {
      bookmarks.removeAt(existing);
      AppHaptics.tap();
    } else {
      final revision = currentRevision;
      if (revision == null) return;
      bookmarks.add(
        ReaderBookmark(
          page: page,
          label: 'Page $page',
          createdAt: DateTime.now(),
          revision: revision,
        ),
      );
      bookmarks.sort((a, b) => a.page.compareTo(b.page));
      AppHaptics.success();
    }
    onStateChanged(state.copyWith(bookmarks: bookmarks));
  }
}
