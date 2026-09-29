import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
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
    this.hasCoverPage = false,
    this.pageCount = 0,
    this.chapterFor,
  });

  final BuildContext context;
  final ReaderState state;
  final List<ReaderOutlineEntry> outline;

  /// The exact revision of the PDF on screen. Null disables creating a new
  /// bookmark, while still allowing an existing one to be removed.
  final int? currentRevision;
  final void Function(ReaderState state) onStateChanged;
  final void Function(int page) onGoToPage;

  /// Whether PDF sheet 1 is an unnumbered cover. Bookmark labels and Contents
  /// trailing numbers skip it; [onGoToPage] still receives a physical sheet.
  final bool hasCoverPage;

  /// How many physical pages the open file has, or 0 before the viewer has
  /// said. Lets the Contents sheet offer a jump to a page number.
  final int pageCount;

  /// The chapter a physical page falls in, for naming a bookmark's place.
  final String? Function(int page)? chapterFor;

  void showContents() {
    showAppBottomSheet<void>(
      context,
      builder: (sheetContext) => ReaderOutlineSheet(
        entries: outline,
        currentPage: state.lastPage,
        hasCoverPage: hasCoverPage,
        pageCount: pageCount,
        onSelect: (page) {
          Navigator.of(sheetContext).pop();
          onGoToPage(page);
        },
      ),
    );
  }

  /// The saved-places sheet, which edits the list in place.
  ///
  /// [state] is a snapshot from the moment the sheet opened, and the sheet stays
  /// open across several changes — so the list is held here and every change
  /// reports the whole of it, rather than each one being worked out from a
  /// snapshot the one before it has already made stale.
  void showBookmarks() {
    var bookmarks = [...state.bookmarks];
    void commit() {
      onStateChanged(
        state.copyWith(bookmarks: List<ReaderBookmark>.unmodifiable(bookmarks)),
      );
    }

    showAppBottomSheet<void>(
      context,
      builder: (sheetContext) => ReaderBookmarksSheet(
        state: state,
        currentRevision: currentRevision,
        hasCoverPage: hasCoverPage,
        chapterFor: chapterFor,
        onSelect: (bookmark) {
          Navigator.of(sheetContext).pop();
          onGoToPage(bookmark.page);
        },
        onRemove: (bookmark) {
          bookmarks = bookmarks
              .where((entry) => entry.page != bookmark.page)
              .toList();
          AppHaptics.tap();
          commit();
        },
        onRestore: (bookmark) {
          bookmarks = [...bookmarks, bookmark]
            ..sort((a, b) => a.page.compareTo(b.page));
          commit();
        },
        // Only a PDF whose revision is known can be bookmarked — the same rule
        // the bar's own button follows.
        onAddCurrent: currentRevision == null
            ? null
            : () {
                final added = ReaderBookmark(
                  page: state.lastPage,
                  createdAt: DateTime.now(),
                  revision: currentRevision,
                );
                bookmarks = [
                  ...bookmarks.where((entry) => entry.page != added.page),
                  added,
                ]..sort((a, b) => a.page.compareTo(b.page));
                AppHaptics.success();
                commit();
                return added;
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
