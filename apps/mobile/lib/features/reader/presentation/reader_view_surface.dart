part of 'reader_view.dart';

/// The reader's visual composition, kept apart from document and gesture state.
extension _ReaderViewSurface on _ReaderViewState {
  Widget _buildReaderSurface(BuildContext context) {
    final loader = widget.loader;
    final document = loader.document;

    if (document == null) {
      // The shared scaffold rather than a second copy of it: reading is always
      // leavable, including from the states that are not reading yet, and a
      // hand-rolled `AppBar` here is how that rule ended up applying to one of
      // the two waiting screens only.
      return ReaderScaffold(
        title: 'Reading',
        projectId: widget.projectId,
        body: _loadingBody(loader),
      );
    }

    // The bars lie over the page rather than beside it, so the viewer's box is
    // one size for the whole session. pdfrx answers a view-size change by
    // keeping the same *document* point at the box's origin, so a box that
    // grows or shrinks moves the line being read; here the bars fade and slide
    // instead, and the page underneath does not move.
    //
    // The phone's status bar is not part of that. It stays where it is, opaque,
    // with nothing of ours behind it — a book scrolling under the clock reads
    // as a rendering fault, and the strip is not ours to take.
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: colors.surfaceContainerLowest,
      body: Column(
        children: [
          _statusBarBand(context),
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(child: _page(context, document)),
                Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: _topChrome(context),
                ),
                Positioned(
                  bottom: 0,
                  left: 0,
                  right: 0,
                  child: _bottomChrome(),
                ),
                Positioned(
                  bottom: 0,
                  left: 0,
                  right: 0,
                  child: _pageBadge(context),
                ),
                if (_coachShowing)
                  PositionedDirectional(
                    start: AppSpacing.md,
                    end: AppSpacing.md,
                    bottom:
                        ReaderBottomChrome.heightFor(context) + AppSpacing.sm,
                    child: ReaderCoachCard(onDismiss: _dismissCoach),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The strip the phone draws its clock and battery in.
  ///
  /// Painted rather than passed through, so the book never appears behind the
  /// status icons. Its height is a fixed property of the device, so reserving
  /// it costs the viewer nothing: the box below is still one size for the whole
  /// session, full screen included.
  Widget _statusBarBand(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      // The clock and the battery are drawn by the system on top of this band,
      // so they have to be told what they are standing on. `surfaceContainerLowest`
      // is white in the light theme, which is where the icons need to be dark.
      value: colors.brightness == Brightness.light
          ? SystemUiOverlayStyle.dark.copyWith(
              statusBarColor: Colors.transparent,
            )
          : SystemUiOverlayStyle.light.copyWith(
              statusBarColor: Colors.transparent,
            ),
      child: Container(
        height: MediaQuery.paddingOf(context).top,
        color: colors.surfaceContainerLowest,
      ),
    );
  }

  ReaderMarkupBar _markupBar() {
    return ReaderMarkupBar(
      palette: _markupPalette,
      defaultColorIndex: _annotations.settings.markupColorIndex,
      markupEnabled: _canCreateMarkup,
      onMarkup: _markSelection,
      onNote: () => unawaited(_noteOnSelection()),
      onAction: (action) => unawaited(_runAction(action)),
      onDismiss: _dismissSelection,
    );
  }

  ReaderAppBar _appBar(PdfTextSearcher? searcher) {
    return ReaderAppBar(
      title: _title,
      projectId: widget.projectId,
      bookmarked: _state.hasBookmarkOn(_state.lastPage),
      immersive: _immersive,
      markupCount: _annotations.count,
      markingUp: _annotations.isMarkingUp,
      bookmarkingEnabled: _canToggleBookmark,
      bookActionsEnabled: _canUseCurrentBook,
      onSearch: searcher == null ? null : () => _setSearching(true),
      onToggleMarkup: _canCreateMarkup ? _annotations.toggleMarkup : null,
      onMenuAction: _onMenuAction,
    );
  }

  /// The book, and everything drawn onto it rather than around it.
  Widget _page(BuildContext context, CachedExport document) {
    return Stack(
      children: [
        ref.watch(readerViewerBuilderProvider)(
          context,
          readerDocumentRef(document),
          _controller,
          _viewerParams(_annotations.viewerMode),
          _requestedSheet ?? _state.lastPage,
        ),
        if (_backgroundTapEnabled)
          // Covers the gap between sheets and the blank paper at either end —
          // the per-page overlay never reaches those, and a viewer overlay
          // would vanish under the test stub. `acceptTap` leaves presses that
          // landed on a page to that page's own overlay.
          Positioned.fill(
            child: ReaderTapLayer(
              key: const Key('reader-background-tap'),
              onTap: (_) => _onBackgroundTap(),
              acceptTap: (global) => !_globalPointIsOnPage(global),
            ),
          ),
        ReaderDimOverlay(level: _annotations.settings.dimLevel),
        ReaderScrollHandle(
          controller: _controller,
          chapterFor: _chapterFor,
          hasCoverPage: _hasCoverPage,
          // Panning is off while drawing, so the handle is then the only way to
          // reach another page and must not fade away.
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
              offline: widget.offline,
              onAction: (action) => unawaited(_runAction(action)),
            ),
          ),
      ],
    );
  }

  /// The top bar and, under it, the notice about the book changing.
  ///
  /// The status-bar inset is removed for the whole group: the band above has
  /// already reserved that strip, and every piece in here — the app bar's
  /// `primary` padding, the search bar's and the banner's `SafeArea` — would
  /// otherwise add it a second time.
  ///
  /// The bar and the banner are separate layers on purpose. The bar goes away
  /// with the rest of the controls; the banner does not, because a reader with
  /// the controls put away is as much in need of "your edits are in" as anyone.
  /// The bar therefore collapses out of the group as it leaves, so the banner
  /// rises to the top of the page instead of hanging under a gap.
  Widget _topChrome(BuildContext context) {
    final searcher = _searcher;
    final selecting = _selection != null;
    // A live selection takes the bar over, the way a contextual action bar does
    // anywhere else — including in full screen, because someone who has just
    // selected text has asked for tools.
    final showTopBar = selecting || !(_immersive || _searching);
    final searchBar = _searching && searcher != null;
    return MediaQuery.removePadding(
      context: context,
      removeTop: true,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _ChromeLayer(
            visible: showTopBar || searchBar,
            fromTop: true,
            collapse: true,
            child: searchBar
                ? ReaderSearchBar(
                    searcher: searcher,
                    onClose: () => _setSearching(false),
                  )
                : selecting
                ? _markupBar()
                : _appBar(searcher),
          ),
          ReaderUpdateBanner(
            status: _updateStatus,
            onReload: () => unawaited(_reload()),
            onDismiss: _dismissUpdate,
          ),
        ],
      ),
    );
  }

  Widget _bottomChrome() {
    return _ChromeLayer(
      visible: !(_immersive || _searching),
      fromTop: false,
      child: _bottomBar(),
    );
  }

  /// Where the reader is, for as long as the bar that says so is away.
  Widget _pageBadge(BuildContext context) {
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: AppSpacing.xs),
      child: Center(
        child: ReaderPageBadge(
          visible: _immersive || _searching,
          currentPage: _state.lastPage,
          pageCount: _pageCount,
          hasCoverPage: _hasCoverPage,
          chapterTitle: _chapterFor(_state.lastPage),
          onDarkPage: _onDarkPage,
          onTap: () {
            if (_searching) return;
            _setImmersive(false);
          },
        ),
      ),
    );
  }

  Widget _bottomBar() {
    return ReaderBottomChrome(
      annotations: _annotations,
      palette: _markupPalette,
      currentPage: _state.lastPage,
      pageCount: _pageCount,
      hasCoverPage: _hasCoverPage,
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
      title: _title,
      onRetry: () => unawaited(_retryDownload()),
    );
  }

  /// Drawn by the viewer in place of a document it could not open.
  Widget _buildOpenError(
    BuildContext context,
    Object error,
    StackTrace? stackTrace,
    PdfDocumentRef documentRef,
  ) {
    return ReaderOpenErrorState(
      onDownloadAgain: () => unawaited(_downloadAgain()),
    );
  }

  /// Replaces a file the viewer could not open with a fresh download.
  ///
  /// The cache entry goes first — otherwise the "download" is a cache hit that
  /// hands the same bytes back — and the descriptor is re-read for the same
  /// reason [_retryDownload] re-reads it. The fresh file has a new identity
  /// (see [readerDocumentRef]), so the viewer opens it rather than its memory
  /// of the failure.
  Future<void> _downloadAgain() {
    return widget.loader.redownload(
      widget.export,
      refresh: widget.onRefreshExport,
      pageNumbering: widget.status.pdfPageNumbering,
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
    return widget.loader.load(
      widget.export,
      refresh: widget.onRefreshExport,
      pageNumbering: widget.status.pdfPageNumbering,
    );
  }
}

/// A bar that gets out of the way without taking the page with it.
///
/// Slides off its own edge and fades, rather than being added to and removed
/// from the tree: the reader is looking at a line of type, and anything that
/// changes the size of the box the book is laid out in moves that line. It
/// keeps its space in the layer either way — nothing else is laid out against
/// it, because the page is a sibling filling the whole screen.
///
/// A layer with something stacked *under* it, the top bar, sets [collapse]: its
/// height then closes up as it leaves, so what is under it moves up to the edge
/// rather than being left hanging where the bar was. That is layout inside the
/// overlay only — the page beneath is a sibling and never feels it.
class _ChromeLayer extends StatelessWidget {
  const _ChromeLayer({
    required this.visible,
    required this.fromTop,
    required this.child,
    this.collapse = false,
  });

  final bool visible;

  /// Which edge it leaves by. The top bar goes up, the bottom bar goes down.
  final bool fromTop;
  final bool collapse;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final reduced = AppMotion.reducedMotion(context);
    final duration = reduced ? Duration.zero : AppMotion.medium;
    final curve = visible ? AppMotion.enter : AppMotion.exit;
    Widget layer = AnimatedSlide(
      offset: visible ? Offset.zero : Offset(0, fromTop ? -1 : 1),
      duration: duration,
      curve: curve,
      child: AnimatedOpacity(
        opacity: visible ? 1 : 0,
        duration: duration,
        curve: curve,
        child: child,
      ),
    );
    if (collapse) {
      layer = ClipRect(
        child: AnimatedAlign(
          alignment: Alignment.topCenter,
          heightFactor: visible ? 1 : 0,
          duration: duration,
          curve: curve,
          child: layer,
        ),
      );
    }
    return IgnorePointer(
      ignoring: !visible,
      // A bar that has slid off the top is still in the tree, so it has to be
      // taken out of the semantics tree by hand or a screen reader would offer
      // controls that are not on screen.
      child: ExcludeSemantics(excluding: !visible, child: layer),
    );
  }
}
