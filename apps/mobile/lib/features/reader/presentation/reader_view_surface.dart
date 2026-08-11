part of 'reader_view.dart';

/// The reader's visual composition, kept apart from document and gesture state.
extension _ReaderViewSurface on _ReaderViewState {
  Widget _buildReaderSurface(BuildContext context) {
    final loader = widget.loader;
    final document = loader.document;

    if (document == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Reading')),
        body: Center(child: _loadingBody(loader)),
      );
    }

    final searcher = _searcher;
    final hideChrome = _immersive || _searching;
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surfaceContainerLowest,
      // A live selection takes the top bar over, the way a contextual action
      // bar does anywhere else — including in full screen, because someone who
      // has just selected text has asked for tools.
      appBar: _selection != null
          ? ReaderMarkupBar(
              palette: _markupPalette,
              defaultColorIndex: _annotations.settings.markupColorIndex,
              markupEnabled: _canCreateMarkup,
              onMarkup: _markSelection,
              onNote: () => unawaited(_noteOnSelection()),
              onAction: (action) => unawaited(_runAction(action)),
              onDismiss: _dismissSelection,
            )
          : hideChrome
          ? null
          : ReaderAppBar(
              title: _title,
              bookmarked: _state.hasBookmarkOn(_state.lastPage),
              immersive: _immersive,
              markupCount: _annotations.count,
              markingUp: _annotations.isMarkingUp,
              bookmarkingEnabled: _canToggleBookmark,
              bookActionsEnabled: _canUseCurrentBook,
              onSearch: searcher == null ? null : () => _setSearching(true),
              onToggleMarkup: _canCreateMarkup
                  ? _annotations.toggleMarkup
                  : null,
              onMenuAction: _onMenuAction,
            ),
      floatingActionButton: _immersive
          ? FloatingActionButton.small(
              tooltip: 'Exit full screen',
              // Immersive chrome stays circular primary; the shared FAB theme
              // is for ordinary app surfaces, not the reader's exit control.
              backgroundColor: Theme.of(context).colorScheme.primary,
              foregroundColor: Theme.of(context).colorScheme.onPrimary,
              shape: const CircleBorder(),
              onPressed: () => _setImmersive(false),
              child: const Icon(Icons.fullscreen_exit),
            )
          : null,
      body: Column(
        children: [
          if (_searching && searcher != null)
            ReaderSearchBar(
              searcher: searcher,
              onClose: () => _setSearching(false),
            ),
          ReaderUpdateBanner(
            status: _updateStatus,
            onReload: () => unawaited(_reload()),
            onDismiss: _dismissUpdate,
          ),
          Expanded(
            child: Stack(
              children: [
                ref.watch(readerViewerBuilderProvider)(
                  context,
                  document.path,
                  _controller,
                  _viewerParams(_annotations.viewerMode),
                  _state.lastPage,
                ),
                ReaderDimOverlay(level: _annotations.settings.dimLevel),
                ReaderScrollHandle(
                  controller: _controller,
                  chapterFor: _chapterFor,
                  // Panning is off while drawing, so the handle is then the
                  // only way to reach another page and must not fade away.
                  alwaysVisible: _annotations.isMarkingUp,
                ),
                if (_menuSelection != null && _menuAnchor != null)
                  ReaderSelectionOverlay(
                    anchor: _menuAnchor!,
                    visible: _selection != null,
                    child: ReaderSelectionMenu(
                      selection: _menuSelection!,
                      editingEnabled: _editingEnabled,
                      sourceCurrent: _canUseCurrentBook,
                      onAction: (action) => unawaited(_runAction(action)),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: hideChrome ? null : _bottomBar(),
    );
  }

  Widget _bottomBar() {
    return ReaderBottomChrome(
      annotations: _annotations,
      palette: _markupPalette,
      currentPage: _state.lastPage,
      pageCount: _pageCount,
      chapterTitle: _chapterFor(_state.lastPage),
      bookmarked: _state.hasBookmarkOn(_state.lastPage),
      onContents: () => _onMenuAction(ReaderMenuAction.contents),
      onToggleBookmark: _canToggleBookmark
          ? () => _onMenuAction(ReaderMenuAction.toggleBookmark)
          : null,
      onListen: () => _onMenuAction(ReaderMenuAction.listen),
    );
  }

  String? _chapterFor(int page) => outlineEntryForPage(_outline, page)?.title;

  Widget _loadingBody(ReaderDocumentLoader loader) {
    return ReaderDownloadState(
      loader: loader,
      onRetry: () => unawaited(_retryDownload()),
      onOpenPaywall: widget.onOpenPaywall,
    );
  }

  /// Fetches the book again, against what the server is offering now.
  ///
  /// The descriptor this screen holds is a snapshot, and the failures that lead
  /// here are the ones that outdate it: `EXPORT_NOT_READY` means a compile is
  /// landing, so by the time the reader taps Try again the file behind that URL
  /// is routinely a *newer* revision than the one that failed. Fetching it
  /// under the old descriptor files the new book's bytes as the old revision —
  /// the cache then hands them back as current, no update banner ever appears,
  /// and markup is re-anchored against a compile it was never placed against.
  /// So the descriptor is re-read first, and the bytes are stored under
  /// whichever one actually asked for them.
  Future<void> _retryDownload() {
    return widget.loader.load(widget.export, refresh: widget.onRefreshExport);
  }
}
