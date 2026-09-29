import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';

/// In-book search, running entirely on the device against the open PDF.
///
/// The book text never leaves the phone for this, and it works offline once the
/// export is cached.
///
/// The bar has four things to say and says each in its own line under the
/// field: what search is, while nothing has been typed; that it is looking, and
/// how far along it is; how many hits there are and which one the page is on;
/// and, when there are none, what was looked for. The searcher itself only
/// reports two of those — "not searching" and "no matches" look identical
/// through it for the half second it waits after a keystroke before it starts,
/// which is how a bar that trusted it flashed "No matches" on every letter.
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

  void _onChanged(String value) {
    if (value.trim().isEmpty) {
      widget.searcher.resetTextSearch();
    } else {
      widget.searcher.startTextSearch(value);
    }
    setState(() {});
  }

  void _clear() {
    _controller.clear();
    widget.searcher.resetTextSearch();
    _focusNode.requestFocus();
    setState(() {});
  }

  /// The next hit, and past the last one the first again.
  ///
  /// The searcher stops at the ends, which reads as a dead button on the last
  /// hit. It is only wrapped once the search has finished: while it is still
  /// counting, "the last one so far" is not the last one.
  Future<void> _next() async {
    final searcher = widget.searcher;
    final count = searcher.matches.length;
    if (count == 0) return;
    final current = searcher.currentIndex;
    if (current != null && current + 1 >= count && !searcher.isSearching) {
      await searcher.goToMatchOfIndex(0);
      return;
    }
    await searcher.goToNextMatch();
  }

  Future<void> _previous() async {
    final searcher = widget.searcher;
    final count = searcher.matches.length;
    if (count == 0) return;
    final current = searcher.currentIndex;
    if (current != null && current <= 0 && !searcher.isSearching) {
      await searcher.goToMatchOfIndex(count - 1);
      return;
    }
    await searcher.goToPrevMatch();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final searcher = widget.searcher;
    final matches = searcher.matches.length;
    final query = _controller.text;
    final hasQuery = query.trim().isNotEmpty;
    // The searcher reports the pattern it is actually running. Until that is
    // what is in the field it is still inside its debounce, and whatever it
    // reports — matches from the last letter, or none — is about the wrong
    // question.
    final pending = hasQuery && searcher.pattern != query;
    final searching = hasQuery && (searcher.isSearching || pending);

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
        elevation: 1,
        child: SafeArea(
          bottom: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(
                  AppSpacing.xxs,
                  AppSpacing.xs,
                  AppSpacing.xxs,
                  0,
                ),
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
                        decoration: InputDecoration(
                          hintText: 'Search this book',
                          border: InputBorder.none,
                          suffixIcon: hasQuery
                              ? IconButton(
                                  icon: const Icon(Icons.close, size: 20),
                                  tooltip: 'Clear search',
                                  onPressed: _clear,
                                )
                              : null,
                        ),
                        onChanged: _onChanged,
                        onSubmitted: (_) => _next(),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.keyboard_arrow_up),
                      tooltip: 'Previous match',
                      onPressed: matches == 0 ? null : _previous,
                    ),
                    IconButton(
                      icon: const Icon(Icons.keyboard_arrow_down),
                      tooltip: 'Next match',
                      onPressed: matches == 0 ? null : _next,
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(
                  AppSpacing.md,
                  AppSpacing.xxs,
                  AppSpacing.md,
                  AppSpacing.xs,
                ),
                child: _status(
                  context,
                  hasQuery: hasQuery,
                  query: query.trim(),
                  searching: searching,
                  matches: matches,
                ),
              ),
              _progress(context, searching: searching),
            ],
          ),
        ),
      ),
    );
  }

  /// One line under the field, and it is always the answer to "what is search
  /// doing right now?".
  Widget _status(
    BuildContext context, {
    required bool hasQuery,
    required String query,
    required bool searching,
    required int matches,
  }) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.labelMedium?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final current = widget.searcher.currentIndex;

    final Widget line;
    if (!hasQuery) {
      line = Text(
        'Search runs on your phone, so it works offline.',
        key: const ValueKey('search-idle'),
        style: muted,
      );
    } else if (searching) {
      line = Text(
        matches == 0 ? 'Searching…' : 'Searching… ${_hits(matches)} so far',
        key: const ValueKey('search-working'),
        style: muted,
      );
    } else if (matches == 0) {
      line = Text(
        'No matches for “$query”. Try a shorter word or check the spelling.',
        key: const ValueKey('search-none'),
        style: muted,
      );
    } else {
      final position = '${(current ?? 0) + 1} of $matches';
      line = Semantics(
        label: 'Match $position',
        excludeSemantics: true,
        child: Text.rich(
          key: const ValueKey('search-found'),
          TextSpan(
            style: muted,
            children: [
              TextSpan(
                text: position,
                style: TextStyle(
                  color: theme.colorScheme.onSurface,
                  fontWeight: FontWeight.w800,
                ),
              ),
              TextSpan(text: matches == 1 ? ' match' : ' matches'),
            ],
          ),
        ),
      );
    }

    return Semantics(
      liveRegion: true,
      child: AnimatedSwitcher(
        duration: AppMotion.reducedMotion(context)
            ? Duration.zero
            : AppMotion.fast,
        layoutBuilder: (current, previous) => Stack(
          alignment: AlignmentDirectional.centerStart,
          children: [...previous, ?current],
        ),
        child: line,
      ),
    );
  }

  static String _hits(int count) => count == 1 ? '1 match' : '$count matches';

  /// A hairline along the bottom of the bar while the book is being read.
  ///
  /// Determinate once the searcher knows which page it is on, sweeping until
  /// then. It is there only while a search is actually running, so a finished
  /// one leaves nothing moving.
  Widget _progress(BuildContext context, {required bool searching}) {
    if (!searching) return const SizedBox(height: 2);
    return SizedBox(
      height: 2,
      child: LinearProgressIndicator(
        value: widget.searcher.searchProgress,
        minHeight: 2,
        backgroundColor: Colors.transparent,
      ),
    );
  }
}
