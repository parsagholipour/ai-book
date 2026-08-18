import 'package:flutter/material.dart';

import '../domain/reader_models.dart';

/// The saved-places sheet.
///
/// A bookmark records a physical PDF page, so a recompile that repaginates the
/// book can move it. Rather than dropping bookmarks on every edit, one made
/// against an older revision is kept and labelled as approximate.
class ReaderBookmarksSheet extends StatelessWidget {
  const ReaderBookmarksSheet({
    required this.state,
    required this.currentRevision,
    required this.onSelect,
    required this.onRemove,
    this.hasCoverPage = false,
    super.key,
  });

  final ReaderState state;
  final int? currentRevision;
  final void Function(ReaderBookmark bookmark) onSelect;
  final void Function(ReaderBookmark bookmark) onRemove;

  /// Whether PDF sheet 1 is an unnumbered cover. Labels skip it; taps still
  /// go to the physical sheet the bookmark recorded.
  final bool hasCoverPage;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
            child: Text('Bookmarks', style: theme.textTheme.titleMedium),
          ),
          if (state.bookmarks.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
              child: Text(
                'Tap the bookmark icon while reading to save your place.',
                style: theme.textTheme.bodyMedium,
              ),
            )
          else
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: state.bookmarks.length,
                itemBuilder: (context, index) {
                  final bookmark = state.bookmarks[index];
                  final approximate = bookmark.isApproximateFor(
                    currentRevision,
                  );
                  return ListTile(
                    leading: const Icon(Icons.bookmark_outline),
                    title: Text(
                      bookmark.displayedLabel(hasCoverPage: hasCoverPage),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: approximate
                        ? const Text(
                            'Saved before the last edit — may have moved',
                          )
                        : null,
                    trailing: IconButton(
                      icon: const Icon(Icons.close),
                      tooltip: 'Remove bookmark',
                      onPressed: () => onRemove(bookmark),
                    ),
                    onTap: () => onSelect(bookmark),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
