part of 'reader_view.dart';

/// What the page column has to be laid out against: how wide the viewer is,
/// and how much of it each bar covers.
///
/// A value type so it can key the parameter memo — the layout function closes
/// over it, [PdfViewerParams] compares by value, and a closure rebuilt in
/// `build` would be a new object every frame with the viewer relaying out on
/// every `setState`. One instance per distinct geometry, reused until the
/// window or the insets actually move.
typedef _ReaderPageMetrics = ({
  double viewportWidth,
  double topBar,
  double bottomBar,
});

/// How far above the page-fills-the-width scale still counts as not zoomed.
///
/// A hair over 1 rather than an exact comparison: a pinch settles wherever it
/// settles, and a book a rounding error away from home has to read as home or a
/// double tap would answer "reset" with a zoom nobody asked for.
const _zoomedInRatio = 1.01;

/// Adapts the reader's page geometry to pdfrx.
PdfPageLayoutFunction _layoutPagesFor(_ReaderPageMetrics metrics) {
  return (pages, params) {
    final geometry = readerPageGeometry(
      [for (final page in pages) Size(page.width, page.height)],
      viewportWidth: metrics.viewportWidth,
      topBar: metrics.topBar,
      bottomBar: metrics.bottomBar,
    );
    return PdfPageLayout(
      pageLayouts: geometry.rects,
      documentSize: geometry.documentSize,
    );
  };
}

/// How the reader drives pdfrx, and what it puts on the pages.
///
/// Split from the rest of [_ReaderViewState] because it is the one part that is
/// about the *viewer* rather than about the book: the parameter object and its
/// memo, the layers laid over each page, what a tap on one means, and what is
/// painted onto it. Everything here is either a stable tear-off handed to
/// pdfrx or the thing that builds them — see [_viewerParams] for why that
/// matters so much.
extension _ReaderViewViewer on _ReaderViewState {
  /// The viewer's parameters, built once per gesture mode and reused.
  ///
  /// [PdfViewerParams] compares by value, and the viewer treats a change as a
  /// reason to rebuild its layout. Constructing the params — and especially the
  /// paint-callback list and menu builder closures — inside `build` makes every
  /// `setState` look like new params, which with a callback that itself calls
  /// `setState` becomes a relayout loop that never leaves time to render a
  /// page. Every callback here is therefore a stable tear-off, and the objects
  /// are memoized so that a rebuild in the same mode hands back the identical
  /// instance. Switching mode does relayout once, which is the point: that is
  /// when panning and text selection have to change.
  ///
  /// The key is the mode *and the theme*, because the colours below are read
  /// from it. Keyed on the mode alone the map was never cleared, so switching
  /// the phone to dark mode mid-chapter darkened everything except the gutters
  /// around and between the pages — the one part of the reader pdfrx paints.
  PdfViewerParams _viewerParams(ReaderViewerMode mode) {
    final colors = Theme.of(context).colorScheme;
    final onDarkPage = _onDarkPage;
    // Measured rather than guessed: the space at the ends of the book has to be
    // exactly what the bars cover, and both of those are screen pixels the page
    // column only knows about through here.
    final metrics = (
      viewportWidth: MediaQuery.sizeOf(context).width,
      topBar: kToolbarHeight,
      bottomBar: ReaderBottomChrome.heightFor(context),
    );
    return _paramsByMode.putIfAbsent(
      (mode, colors.brightness, onDarkPage, metrics),
      () => PdfViewerParams(
        // What shows between the sheets and at the ends of the scroll. It has
        // to be something other than paper or the gap between two white pages
        // is invisible and the layout below has bought nothing — so the darkest
        // surface in the scheme rather than the lightest, in either theme and
        // under either page tint.
        backgroundColor: colors.surfaceContainerHighest,
        onPageChanged: _onPageChanged,
        onViewerReady: _onViewerReady,
        pagePaintCallbacks: _paintCallbacks,
        pageOverlaysBuilder: _buildPageOverlays,
        viewerOverlayBuilder: _buildViewerOverlays,
        // One finger has to be free to draw. Zooming stays on, so the familiar
        // two-finger gesture still moves the page mid-drawing.
        panEnabled: mode != ReaderViewerMode.drawing,
        textSelectionParams: PdfTextSelectionParams(
          enabled: mode == ReaderViewerMode.reading,
          onTextSelectionChange: _onTextSelectionChange,
          // pdfrx drives the handles themselves end to end — this reader never
          // reaches inside that — but it reports every frame of a handle drag
          // regardless of whether its own hit test (a fixed margin, the same
          // one the long-press drag used to be stuck with) actually moved the
          // handle. [ReaderSelectionDrag.onHandlePanStart]/[onHandlePanUpdate]
          // correct it on top of whatever pdfrx already applied, through the
          // same delegate the long-press drag uses.
          onSelectionHandlePanStart: _selectionDrag.onHandlePanStart,
          onSelectionHandlePanUpdate: _selectionDrag.onHandlePanUpdate,
          onSelectionHandlePanEnd: _selectionDrag.onHandlePanEnd,
          // Both of these are worked out by the viewer from the pointer that
          // made the *selection* — and a selection this reader drives itself
          // (see [ReaderSelectionDrag]) was made by no pointer at all, which it
          // reads as a mouse. Left to infer, the action bar would never open on
          // a phone and the magnifier would go missing from the handles. Said
          // outright they stop depending on how the selection came about.
          showContextMenuAutomatically: true,
          magnifier: const PdfViewerSelectionMagnifierParams(enabled: true),
        ),
        buildContextMenu: _buildSelectionMenu,
        // The page is the full width of the viewer, and the scroll is bracketed
        // by enough blank paper to push either end clear of the bars lying over
        // it. See [readerPageGeometry].
        layoutPages: _layoutPagesFor(metrics),
        // Handled by the layout above instead, so there is no gutter down the
        // sides — a book that stops short of the screen edge is a book with a
        // frame around it.
        margin: 0,
        // The gap between the sheets is the separation, and it is the only one
        // there is: with no side gutter a cast shadow has nothing to fall on
        // but the next page.
        pageDropShadow: null,
        // Without this the book stops dead at the first and last page. The
        // platform's own physics is what every other scrollable in the app
        // uses, and its absence is the most obvious "this is a PDF in a box"
        // moment in the reader.
        scrollPhysics: PdfViewerParams.getScrollPhysics(context),
        // Deliberately no `sizeDelegateProvider`: pdfrx's default floors the
        // zoom at one whole page, which is as far out as a book is worth
        // looking at. The "smart" one divides that by `maxPagesVisible` — three
        // pages of unreadable type — and its ceiling on the *opening* zoom is
        // not worth buying at that price.
        //
        // pdfrx's own yellow and orange are painted after the night tint has
        // inverted the page, so a hit glares on a dark page. These are the
        // palette's, and they read on either paper.
        matchTextColor: readerSearchMatchColor(onDarkPage: onDarkPage),
        activeMatchTextColor: readerActiveSearchMatchColor(
          onDarkPage: onDarkPage,
        ),
      ),
    );
  }

  /// What lies over the whole viewer rather than over one page.
  ///
  /// Only the selection drag, and it is here rather than with the reader's
  /// other page layers for one reason: page overlays are built only for the
  /// pages inside the viewer's cache extent — one viewport either side — and are
  /// dropped from the tree the moment a page leaves it, which a drag that
  /// scrolls the book makes happen mid-gesture. See [ReaderSelectionDragLayer]
  /// for what a recognizer disposed under a live press does, which is nothing
  /// at all.
  ///
  /// Read from the annotation controller's own mode rather than from the one
  /// [_buildPageOverlays] derives: that one falls back to reading when markup is
  /// unavailable, while the parameters — and so whether the viewer will accept a
  /// selection at all — were built from this one.
  List<Widget> _buildViewerOverlays(
    BuildContext context,
    Size size,
    PdfViewerHandleLinkTap handleLinkTap,
  ) {
    if (_annotations.viewerMode != ReaderViewerMode.reading) {
      return const [];
    }
    return [ReaderSelectionDragLayer(drag: _selectionDrag, size: size)];
  }

  /// Everything on a page that has to be touched rather than merely drawn.
  List<Widget> _buildPageOverlays(
    BuildContext context,
    Rect pageRect,
    PdfPage page,
  ) {
    // The viewer builds overlays for exactly the pages it has laid out, which
    // is exactly the set of pages a finger can reach — including the sliver of
    // a neighbour at a page boundary, which `onPageChanged` never names. Read
    // here so a tap never has to wait for the render isolate.
    unawaited(_links.forPage(page.pageNumber));
    final mode = _canCreateMarkup
        ? _annotations.viewerMode
        : ReaderViewerMode.reading;
    final annotations = _annotations.onPage(page.pageNumber);
    final overlays = <Widget>[];

    if (annotations.isNotEmpty) {
      overlays.add(
        ReaderPageAnnotationOverlay(
          annotations: annotations,
          palette: _markupPalette,
        ),
      );
    }

    switch (mode) {
      case ReaderViewerMode.drawing:
        final tool = _annotations.tool;
        final settings = _annotations.settings;
        overlays.add(
          ReaderInkLayer(
            key: ValueKey('ink-${page.pageNumber}'),
            tool: tool,
            colorIndex: settings.inkColorIndex,
            color: readerMarkupColor(
              _markupPalette,
              settings.inkColorIndex,
            ).color,
            strokeWidth: settings.inkWidth,
            onStroke: (stroke) =>
                _annotations.addStroke(page: page.pageNumber, stroke: stroke),
            onErase: (point) =>
                _annotations.eraseAt(page: page.pageNumber, point: point),
          ),
        );
      case ReaderViewerMode.placing:
        overlays.add(
          ReaderTapLayer(
            key: ValueKey('place-${page.pageNumber}'),
            onTap: (point) =>
                unawaited(_markup.handlePlacementTap(page.pageNumber, point)),
          ),
        );
      case ReaderViewerMode.reading:
        overlays.add(
          ReaderTapLayer(
            key: ValueKey('read-${page.pageNumber}'),
            onTap: (point) => unawaited(_onReadingTap(page.pageNumber, point)),
            onDoubleTap: _onReadingDoubleTap,
          ),
        );
    }
    return overlays;
  }

  /// A tap on the page hides the chrome, and another brings it back.
  ///
  /// This is what lets the reader be mostly page. The bars do not have to be
  /// dismissed from a menu and then found again; they get out of the way and
  /// come back where they were.
  ///
  /// What a tap means while reading: markup, then a link, then the book itself.
  ///
  /// One owner for the whole page, rather than a handler per piece of markup
  /// plus a separate one for the chrome. Markup wins when the tap lands on it —
  /// a highlight is painted onto the page rather than being a widget, so this is
  /// the only way to reach one without going through the index. A link is next,
  /// and is resolved here rather than by the viewer's own link handler for the
  /// same reason the order exists at all: two tap owners over one page is how a
  /// chapter link ends up jumping *and* hiding the bars. See [ReaderLinkIndex].
  /// Everything else is a tap on the book, which is how the bars get out of the
  /// way and come back.
  Future<void> _onReadingTap(int page, NormPoint point) async {
    // Cleared before anything can return: only a tap that ends in the chrome
    // toggle below may go on to become half of a double tap.
    _chromeToggledByTap = false;
    if (_selection != null || _searching) return;
    // Letting go of a long press is not a tap on the book. The tap layer only
    // watches pointers, so it never learns that the selection drag took the
    // gesture — a press held still and released would otherwise select a word
    // and hide the bars in the same movement.
    if (_selectionDrag.active) return;
    // The tray is open with no tool chosen, which is still `reading` mode. A
    // tap that hid the chrome here would take the tray and the toggle that
    // opened it away together, leaving the reader marking up with nothing to
    // mark up with.
    if (_annotations.isMarkingUp) return;
    final annotation = _annotations.annotationAt(page, point);
    if (annotation != null) {
      AppHaptics.selection();
      unawaited(_markup.open(annotation));
      return;
    }
    // Read when the page was laid out, so this never waits. A page whose links
    // have not arrived yet is treated as having none: the chrome answering a
    // tap late is worse than a link missing one, and the next tap has them.
    final link = readerLinkAt(_links.resolved(page) ?? const [], point);
    if (link != null &&
        await followReaderLink(
          context: context,
          ref: ref,
          controller: _controller,
          link: link,
        )) {
      return;
    }
    if (!mounted) return;
    _setImmersive(!_immersive);
    _chromeToggledByTap = true;
  }

  /// A tap on the gutter, the end-paper, or anywhere else that is not a page.
  ///
  /// Page overlays only cover the sheets. The 14-pixel gap between them, the
  /// blank paper that clears the bars at either end, and the side gutter of a
  /// mixed-size book have no overlay of their own — without this they would
  /// swallow a tap that, everywhere else in the book, puts the bars away.
  void _onBackgroundTap() {
    _chromeToggledByTap = false;
    if (_selection != null || _searching) return;
    if (_selectionDrag.active) return;
    if (_annotations.isMarkingUp) return;
    _setImmersive(!_immersive);
  }

  /// The gutter layer belongs in reading mode, the same as the per-page one.
  ///
  /// Drawing and placing own the page; a tap that hid the bars then would take
  /// the tray with them. Lives on the reader's stack rather than in a viewer
  /// overlay so the test stub, which never builds those, still has a tap
  /// target — the same reason the scroll handle is here.
  bool get _backgroundTapEnabled {
    final mode = _canCreateMarkup
        ? _annotations.viewerMode
        : ReaderViewerMode.reading;
    return mode == ReaderViewerMode.reading;
  }

  /// Whether a press in the viewer's box landed on a sheet rather than beside
  /// one.
  ///
  /// False when the controller is not ready, which is the test stub: there are
  /// no pages to miss, so a tap on the viewer is a tap on the book.
  bool _globalPointIsOnPage(Offset global) {
    if (!_controller.isReady) return false;
    final document = _controller.globalToDocument(global);
    if (document == null) return false;
    return readerDocumentPointIsOnPage(
      document,
      _controller.layout.pageLayouts,
    );
  }

  /// A second tap in quick succession zooms the page in, and the one after that
  /// puts the book back the way it was.
  ///
  /// Honoured only when the tap before it was a plain tap on the page. One that
  /// opened a note or followed a link has already taken the reader somewhere
  /// else, and a zoom into wherever they landed is not what a second tap could
  /// have meant.
  ///
  /// That same flag is what makes the pair read as one gesture. The first tap
  /// has already toggled the chrome — it had to, because holding every tap for
  /// the length of the double-tap window would make the bars feel late on the
  /// far more common gesture, and a reader who taps again because nothing
  /// happened would find themselves zoomed — so the toggle is put back here.
  /// What that looks like is the bars starting to move and thinking better of
  /// it, rather than a zoom that also hid them.
  void _onReadingDoubleTap(Offset globalPosition) {
    if (!_chromeToggledByTap) return;
    _chromeToggledByTap = false;
    _setImmersive(!_immersive);
    unawaited(_zoomAtTap(globalPosition));
  }

  /// One step in, then all the way back out.
  ///
  /// Both keep the tapped point where it is, so the line being read does not
  /// slide out from under the finger. "Out" is `coverScale` — the scale the
  /// book opens at, the one that fills the viewer's width — and deliberately
  /// not `minScale`, which is the same number in portrait and a whole page
  /// shrunk to fit in landscape. A reader who has pinched below that is not
  /// zoomed *in*, so a double tap there steps up to it rather than resetting.
  Future<void> _zoomAtTap(Offset globalPosition) async {
    if (!_controller.isReady) return;
    // The tap arrives in the page overlay's own coordinates; the zoom is
    // anchored in the viewer's, which is what the controller can convert to.
    final position = _controller.globalToLocal(globalPosition);
    if (position == null) return;
    final duration = AppMotion.reducedMotion(context)
        ? Duration.zero
        : AppMotion.fast;
    final home = _controller.coverScale;
    if (_controller.currentZoom > home * _zoomedInRatio) {
      await _controller.zoomOnLocalPosition(
        localPosition: position,
        newZoom: home,
        duration: duration,
      );
      return;
    }
    await _controller.zoomUpOnLocalPosition(
      localPosition: position,
      duration: duration,
    );
  }

  void _paintPageTint(Canvas canvas, Rect pageRect, PdfPage page) {
    paintReaderPageTint(canvas, pageRect, _annotations.settings.tint);
  }

  void _paintMarkup(Canvas canvas, Rect pageRect, PdfPage page) {
    final annotations = _annotations.onPage(page.pageNumber);
    if (annotations.isEmpty) return;
    paintReaderAnnotations(
      canvas: canvas,
      pageRect: pageRect,
      annotations: annotations,
      palette: _markupPalette,
      onDarkPage: _onDarkPage,
    );
  }

  /// Highlights search matches. Reads the searcher through the field because it
  /// does not exist until the viewer is ready, after the params are built.
  void _paintSearchMatches(Canvas canvas, Rect pageRect, PdfPage page) {
    _searcher?.pageTextMatchPaintCallback(canvas, pageRect, page);
  }
}
