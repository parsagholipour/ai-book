import 'dart:async';

import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:share_plus/share_plus.dart';

import '../../../shared/ui/haptics.dart';
import '../data/reader_pdf_page_text.dart';
import '../domain/reader_annotation.dart';
import '../domain/reader_annotation_geometry.dart';
import '../domain/reader_models.dart';
import 'reader_annotation_controller.dart';
import 'reader_annotation_painter.dart';
import 'reader_annotation_sheets.dart';
import 'reader_annotations_sheet.dart';
import 'reader_appearance_sheet.dart';
import 'reader_selection_actions.dart';

/// Everything the reader can do *to* their markup.
///
/// Kept apart from the reading surface on purpose. `ReaderView` is about
/// putting a PDF on screen and keeping the viewer's parameters stable; these
/// are the flows that open sheets, ask questions and wait for answers. They
/// share nothing but the controller, and pushing them here keeps each file
/// about one thing.
///
/// Built fresh at each call site from the view's current state, so nothing is
/// held across a rebuild. [isMounted] is the same seam
/// `project_export_actions.dart` uses: an object that outlives an `await` has
/// to be able to ask whether its caller is still there.
class ReaderMarkupActions {
  const ReaderMarkupActions({
    required this.context,
    required this.controller,
    required this.projectId,
    required this.bookTitle,
    required this.palette,
    required this.editingEnabled,
    required this.isMounted,
    required this.onGoToPage,
  });

  final BuildContext context;
  final ReaderAnnotationController controller;
  final String projectId;
  final String bookTitle;
  final List<ReaderMarkupColor> palette;
  final bool editingEnabled;
  final bool Function() isMounted;
  final void Function(int page) onGoToPage;

  // ------------------------------------------------------------------ creating

  /// Marks a selected passage, one annotation per page it covers.
  ///
  /// A passage dragged over a page break is one selection but two pieces of
  /// markup, because the rectangles belong to a page and the two halves can end
  /// up chapters apart once the book is recompiled.
  void markSelection({
    required ReaderSelection selection,
    required List<ReaderSelectionSpan> spans,
    required ReaderMarkupStyle style,
    required int colorIndex,
  }) {
    for (final span in spans) {
      if (span.rects.isEmpty) continue;
      controller.addTextMarkup(
        page: span.page,
        style: style,
        rects: span.rects,
        quote: span.text.isEmpty ? selection.text : span.text,
        bookPageIndex: selection.bookPageIndex,
        colorIndex: colorIndex,
      );
    }
    controller.updateSettings(
      controller.settings.copyWith(markupColorIndex: colorIndex),
    );
    AppHaptics.success();
  }

  /// Pins a note to a selected passage.
  Future<void> noteOnSelection({
    required ReaderSelection selection,
    required List<ReaderSelectionSpan> spans,
  }) async {
    final body = await askForNote(
      title: 'Note on this passage',
      excerpt: selection.excerpt,
    );
    if (body == null || body.isEmpty || !isMounted()) return;
    final span = spans.isEmpty ? null : spans.first;
    final rects = span?.rects ?? const <NormRect>[];
    controller.addNote(
      page: span?.page ?? selection.pdfPageNumber,
      anchor: NoteAnnotation.pinFor(rects),
      body: body,
      quote: (span == null || span.text.isEmpty) ? selection.text : span.text,
      bookPageIndex: selection.bookPageIndex,
      rects: rects,
    );
    AppHaptics.success();
  }

  /// Handles a tap on the page while something is being placed or moved.
  Future<void> handlePlacementTap(int page, NormPoint point) async {
    final movingId = controller.pendingMoveId;
    if (movingId != null) {
      _completeMove(movingId, page, point);
      return;
    }

    switch (controller.tool) {
      case ReaderTool.note:
        final body = await askForNote(title: 'Add a note');
        if (body == null || body.isEmpty || !isMounted()) return;
        controller.addNote(page: page, anchor: point, body: body);
        AppHaptics.success();
      case ReaderTool.text:
        final body = await askForNote(title: 'Write on the page');
        if (body == null || body.isEmpty || !isMounted()) return;
        controller.addTextBox(page: page, anchor: point, body: body);
        AppHaptics.success();
      case ReaderTool.none:
      case ReaderTool.pen:
      case ReaderTool.eraser:
        break;
    }
  }

  void _completeMove(String id, int page, NormPoint point) {
    final target = controller.all.where((entry) => entry.id == id).firstOrNull;
    final moved = switch (target) {
      NoteAnnotation note =>
        note.copyWith(anchor: point).withAnchoring(page: page),
      TextBoxAnnotation box =>
        box.copyWith(anchor: point).withAnchoring(page: page),
      _ => null,
    };
    controller.endMove();
    if (moved != null) {
      controller.replace(moved);
      AppHaptics.tap();
    }
  }

  Future<String?> askForNote({
    required String title,
    String initial = '',
    String? excerpt,
  }) {
    return showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) =>
          ReaderNoteSheet(title: title, initial: initial, excerpt: excerpt),
    );
  }

  /// Follows the markup onto a newly compiled edition and reports the losses.
  ///
  /// Only losses: markup that moved successfully is markup the reader never
  /// needed to hear about, and a notification for a thing that went right is a
  /// notification people learn to dismiss without reading.
  Future<void> reanchorInto({
    required PdfDocument document,
    required int toRevision,
  }) async {
    if (!controller.needsReanchor) {
      controller.revision = toRevision;
      return;
    }
    final result = await controller.reanchor(
      pageCount: document.pages.length,
      toRevision: toRevision,
      loadPage: pdfReanchorLoader(document),
    );
    if (!isMounted() || result == null) return;
    final lost = result.orphaned;
    final carried = result.carried;
    if (lost == 0 && carried == 0) return;
    showSnack(
      lost > 0
          ? 'Your book changed. ${_plural(lost, "note", "notes")} could not be '
                'found in the new version — they are still in My markup.'
          : 'Your book changed. ${_plural(carried, "drawing", "drawings")} '
                'stayed where you left them and may not line up.',
    );
  }

  static String _plural(int count, String one, String many) =>
      count == 1 ? '$count $one' : '$count $many';

  // ------------------------------------------------------------------- editing

  /// Opens one piece of markup and carries out whatever was chosen.
  Future<void> open(ReaderAnnotation annotation) async {
    final command = await showReaderAnnotationSheet(
      context: context,
      annotation: annotation,
      palette: palette,
      editingEnabled: editingEnabled,
      onColorChanged: (index) => controller.replace(annotation.recolored(index)),
    );
    if (command == null || !isMounted()) return;

    switch (command) {
      case ReaderAnnotationCommand.editBody:
        await _editBody(annotation);
      case ReaderAnnotationCommand.move:
        controller.beginMove(annotation.id);
      case ReaderAnnotationCommand.delete:
        delete(annotation);
      case ReaderAnnotationCommand.copy:
        await runPassageAction(annotation, ReaderSelectionAction.copy);
      case ReaderAnnotationCommand.share:
        await runPassageAction(annotation, ReaderSelectionAction.share);
      case ReaderAnnotationCommand.ask:
        await runPassageAction(annotation, ReaderSelectionAction.ask);
      case ReaderAnnotationCommand.rewrite:
        await runPassageAction(annotation, ReaderSelectionAction.rewrite);
      case ReaderAnnotationCommand.replace:
        await runPassageAction(annotation, ReaderSelectionAction.replace);
      case ReaderAnnotationCommand.editPage:
        await runPassageAction(annotation, ReaderSelectionAction.editPage);
    }
  }

  Future<void> _editBody(ReaderAnnotation annotation) async {
    final body = await askForNote(
      title: 'Edit note',
      initial: annotation.body ?? '',
      excerpt: annotation.quote,
    );
    if (body == null || !isMounted()) return;
    final edited = switch (annotation) {
      NoteAnnotation note => note.copyWith(body: body),
      TextBoxAnnotation box => box.copyWith(body: body),
      _ => null,
    };
    if (edited != null) controller.replace(edited);
  }

  /// Deletes markup and offers the way back.
  ///
  /// [announce] is off when the deletion happens inside a modal sheet: a
  /// snackbar there is drawn by the scaffold *behind* the barrier, so the undo
  /// it offers cannot be tapped. Those callers show their own.
  void delete(ReaderAnnotation annotation, {bool announce = true}) {
    controller.remove(annotation.id);
    AppHaptics.tap();
    if (!announce) return;
    showSnack(
      'Markup deleted.',
      action: SnackBarAction(label: 'Undo', onPressed: controller.undo),
    );
  }

  /// Runs a passage action against saved markup.
  ///
  /// The annotation is turned back into a [ReaderSelection] so the whole chat
  /// path — the message wording the API's intent classifier reads, the
  /// optimistic bubble, the priced proposal — is exactly the one a live
  /// selection uses. A note is a passage the reader kept; it should be able to
  /// do everything a passage can.
  Future<void> runPassageAction(
    ReaderAnnotation annotation,
    ReaderSelectionAction action,
  ) async {
    final quote = annotation.quote?.trim() ?? '';
    final body = annotation.body?.trim() ?? '';
    final text = quote.isEmpty ? body : quote;
    if (text.isEmpty) return;
    await runReaderSelectionAction(
      context: context,
      projectId: projectId,
      selection: ReaderSelection(
        text: text,
        pdfPageNumber: annotation.page,
        bookPageIndex: annotation.bookPageIndex,
      ),
      action: action,
    );
  }

  // -------------------------------------------------------------------- sheets

  void showIndex() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => ListenableBuilder(
        listenable: controller,
        builder: (_, _) => ReaderAnnotationsSheet(
          annotations: controller.all,
          palette: palette,
          onSelect: (annotation) {
            Navigator.of(sheetContext).pop();
            onGoToPage(annotation.page);
          },
          onRemove: (annotation) => delete(annotation, announce: false),
          canUndo: controller.canUndo,
          onUndo: controller.undo,
          onShareAll: () {
            Navigator.of(sheetContext).pop();
            unawaited(shareNotes());
          },
        ),
      ),
    );
  }

  void showAppearance() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      // Rebuilt from the controller so the page behind the sheet changes as the
      // tint is chosen, which is the only way to choose one.
      builder: (_) => ListenableBuilder(
        listenable: controller,
        builder: (_, _) => ReaderAppearanceSheet(
          settings: controller.settings,
          onChanged: controller.updateSettings,
        ),
      ),
    );
  }

  Future<void> shareNotes() async {
    final text = readerMarkupShareText(
      bookTitle: bookTitle,
      annotations: controller.all,
    );
    if (text.trim().isEmpty) return;
    await SharePlus.instance.share(ShareParams(text: text));
  }

  void showSnack(String message, {SnackBarAction? action}) {
    if (!isMounted()) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message), action: action));
  }
}
