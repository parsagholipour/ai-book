import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../data/reader_pdf_page_text.dart';
import '../data/reader_repository.dart';
import '../domain/reader_annotation.dart';
import '../domain/reader_annotation_geometry.dart';
import '../domain/reader_link.dart';
import '../domain/reader_models.dart';
import '../domain/reader_page_layout.dart';
import '../domain/reader_settings.dart';
import 'book_reader_screen.dart';
import 'reader_annotation_controller.dart';
import 'reader_annotation_overlays.dart';
import 'reader_annotation_painter.dart';
import 'reader_app_bar.dart';
import 'reader_book_pages.dart';
import 'reader_bottom_bar.dart';
import 'reader_departures.dart';
import 'reader_document_loader.dart';
import 'reader_ink_layer.dart';
import 'reader_links.dart';
import 'reader_markup_actions.dart';
import 'reader_markup_bar.dart';
import 'reader_menu.dart';
import 'reader_outline.dart';
import 'reader_overlays.dart';
import 'reader_places.dart';
import 'reader_scroll_handle.dart';
import 'reader_search_bar.dart';
import 'reader_selection_actions.dart';
import 'reader_selection_drag.dart';
import 'reader_selection_menu.dart';
import 'reader_selection_resolver.dart';
import 'reader_update_banner.dart';

part 'reader_view_selection.dart';
part 'reader_view_surface.dart';
part 'reader_view_viewer.dart';

/// The reading surface: the rendered PDF plus everything layered over it.
class ReaderView extends ConsumerStatefulWidget {
  const ReaderView({
    required this.projectId,
    required this.export,
    required this.loader,
    required this.status,
    required this.onOpenPaywall,
    this.onRefreshExport,
    this.openAtBookPage,
    super.key,
  });

  final String projectId;
  final MobileExportAvailability export;
  final ReaderDocumentLoader loader;
  final MobileProjectStatus status;
  final VoidCallback onOpenPaywall;

  /// Re-reads the book's state and answers with the export it is now offering,
  /// or null when it cannot be read.
  ///
  /// Supplied by [BookReaderScreen], which owns the status this screen was
  /// built from. See [_ReaderViewState._retryDownload] for why a retry may not
  /// reuse the descriptor it already has.
  final Future<MobileExportAvailability?> Function()? onRefreshExport;

  /// A `Page.index` the caller wants opened, resolved once the document is up.
  final int? openAtBookPage;

  @override
  ConsumerState<ReaderView> createState() => _ReaderViewState();
}

class _ReaderViewState extends ConsumerState<ReaderView> {
  final _controller = PdfViewerController();
  PdfTextSearcher? _searcher;

  /// One set of viewer parameters per gesture mode and per look — see
  /// [_viewerParams]. The look is part of the key because the params carry
  /// colours, and a map keyed on the mode alone hands back yesterday's theme.
  final Map<
    (ReaderViewerMode, Brightness, bool, _ReaderPageMetrics),
    PdfViewerParams
  >
  _paramsByMode = {};

  /// Paint order: the tint colours the paper, markup goes on top of it, and
  /// search matches sit above everything so a hit is never lost under a
  /// highlight.
  late final List<PdfViewerPagePaintCallback> _paintCallbacks = [
    _paintPageTint,
    _paintMarkup,
    _paintSearchMatches,
  ];

  /// The book's own links — the Contents page's chapter jumps and the Sources
  /// list's citations. Resolved by the reader rather than by the viewer; see
  /// [ReaderLinkIndex] for why.
  final _links = ReaderLinkIndex();

  /// Long-press-and-keep-dragging text selection, which pdfrx cannot do on
  /// touch. One instance for the whole reader rather than one per page overlay:
  /// a drag runs off the page it started on, and the page text it caches is
  /// what makes the next move cheap.
  late final ReaderSelectionDrag _selectionDrag = ReaderSelectionDrag(
    controller: _controller,
    onChanged: _onSelectionDragChanged,
  );

  /// Held in a field because `dispose` saves the reading position, and `ref`
  /// cannot be read once the widget is unmounted.
  late final ReaderRepository _repository;
  late final ReaderAnnotationController _annotations;
  late final Future<void> _annotationsLoaded;

  ReaderState _state = const ReaderState();
  List<ReaderOutlineEntry> _outline = const [];
  ReaderSelection? _selection;
  List<ReaderSelectionSpan> _selectionSpans = const [];

  /// The last menu shown, kept after the selection goes so the bar has
  /// something to animate out with instead of vanishing.
  ReaderSelection? _menuSelection;
  Offset? _menuAnchor;

  /// The open document, kept for the things that need the PDF's own text and
  /// geometry rather than the cached file the viewer was handed.
  PdfDocument? _document;

  /// The document markup was last re-anchored against, so a rebuild does not
  /// start the search again.
  PdfDocument? _reanchoredFor;

  /// Whether the caller's requested page has already been sought.
  ///
  /// Once per screen rather than once per document: `openAtBookPage` is asked
  /// for when the reader is opened, and a reload after an edit would otherwise
  /// drag them back to it from wherever they had read on to.
  bool _seekedRequestedPage = false;

  /// Where the reader was when a reload started, as a `Page.index`.
  ///
  /// A recompiled book paginates differently, so the page *number* they were on
  /// names different words in the new file. Carried across the swap and
  /// resolved back to a rendered page once the new document is open.
  int? _resumeBookPage;

  List<ReaderMarkupColor>? _palette;
  ReaderPageTint? _paletteTint;

  bool _searching = false;
  bool _immersive = false;

  /// Whether the last tap on a page was a plain one — it toggled the chrome and
  /// did nothing else — and so is still open to becoming the first half of a
  /// double tap. See [_onReadingDoubleTap].
  bool _chromeToggledByTap = false;
  bool _updateDismissed = false;
  bool _stateLoaded = false;
  bool _awake = false;
  int _pageCount = 0;
  Timer? _saveDebounce;

  /// Flushes the reading position and the markup when the app goes away.
  ///
  /// `dispose` is not enough on its own: the ordinary end of a reading session
  /// is the OS killing a backgrounded app, where nothing gets to run. Without
  /// this the last 600ms of page turns — and up to 700ms of markup — are lost
  /// every time someone reads and then swipes the app away.
  AppLifecycleListener? _lifecycle;

  @override
  void initState() {
    super.initState();
    _repository = ref.read(readerRepositoryProvider);
    _lifecycle = AppLifecycleListener(
      onPause: _flushForBackground,
      onHide: _flushForBackground,
    );
    _annotations = ReaderAnnotationController(
      repository: _repository,
      projectId: widget.projectId,
      revision: _renderedExactRevision,
    )..addListener(_onAnnotationsChanged);
    _annotationsLoaded = _annotations.load();
    widget.loader.addListener(_onLoaderChanged);
    _restoreState();
    _syncDocument();
  }

  @override
  void didUpdateWidget(ReaderView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.loader, widget.loader)) {
      oldWidget.loader.removeListener(_onLoaderChanged);
      widget.loader.addListener(_onLoaderChanged);
    }
    _rememberOpenFileCoverPage();
    _syncDocument();
  }

  @override
  void dispose() {
    _lifecycle?.dispose();
    _saveDebounce?.cancel();
    // Leaving the reader mid-press: the gesture that would have ended the drag
    // is torn down with the tree and reports nothing, and what it leaves behind
    // is a ticker moving a book nobody is reading.
    _selectionDrag.reset();
    _persistState();
    widget.loader.removeListener(_onLoaderChanged);
    _annotations
      ..removeListener(_onAnnotationsChanged)
      ..dispose();
    _searcher?.dispose();
    if (_awake) {
      _setAwake(false);
    }
    super.dispose();
  }

  void _onLoaderChanged() {
    final exactRevision = _renderedExactRevision;
    if (exactRevision != _annotations.revision) {
      // A replacement document cannot inherit an open pen/text tool from the
      // previous one. Creation stays closed unless this PDF's exact revision is
      // known; existing marks are re-anchored separately below.
      _annotations.setDisplayedRevision(exactRevision);
    }
    _rememberOpenFileCoverPage();
    if (mounted) setState(() {});
  }

  /// Markup changed: redraw the page and, if the reader turned it on, keep the
  /// screen alive.
  void _onAnnotationsChanged() {
    if (!mounted) return;
    _syncWakelock();
    if (_controller.isReady) {
      _controller.invalidate();
    }
    _afterFrame(() {});
  }

  Future<void> _restoreState() async {
    final state = await _repository.loadState(widget.projectId);
    if (!mounted || _stateLoaded) return;
    setState(() {
      _state = state;
      _stateLoaded = true;
    });
  }

  /// Starts the download when there is nothing to show yet.
  ///
  /// A stale document is left alone: the reader is told about the new compile
  /// by the banner and reloads on their terms, rather than having the page
  /// jump out from under them mid-sentence.
  void _syncDocument() {
    final loader = widget.loader;
    if (loader.document == null && loader.stage == ReaderLoadStage.idle) {
      unawaited(
        loader.load(
          widget.export,
          pageNumbering: widget.status.pdfPageNumbering,
        ),
      );
    }
  }

  /// Stamps cover-skip onto the open file while the map in force still
  /// describes it — [coverPageMapDescribes], the same predicate chrome falls
  /// back to when nothing has been stamped.
  ///
  /// After publish the status flag follows the new map, so this must not run
  /// against a stale file: the stamp already on the cache is what chrome
  /// keeps using.
  void _rememberOpenFileCoverPage() {
    final document = widget.loader.document;
    if (document == null || document.hasCoverPage != null) {
      return;
    }
    // No flag is "no map answered for this compile", not "the cover is
    // numbered". A stamp is permanent — neither the loader nor the cache
    // overwrites one — so writing false here would freeze physical numbers
    // onto a book whose map simply had not arrived yet. Unstamped already
    // renders as physical numbers via [displayedHasCoverPage], and stays
    // correctable when the flag does turn up.
    final numbering = widget.status.pdfPageNumbering;
    if (numbering == null) {
      return;
    }
    widget.loader.stampHasCoverPage(numbering);
  }

  /// Writes the reading position, once there is one worth writing.
  ///
  /// Before the stored state has been read back, `_state` is the default —
  /// page 1, no bookmarks — and publishing that would destroy a real position
  /// for anyone who opened the reader and left again immediately.
  void _persistState() {
    if (!_stateLoaded) return;
    unawaited(_repository.saveState(widget.projectId, _state));
  }

  /// Writes everything unsaved before the process can be taken away.
  ///
  /// Both halves are debounced in normal use — the position by 600ms here, the
  /// markup and settings by 700ms in the controller — and neither debounce
  /// survives a background kill.
  void _flushForBackground() {
    _saveDebounce?.cancel();
    _saveDebounce = null;
    _persistState();
    unawaited(_annotations.flush());
  }

  void _scheduleSave() {
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(milliseconds: 600), _persistState);
  }

  /// Applies a state change the viewer asked for, as soon as it is safe to.
  ///
  /// Some of the viewer's callbacks run inside its own build and layout pass,
  /// where `setState` would rebuild mid-layout and can feed straight back into
  /// another layout. Those have to wait for the end of the frame. The rest —
  /// notably the selection changing in response to a tap — arrive while the
  /// app is idle, and deferring those would strand the change: a post-frame
  /// callback only runs once something else asks for a frame, and an idle
  /// reader never does. So the frame is requested explicitly.
  void _afterFrame(VoidCallback change) {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase !=
        SchedulerPhase.persistentCallbacks) {
      setState(change);
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(change);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  void _onPageChanged(int? pageNumber) {
    if (pageNumber == null) return;
    // Reading a page's links crosses to the render isolate, so the page being
    // looked at is resolved before it is tapped rather than during. Ahead of
    // the position check because a page can be arrived at more than once.
    unawaited(_links.forPage(pageNumber));
    if (pageNumber == _state.lastPage) return;
    _afterFrame(() => _state = _state.copyWith(lastPage: pageNumber));
    // Nothing is written until the stored position has been read back. Saving
    // before then would publish the default state — page 1, no bookmarks —
    // over a real one that is still in flight.
    if (!_stateLoaded) return;
    _scheduleSave();
  }

  void _onViewerReady(PdfDocument document, PdfViewerController _) {
    // PdfTextSearcher reads the controller's document on construction, so it
    // cannot exist before the viewer has one.
    _searcher ??= PdfTextSearcher(_controller);
    _document = document;
    _links.attach(document);
    // A selection point carries the page text its index is measured against, so
    // anything cached against the book that was on screen a moment ago would
    // index into the wrong characters of the one that just replaced it.
    _selectionDrag.reset();
    // A recompiled book can be shorter than the one the position was recorded
    // against, and jumping past the end throws.
    //
    // The clamp is applied inside the deferred callback rather than computed
    // here and assigned there: a `_restoreState` landing in the gap between the
    // two would be overwritten by a snapshot taken before it — putting the
    // reader back on page 1 with no bookmarks, durably, because the next page
    // turn saves that.
    final pageCount = document.pages.length;
    _afterFrame(() {
      _pageCount = pageCount;
      _state = _state.clampedTo(pageCount);
    });
    final clamped = _state.clampedTo(pageCount);
    // pdfrx has already gone to `initialPageNumber` with no animation, so this
    // is only for the case where the position arrived after that was read.
    if (clamped.lastPage > 1 && _controller.pageNumber != clamped.lastPage) {
      unawaited(_controller.goToPage(pageNumber: clamped.lastPage));
    }
    // The page the book opens on gets no `onPageChanged` of its own.
    unawaited(_links.forPage(clamped.lastPage));
    unawaited(_loadOutline(document));
    unawaited(_reanchorMarkup(document));
    unawaited(_seekToRequestedBookPage(document));
    unawaited(_resumeAfterReload(document));
  }

  /// Opens the book where the caller asked, once it is possible to know where
  /// that is.
  ///
  /// Runs after the saved position has been restored, so a caller that named a
  /// page wins over "where you left off" — and if the page cannot be placed,
  /// the reader is simply left where it already was.
  Future<void> _seekToRequestedBookPage(PdfDocument document) async {
    final target = widget.openAtBookPage;
    final revision = _mappingRevision;
    if (target == null || revision == null || _seekedRequestedPage) {
      return;
    }
    _seekedRequestedPage = true;
    final pdfPage = await readerPdfPageForBookPage(
      document: document,
      repository: _repository,
      projectId: widget.projectId,
      revision: revision,
      bookPageIndex: target,
    );
    if (pdfPage == null || !mounted) return;
    await _goToPage(pdfPage);
  }

  Future<void> _loadOutline(PdfDocument document) async {
    var entries = await readerOutlineFromDocument(document);
    if (entries.isEmpty) {
      // Books compiled before outline generation existed still have a linked
      // Contents page to recover chapter destinations from, and the plan
      // supplies the titles those links cannot carry.
      entries = namedReaderOutline(
        await readerOutlineFromLinks(document),
        _planChapterTitles(),
      );
    }
    if (mounted) _afterFrame(() => _outline = entries);
  }

  List<String> _planChapterTitles() {
    final plan = ref
        .read(projectDetailProvider(widget.projectId))
        .asData
        ?.value
        .plan;
    return [for (final chapter in plan?.chapters ?? const []) chapter.title];
  }

  /// The exact revision the pages on screen belong to.
  ///
  /// `widget.export` is what the server is offering *now*; the file being
  /// rendered was fetched earlier and can be a different compile of the same
  /// book, so mapping or stamping against the offered descriptor would name a
  /// manuscript the reader is not looking at. Unknown/mismatched bytes answer
  /// null and cannot create marks or be mapped to the editable manuscript.
  int? get _renderedExactRevision =>
      widget.loader.exactRevisionForProject(widget.projectId);

  String? get _renderedDigest =>
      widget.loader.digestForProject(widget.projectId);

  int? get _mappingRevision => widget.loader.mappingRevisionFor(
    expectedProjectId: widget.projectId,
    offeredRevision: widget.export.revision,
  );

  /// The open file's identity, and only while the map in force describes it.
  ///
  /// This is what lets a selection send the physical sheet it was read from.
  /// [_mappingRevision] cannot: a repair republishes the same revision over
  /// different bytes, so it keeps answering while sheet numbers have stopped
  /// meaning the same pages. Null leaves the selection on the model page its
  /// own locator resolved, which no republication moves.
  String? get _mappedPdfDigest => widget.loader.mappedPdfDigestFor(
    expectedProjectId: widget.projectId,
    pageNumbering: widget.status.pdfPageNumbering,
  );

  /// Cover-skip for the file on screen, not for the compile status is offering.
  ///
  /// Mapping already refuses the offered compile when [_renderedExactRevision]
  /// disagrees with it. Numbering keys off the stamp on the open file so a
  /// newly published version-2 map cannot skip sheet 1 of a still-open PDF
  /// that already does — or force physical numbers onto one whose footer
  /// already skips the cover.
  bool get _hasCoverPage => displayedHasCoverPage(
    cachedHasCoverPage: widget.loader.document?.hasCoverPage,
    renderedDigest: _renderedDigest,
    statusHasCoverPage: widget.status.pdfPageNumbering?.hasCoverPage,
    pageNumbering: widget.status.pdfPageNumbering,
  );

  bool get _canUseCurrentBook => _mappingRevision != null;

  bool get _canCreateMarkup {
    final revision = _renderedExactRevision;
    return revision != null && _annotations.revision == revision;
  }

  bool get _canToggleBookmark =>
      _renderedExactRevision != null || _state.hasBookmarkOn(_currentPage);

  /// Follows the markup onto a newly compiled edition of the book.
  ///
  /// Deferred until the document is open because the search needs the new
  /// PDF's own text, and guarded on the document so a rebuild does not scan it
  /// again. Only losses are reported: markup that moved successfully is markup
  /// the reader never needed to hear about.
  ///
  /// The revision comes off the downloaded file and only when the server named
  /// it, never off the descriptor: this pass rewrites every mark's revision at
  /// once, so a stamp naming a compile the marks were never placed against has
  /// the next pass trust them where it should re-search. Bytes tied to no
  /// compile are left alone entirely — a revision only ever changes by a
  /// recompile, and a recompile records what it published, so the document that
  /// needs this pass is the identified one that follows.
  Future<void> _reanchorMarkup(PdfDocument document) async {
    if (identical(_reanchoredFor, document)) return;
    _reanchoredFor = document;
    final revision = _renderedExactRevision;
    if (revision == null) return;
    await _annotationsLoaded;
    if (!mounted) return;
    await _markup.reanchorInto(document: document, toRevision: revision);
  }

  bool get _editingEnabled {
    const busy = {'generating', 'planning', 'editing'};
    return !busy.contains(widget.status.status.toLowerCase());
  }

  String get _title =>
      widget.status.exports.pdf.filename.replaceAll('.pdf', '');

  bool get _onDarkPage => _annotations.settings.tint == ReaderPageTint.night;

  /// The palette, rebuilt only when the page colour changes. It is read on
  /// every page paint, so allocating a list each time would be wasteful.
  List<ReaderMarkupColor> get _markupPalette {
    final tint = _annotations.settings.tint;
    if (_palette == null || _paletteTint != tint) {
      _paletteTint = tint;
      _palette = readerMarkupPalette(onDarkPage: _onDarkPage);
    }
    return _palette!;
  }

  ReaderUpdateStatus get _updateStatus {
    if (_updateDismissed || widget.loader.document == null) {
      return ReaderUpdateStatus.none;
    }
    if (!widget.export.available) {
      return ReaderUpdateStatus.rebuilding;
    }
    return widget.loader.isStale(
          widget.export,
          pageNumbering: widget.status.pdfPageNumbering,
        )
        ? ReaderUpdateStatus.updated
        : ReaderUpdateStatus.none;
  }

  /// Fetches the new compile and puts the reader back where they were reading.
  ///
  /// "Where" is a `Page.index` when the book can be read that way, because the
  /// new file paginates differently — an edit that adds a paragraph to chapter
  /// two moves every rendered page after it, so the old page *number* names
  /// different words. The number is kept as the fallback: it is what the reader
  /// had, and a page or two out beats the top of the book.
  Future<void> _reload() async {
    final page = _controller.isReady ? _controller.pageNumber : null;
    final bookPage = await _currentBookPageIndex();
    if (!mounted) return;
    _resumeBookPage = bookPage;
    setState(() => _updateDismissed = false);
    await widget.loader.reload(
      widget.export,
      pageNumbering: widget.status.pdfPageNumbering,
    );
    if (!mounted) return;
    if (page != null) {
      setState(() => _state = _state.copyWith(lastPage: page));
    }
  }

  /// Follows the reading position onto the compile that just replaced the one
  /// it was taken from. A page that cannot be placed leaves the reader on the
  /// page number `_reload` already restored.
  Future<void> _resumeAfterReload(PdfDocument document) async {
    final target = _resumeBookPage;
    final revision = _mappingRevision;
    _resumeBookPage = null;
    if (target == null || revision == null) return;
    final pdfPage = await readerPdfPageForBookPage(
      document: document,
      repository: _repository,
      projectId: widget.projectId,
      revision: revision,
      bookPageIndex: target,
    );
    if (pdfPage == null || !mounted) return;
    await _goToPage(pdfPage);
  }

  int get _currentPage => _controller.isReady
      ? (_controller.pageNumber ?? _state.lastPage)
      : _state.lastPage;

  /// Rings a character from the page the reader is on.
  ///
  /// The page index is what makes this different from calling from the shelf:
  /// it is sent with the call so the character stays behind where the reader
  /// has got to, instead of answering "what happens to you?" with the ending.
  /// A page that cannot be placed — the cover, the contents — simply sends
  /// nothing, and the call is unscoped rather than wrong.
  Future<int?> _currentBookPageIndex() async {
    final document = _document;
    final revision = _mappingRevision;
    if (document == null || revision == null) return null;
    return readerBookPageForPdfPage(
      document: document,
      repository: _repository,
      projectId: widget.projectId,
      revision: revision,
      pdfPageNumber: _currentPage,
    );
  }

  Future<void> _goToPage(int pageNumber) async {
    if (!_controller.isReady) return;
    await _controller.goToPage(
      pageNumber: pageNumber.clamp(1, _controller.pageCount),
    );
  }

  // ------------------------------------------------------------------ chrome

  void _onMenuAction(ReaderMenuAction action) {
    switch (action) {
      case ReaderMenuAction.contents:
        _places.showContents();
      case ReaderMenuAction.listen:
        _departures.listen();
      case ReaderMenuAction.callCharacter:
        if (_canUseCurrentBook) {
          unawaited(_departures.callCharacter());
        }
      case ReaderMenuAction.toggleBookmark:
        if (_stateLoaded && _canToggleBookmark) {
          _places.toggleBookmark(_currentPage);
        }
      case ReaderMenuAction.savedPlaces:
        _places.showBookmarks();
      case ReaderMenuAction.myMarkup:
        _markup.showIndex();
      case ReaderMenuAction.shareNotes:
        unawaited(_markup.shareNotes());
      case ReaderMenuAction.appearance:
        _markup.showAppearance();
      case ReaderMenuAction.toggleFullScreen:
        _setImmersive(!_immersive);
    }
  }

  ReaderDepartures get _departures => ReaderDepartures(
    context: context,
    projectId: widget.projectId,
    bookPageIndex: _currentBookPageIndex,
    isMounted: () => mounted,
  );

  ReaderPlaces get _places => ReaderPlaces(
    context: context,
    state: _state,
    outline: _outline,
    currentRevision: _renderedExactRevision,
    hasCoverPage: _hasCoverPage,
    onStateChanged: (state) {
      setState(() => _state = state);
      _persistState();
    },
    onGoToPage: (page) => unawaited(_goToPage(page)),
  );

  ReaderMarkupActions get _markup => ReaderMarkupActions(
    context: context,
    controller: _annotations,
    projectId: widget.projectId,
    bookTitle: _title,
    palette: _markupPalette,
    editingEnabled: _editingEnabled,
    canUseCurrentBook: () => _canUseCurrentBook,
    canModifyPlacement: () => _canCreateMarkup,
    isMounted: () => mounted,
    onGoToPage: (page) => unawaited(_goToPage(page)),
    hasCoverPage: _hasCoverPage,
  );

  // ------------------------------------------------------------------ wakelock

  void _syncWakelock() {
    final wanted = _annotations.settings.keepAwake;
    if (wanted == _awake) return;
    _awake = wanted;
    _setAwake(wanted);
  }

  /// Fire-and-forget, like the app's haptics: a device without the plugin, or
  /// one that refuses, must never take the reader down with it.
  void _setAwake(bool enabled) {
    unawaited(
      (enabled ? WakelockPlus.enable() : WakelockPlus.disable()).catchError(
        (_) {},
      ),
    );
  }

  void _setSearching(bool searching) {
    setState(() => _searching = searching);
  }

  /// Full screen puts the reader's own bars away, and only those.
  ///
  /// The phone's status bar is deliberately left alone: taking it away is the
  /// operating system's strip to lose, and a book that scrolls under the clock
  /// reads as a rendering fault rather than as more page. The band at the top
  /// of the surface keeps that strip opaque either way.
  void _setImmersive(bool immersive) {
    if (_immersive == immersive) return;
    setState(() => _immersive = immersive);
  }

  void _dismissUpdate() {
    setState(() => _updateDismissed = true);
  }

  @override
  Widget build(BuildContext context) => _buildReaderSurface(context);
}
