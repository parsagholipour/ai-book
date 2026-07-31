import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';

/// In-book search, running entirely on the device against the open PDF.
///
/// The book text never leaves the phone for this, and it works offline once the
/// export is cached.
class ReaderSearchBar extends StatefulWidget {
  const ReaderSearchBar({
    required this.searcher,
    required this.onClose,
    super.key,
  });

  final PdfTextSearcher searcher;
  final VoidCallback onClose;

  @override
  State<ReaderSearchBar> createState() => _ReaderSearchBarState();
}

class _ReaderSearchBarState extends State<ReaderSearchBar> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    widget.searcher.addListener(_onSearcherChanged);
  }

  @override
  void dispose() {
    widget.searcher.removeListener(_onSearcherChanged);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onSearcherChanged() {
    if (mounted) setState(() {});
  }

  void _close() {
    widget.searcher.resetTextSearch();
    widget.onClose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final searcher = widget.searcher;
    final matches = searcher.matches.length;
    final current = searcher.currentIndex;

    // Search is a transient reader state, not a new route. Register it with
    // the current route so the platform back action closes search before it
    // is allowed to pop the book itself.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _close();
      },
      child: Material(
        color: theme.colorScheme.surfaceContainerHigh,
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
            child: Row(
              children: [
                IconButton(
                  icon: const Icon(Icons.arrow_back),
                  tooltip: 'Close search',
                  onPressed: _close,
                ),
                Expanded(
                  child: TextField(
                    controller: _controller,
                    focusNode: _focusNode,
                    autofocus: true,
                    textInputAction: TextInputAction.search,
                    decoration: const InputDecoration(
                      hintText: 'Search this book',
                      border: InputBorder.none,
                    ),
                    onChanged: (value) {
                      if (value.trim().isEmpty) {
                        searcher.resetTextSearch();
                      } else {
                        searcher.startTextSearch(value);
                      }
                    },
                    onSubmitted: (_) => searcher.goToNextMatch(),
                  ),
                ),
                if (searcher.isSearching)
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 8),
                    child: SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                else if (_controller.text.trim().isNotEmpty)
                  Text(
                    matches == 0
                        ? 'No matches'
                        : '${(current ?? 0) + 1}/$matches',
                    style: theme.textTheme.labelMedium,
                  ),
                IconButton(
                  icon: const Icon(Icons.keyboard_arrow_up),
                  tooltip: 'Previous match',
                  onPressed: matches == 0 ? null : searcher.goToPrevMatch,
                ),
                IconButton(
                  icon: const Icon(Icons.keyboard_arrow_down),
                  tooltip: 'Next match',
                  onPressed: matches == 0 ? null : searcher.goToNextMatch,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
