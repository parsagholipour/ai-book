import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../data/reader_pdf_page_text.dart';
import '../data/reader_repository.dart';
import '../domain/reader_annotation.dart';
import '../domain/reader_annotation_geometry.dart';
import '../domain/reader_models.dart';
import '../domain/reader_page_seek.dart';
import '../domain/reader_settings.dart';
import 'book_reader_screen.dart';
import 'reader_annotation_controller.dart';
import 'reader_annotation_overlays.dart';
import 'reader_annotation_painter.dart';
import 'reader_app_bar.dart';
import 'reader_bottom_bar.dart';
import 'reader_departures.dart';
import 'reader_document_loader.dart';
import 'reader_ink_layer.dart';
import 'reader_markup_actions.dart';
import 'reader_markup_bar.dart';
import 'reader_menu.dart';
import 'reader_outline.dart';
import 'reader_overlays.dart';
import 'reader_places.dart';
import 'reader_scroll_handle.dart';
import 'reader_search_bar.dart';
import 'reader_selection_actions.dart';
import 'reader_selection_menu.dart';
import 'reader_selection_resolver.dart';
import 'reader_update_banner.dart';

/// The reading surface: the rendered PDF plus everything layered over it.
class ReaderView extends ConsumerStatefulWidget {
  const ReaderView({
    required this.projectId,
    required this.export,
    required this.loader,
    required this.status,
    required this.onOpenPaywall,
    this.openAtBookPage,
    super.key,
  });

  final String projectId;
  final MobileExportAvailability export;
  final ReaderDocumentLoader loader;
  final MobileProjectStatus status;
  final VoidCallback onOpenPaywall;

  /// A `Page.index` the caller wants opened, resolved once the document is up.
  final int? openAtBookPage;

  @override
  ConsumerState<ReaderView> createState() => _ReaderViewState();
}

class _ReaderViewState extends ConsumerState<ReaderView> {
  final _controller = PdfViewerController();
  PdfTextSearcher? _searcher;

  /// One set of viewer parameters per gesture mode — see [_viewerParams].
  final Map<ReaderViewerMode, PdfViewerParams> _paramsByMode = {};

  /// Paint order: the tint colours the paper, markup goes on top of it, and
  /// search matches sit above everything so a hit is never lost under a
  /// highlight.
  late final List<PdfViewerPagePaintCallback> _paintCallbacks = [
    _paintPageTint,
    _paintMarkup,
    _paintSearchMatches,
  ];

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

  /// The document a requested book page was already sought in, so a reload does
  /// not drag the reader back to it after they have moved on.
  PdfDocument? _seekedFor;

  List<ReaderMarkupColor>? _palette;
  ReaderPageTint? _paletteTint;

  bool _searching = false;
  bool _immersive = false;
  bool _updateDismissed = false;
  bool _stateLoaded = false;
  bool _awake = false;
  int _pageCount = 0;
  Timer? _saveDebounce;

  @override
  void initState() {
    super.initState();
    _repository = ref.read(readerRepositoryProvider);
    _annotations = ReaderAnnotationController(
      repository: _repository,
      projectId: widget.projectId,
      revision: widget.export.revision,
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
    _syncDocument();
  }

  @override
  void dispose() {
    _saveDebounce?.cancel();
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
    if (!mounted) return;
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
      unawaited(loader.load(widget.export));
    }
  }

  void _persistState() {
    unawaited(_repository.saveState(widget.projectId, _state));
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
    if (SchedulerBinding.instance.schedulerPhase != SchedulerPhase.persistentCallbacks) {
      setState(change);
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(change);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  void _onPageChanged(int? pageNumber) {
    if (pageNumber == null || pageNumber == _state.lastPage) return;
    _afterFrame(() => _state = _state.copyWith(lastPage: pageNumber));
    _scheduleSave();
  }

  void _onViewerReady(PdfDocument document, PdfViewerController _) {
    // PdfTextSearcher reads the controller's document on construction, so it
    // cannot exist before the viewer has one.
    _searcher ??= PdfTextSearcher(_controller);
    _document = document;
    // A recompiled book can be shorter than the one the position was recorded
    // against, and jumping past the end throws.
    final pageCount = document.pages.length;
    final clamped = _state.clampedTo(pageCount);
    _afterFrame(() {
      _pageCount = pageCount;
      _state = clamped;
    });
    if (clamped.lastPage > 1) {
      unawaited(_controller.goToPage(pageNumber: clamped.lastPage));
    }
    unawaited(_loadOutline(document));
    unawaited(_reanchorMarkup(document));
    unawaited(_seekToRequestedBookPage(document));
  }

  /// Opens the book where the caller asked, once it is possible to know where
  /// that is.
  ///
  /// Runs after the saved position has been restored, so a caller that named a
  /// page wins over "where you left off" — and if the page cannot be placed,
  /// the reader is simply left where it already was.
  Future<void> _seekToRequestedBookPage(PdfDocument document) async {
    final target = widget.openAtBookPage;
    if (target == null || identical(_seekedFor, document)) return;
    _seekedFor = document;
    try {
      final locator = await _repository.pageLocator(
        projectId: widget.projectId,
        revision: widget.export.revision,
      );
      final pdfPage = await findPdfPageForBookPage(
        bookPageIndex: target,
        pdfPageCount: document.pages.length,
        locator: locator,
        loadPageText: (pageNumber) async {
          try {
            final page = document.pages[pageNumber - 1];
            return (await page.loadStructuredText()).fullText;
          } catch (_) {
            return null;
          }
        },
      );
      if (pdfPage == null || !mounted) return;
      await _goToPage(pdfPage);
    } catch (_) {
      // The book's text could not be loaded or matched. The reader still opens.
    }
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
    final plan = ref.read(projectDetailProvider(widget.projectId)).asData?.value.plan;
    return [for (final chapter in plan?.chapters ?? const []) chapter.title];
  }

  /// Follows the markup onto a newly compiled edition of the book.
  ///
  /// Deferred until the document is open because the search needs the new
  /// PDF's own text, and guarded on the document so a rebuild does not scan it
  /// again. Only losses are reported: markup that moved successfully is markup
  /// the reader never needed to hear about.
  Future<void> _reanchorMarkup(PdfDocument document) async {
    if (identical(_reanchoredFor, document)) return;
    _reanchoredFor = document;
    await _annotationsLoaded;
    if (!mounted) return;
    await _markup.reanchorInto(
      document: document,
      toRevision: widget.export.revision,
    );
  }

  bool get _editingEnabled {
    const busy = {'generating', 'planning', 'editing'};
    return !busy.contains(widget.status.status.toLowerCase());
  }

  String get _title =>
      widget.status.exports.pdf.filename.replaceAll('.pdf', '');

  bool get _onDarkPage =>
      _annotations.settings.tint == ReaderPageTint.night;

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
    return widget.loader.isStale(widget.export)
        ? ReaderUpdateStatus.updated
        : ReaderUpdateStatus.none;
  }

  Future<void> _reload() async {
    final page = _controller.isReady ? _controller.pageNumber : null;
    setState(() => _updateDismissed = false);
    await widget.loader.reload(widget.export);
    if (!mounted) return;
    if (page != null) {
      setState(() => _state = _state.copyWith(lastPage: page));
    }
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
    if (document == null) return null;
    try {
      final locator = await _repository.pageLocator(
        projectId: widget.projectId,
        revision: widget.export.revision,
      );
      final pageNumber = _currentPage;
      final page = document.pages[pageNumber - 1];
      final text = (await page.loadStructuredText()).fullText;
      // The unwidened span: the ±1 margin that keeps a *selection* inside a
      // page range would here name a page the reader has not reached.
      return locator
          .anchorSpanForPage(pdfPageNumber: pageNumber, pageText: text)
          ?.first;
    } catch (_) {
      return null;
    }
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
        unawaited(_departures.callCharacter());
      case ReaderMenuAction.toggleBookmark:
        if (_stateLoaded) _places.toggleBookmark(_currentPage);
      case ReaderMenuAction.savedPlaces:
        _places.showBookmarks();
      case ReaderMenuAction.myMarkup:
        _markup.showIndex();
      case ReaderMenuAction.shareNotes:
        unawaited(_markup.shareNotes());
      case ReaderMenuAction.appearance:
        _markup.showAppearance();
      case ReaderMenuAction.toggleFullScreen:
        setState(() => _immersive = !_immersive);
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
    currentRevision: widget.export.revision,
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
    isMounted: () => mounted,
    onGoToPage: (page) => unawaited(_goToPage(page)),
  );

  // ------------------------------------------------------------------ markup

  /// Turns a PDF text selection into an action target.
  ///
  /// Two steps, because the bar has to open the instant text is selected while
  /// placing the passage against the book's own text takes a beat. The second
  /// step is dropped when the selection has moved on.
  Future<void> _resolveSelection(
    List<PdfPageTextRange> ranges,
    Offset anchor,
  ) async {
    final preview = previewReaderSelection(ranges, _document);
    if (preview == null) {
      _clearSelection();
      return;
    }
    _showSelection(preview.selection, anchor, preview.spans);

    final placed = await placeReaderSelection(
      preview: preview,
      ranges: ranges,
      repository: _repository,
      projectId: widget.projectId,
      revision: widget.export.revision,
    );
    if (!mounted || _selection?.text != preview.selection.text) return;
    _showSelection(placed.selection, anchor, placed.spans);
  }

  void _showSelection(
    ReaderSelection selection,
    Offset anchor,
    List<ReaderSelectionSpan> spans,
  ) {
    _afterFrame(() {
      _selection = selection;
      _menuSelection = selection;
      _menuAnchor = anchor;
      _selectionSpans = spans;
    });
  }

  void _clearSelection() {
    if (_selection == null) return;
    _afterFrame(() => _selection = null);
  }

  /// Drops the viewer's own highlight as well as the menu — the passage has
  /// been acted on, so leaving it selected would be stale.
  void _dismissSelection() {
    if (_controller.isReady) {
      unawaited(_controller.textSelectionDelegate.clearTextSelection());
    }
    _clearSelection();
  }

  Future<void> _runAction(ReaderSelectionAction action) async {
    final selection = _selection;
    if (selection == null) return;
    _dismissSelection();
    await runReaderSelectionAction(
      context: context,
      projectId: widget.projectId,
      selection: selection,
      action: action,
    );
  }

  /// Marks the selected passage.
  void _markSelection(ReaderMarkupStyle style, int colorIndex) {
    final selection = _selection;
    final spans = _selectionSpans;
    final markup = _markup;
    _dismissSelection();
    if (selection == null || spans.isEmpty) {
      // Without rectangles there is nothing to draw. Rather than fail silently,
      // say so — this only happens when the document went away mid-selection.
      markup.showSnack(
        'That passage could not be marked. Try selecting it again.',
      );
      return;
    }
    markup.markSelection(
      selection: selection,
      spans: spans,
      style: style,
      colorIndex: colorIndex,
    );
  }

  Future<void> _noteOnSelection() async {
    final selection = _selection;
    if (selection == null) return;
    final spans = _selectionSpans;
    final markup = _markup;
    _dismissSelection();
    await markup.noteOnSelection(selection: selection, spans: spans);
  }

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

  // --------------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
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
              onSearch: searcher == null
                  ? null
                  : () => setState(() => _searching = true),
              onToggleMarkup: _annotations.toggleMarkup,
              onMenuAction: _onMenuAction,
            ),
      floatingActionButton: _immersive
          ? FloatingActionButton.small(
              tooltip: 'Exit full screen',
              onPressed: () => setState(() => _immersive = false),
              child: const Icon(Icons.fullscreen_exit),
            )
          : null,
      body: Column(
        children: [
          if (_searching && searcher != null)
            ReaderSearchBar(
              searcher: searcher,
              onClose: () => setState(() => _searching = false),
            ),
          ReaderUpdateBanner(
            status: _updateStatus,
            onReload: () => unawaited(_reload()),
            onDismiss: () => setState(() => _updateDismissed = true),
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
      onToggleBookmark: () => _onMenuAction(ReaderMenuAction.toggleBookmark),
      onListen: () => _onMenuAction(ReaderMenuAction.listen),
    );
  }

  String? _chapterFor(int page) => outlineEntryForPage(_outline, page)?.title;

  Widget _loadingBody(ReaderDocumentLoader loader) {
    final error = loader.error;
    if (loader.stage == ReaderLoadStage.failed && error != null) {
      return AppErrorState(
        title: 'Could not download this book',
        message: userFacingError(error),
        onRetry: () => unawaited(loader.load(widget.export)),
      );
    }
    return ReaderDownloadProgress(progress: loader.progress);
  }

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
  PdfViewerParams _viewerParams(ReaderViewerMode mode) {
    return _paramsByMode.putIfAbsent(
      mode,
      () => PdfViewerParams(
        backgroundColor: Theme.of(context).colorScheme.surfaceContainerLowest,
        onPageChanged: _onPageChanged,
        onViewerReady: _onViewerReady,
        pagePaintCallbacks: _paintCallbacks,
        pageOverlaysBuilder: _buildPageOverlays,
        // One finger has to be free to draw. Zooming stays on, so the familiar
        // two-finger gesture still moves the page mid-drawing.
        panEnabled: mode != ReaderViewerMode.drawing,
        textSelectionParams: PdfTextSelectionParams(
          enabled: mode == ReaderViewerMode.reading,
          onTextSelectionChange: _onTextSelectionChange,
        ),
        buildContextMenu: _buildSelectionMenu,
      ),
    );
  }

  /// Everything on a page that has to be touched rather than merely drawn.
  List<Widget> _buildPageOverlays(
    BuildContext context,
    Rect pageRect,
    PdfPage page,
  ) {
    final mode = _annotations.viewerMode;
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
            onTap: (point) => unawaited(
              _markup.handlePlacementTap(page.pageNumber, point),
            ),
          ),
        );
      case ReaderViewerMode.reading:
        overlays.add(
          ReaderTapLayer(
            key: ValueKey('read-${page.pageNumber}'),
            onTap: (point) => _onReadingTap(page.pageNumber, point),
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
  /// What a tap on the page means while reading.
  ///
  /// One owner for the whole page, rather than a handler per piece of markup
  /// plus a separate one for the chrome. Markup wins when the tap lands on it —
  /// a highlight is painted onto the page rather than being a widget, so this is
  /// the only way to reach one without going through the index. Everything else
  /// is a tap on the book, which is how the bars get out of the way and come
  /// back.
  void _onReadingTap(int page, NormPoint point) {
    if (_selection != null || _searching) return;
    final annotation = _annotations.annotationAt(page, point);
    if (annotation != null) {
      AppHaptics.selection();
      unawaited(_markup.open(annotation));
      return;
    }
    setState(() => _immersive = !_immersive);
  }

  /// Keeps the action menu tied to the live selection.
  ///
  /// Tapping the page to deselect dismisses the viewer's context menu without
  /// building a new one, so [_buildSelectionMenu] never runs again and cannot
  /// be what takes the menu down. This is the signal that actually reports the
  /// selection going away.
  void _onTextSelectionChange(PdfTextSelection selection) {
    if (!selection.hasSelectedText) {
      _clearSelection();
    }
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

  /// Replaces the default copy toolbar with the app's own selection actions.
  Widget? _buildSelectionMenu(
    BuildContext context,
    PdfViewerContextMenuBuilderParams params,
  ) {
    if (!params.isTextSelectionEnabled ||
        params.contextMenuFor != PdfViewerPart.selectedText) {
      _clearSelection();
      return null;
    }
    unawaited(
      params.textSelectionDelegate.getSelectedTextRanges().then((ranges) {
        if (mounted) unawaited(_resolveSelection(ranges, params.anchorA));
      }),
    );
    // The menu itself is drawn by the reader's own overlay, so the viewer's
    // slot stays empty.
    return const SizedBox.shrink();
  }
}
