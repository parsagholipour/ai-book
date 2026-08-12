part of 'reader_view.dart';

/// What a selected passage becomes, and what can be done with it.
///
/// Split from the reading surface for the same reason [_ReaderViewSurface] is:
/// this half is about one passage — resolving it to a place in the book, and
/// spending it on a highlight, a note or a question — while the rest of
/// [_ReaderViewState] is about a document and a position in it. The two only
/// meet through `_selection`, `_selectionSpans` and the menu anchor.
///
/// Both the viewer's context-menu slot and the reader's own action bar are
/// driven from here, because they are two views of the same live selection and
/// keeping them in one place is what stops them disagreeing about whether there
/// still is one.
extension _ReaderViewSelection on _ReaderViewState {
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
      revision: _mappingRevision,
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

  /// Puts the action bar away while a passage is still being chosen.
  ///
  /// [ReaderSelectionDrag] sets the selection on every word the finger takes,
  /// and the viewer answers each one by offering its context-menu slot again —
  /// so without this the bar would open under the finger and the half-chosen
  /// passage would be placed against the book, several times a second. The bar
  /// belongs to a passage that has been let go of.
  void _onSelectionDragChanged() {
    if (_selectionDrag.active) _clearSelection();
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
    // The slot is kept — and kept empty — rather than given up: returning null
    // is what tells the viewer there is no menu at all, and the drag is about
    // to ask for this one again. See [_onSelectionDragChanged].
    if (_selectionDrag.active) return const SizedBox.shrink();
    unawaited(
      params.textSelectionDelegate.getSelectedTextRanges().then((ranges) {
        if (mounted) unawaited(_resolveSelection(ranges, params.anchorA));
      }),
    );
    // The menu itself is drawn by the reader's own overlay, so the viewer's
    // slot stays empty.
    return const SizedBox.shrink();
  }

  Future<void> _runAction(ReaderSelectionAction action) async {
    final selection = _selection;
    if (selection == null) return;
    final localAction =
        action == ReaderSelectionAction.copy ||
        action == ReaderSelectionAction.share;
    if (!localAction && !_canUseCurrentBook) {
      _markup.showSnack(
        'Reload this book before using actions that change or ask about it.',
      );
      return;
    }
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
    if (!_canCreateMarkup) {
      markup.showSnack(
        'Reload this book before adding markup so it stays on the right page.',
      );
      return;
    }
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
    if (!_canCreateMarkup) {
      markup.showSnack(
        'Reload this book before adding notes so they stay on the right page.',
      );
      return;
    }
    await markup.noteOnSelection(selection: selection, spans: spans);
  }
}
