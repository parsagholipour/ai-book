import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../data/reader_repository.dart';
import '../domain/reader_annotation.dart';
import '../domain/reader_annotation_geometry.dart';
import '../domain/reader_reanchor.dart';
import '../domain/reader_settings.dart';

/// What the reader is currently doing to the page.
enum ReaderTool {
  /// Reading. Text selects, the page pans, nothing is being drawn.
  none,
  pen,
  eraser,
  note,
  text;

  /// Whether this tool draws with a single finger, which is the thing that
  /// cannot coexist with the viewer's own panning.
  bool get isDrawing => this == ReaderTool.pen || this == ReaderTool.eraser;

  /// Whether this tool places something where the reader taps.
  bool get isPlacing => this == ReaderTool.note || this == ReaderTool.text;
}

/// How the viewer's gestures are configured, derived from the active tool.
///
/// The viewer's parameters have to be stable — see the comment on
/// `_viewerParams` in `reader_view.dart` — so they are memoized against this,
/// not rebuilt whenever anything else about the reader changes.
enum ReaderViewerMode {
  /// Pan, zoom and select text.
  reading,

  /// Taps place a note or a text box, so text selection is off; the page still
  /// pans so the reader can get to where they want to put it.
  placing,

  /// One finger draws. Panning is off and zooming stays on, which leaves the
  /// familiar two-finger gesture to move around mid-drawing.
  drawing,
}

/// Owns a book's markup while it is open.
///
/// A [ChangeNotifier] rather than a riverpod provider, following
/// `ReaderDocumentLoader`: the reader screen is the only thing that has one,
/// and keeping it out of the provider graph means a test can drive markup
/// without a rendered PDF.
class ReaderAnnotationController extends ChangeNotifier {
  ReaderAnnotationController({
    required this.repository,
    required this.projectId,
    required this.revision,
  });

  final ReaderRepository repository;
  final String projectId;

  /// The export revision the markup is currently placed against.
  int revision;

  final List<ReaderAnnotation> _annotations = [];
  final Map<int, List<ReaderAnnotation>> _byPage = {};
  final List<List<ReaderAnnotation>> _undoStack = [];

  ReaderSettings _settings = const ReaderSettings();
  ReaderTool _tool = ReaderTool.none;
  bool _markupOpen = false;
  String? _pendingMoveId;
  bool _loaded = false;
  Timer? _saveDebounce;
  Timer? _settingsDebounce;

  static const _undoDepth = 24;
  static const _saveDelay = Duration(milliseconds: 700);

  /// How close a tap has to be to a stroke to rub it out, in page fractions.
  /// Generous on purpose: an eraser that needs to be aimed is not an eraser.
  static const eraserTolerance = 0.016;

  bool get isLoaded => _loaded;

  ReaderSettings get settings => _settings;

  ReaderTool get tool => _tool;

  /// Whether the tool tray is open.
  ///
  /// Separate from having a tool selected: the tray opens with nothing chosen,
  /// which is the state where text selection still highlights. Closing it
  /// always puts the tool away too, so there is no way to leave the reader
  /// drawing invisibly.
  bool get isMarkingUp => _markupOpen;

  ReaderViewerMode get viewerMode {
    if (_pendingMoveId != null) return ReaderViewerMode.placing;
    if (!_markupOpen) return ReaderViewerMode.reading;
    if (_tool.isDrawing) return ReaderViewerMode.drawing;
    if (_tool.isPlacing) return ReaderViewerMode.placing;
    return ReaderViewerMode.reading;
  }

  /// The annotation waiting to be put somewhere else, if any.
  String? get pendingMoveId => _pendingMoveId;

  void beginMove(String id) {
    _pendingMoveId = id;
    _markupOpen = true;
    _tool = ReaderTool.none;
    notifyListeners();
  }

  void endMove() {
    if (_pendingMoveId == null) return;
    _pendingMoveId = null;
    notifyListeners();
  }

  bool get canUndo => _undoStack.isNotEmpty;

  /// Every annotation the reader still has, tombstones excluded.
  List<ReaderAnnotation> get all =>
      List.unmodifiable(_annotations.where((entry) => !entry.isDeleted));

  int get count => _annotations.where((entry) => !entry.isDeleted).length;

  /// Markup that could not be found again after the book was rewritten.
  List<ReaderAnnotation> get orphaned => List.unmodifiable(
    _annotations.where((entry) => !entry.isDeleted && entry.orphaned),
  );

  /// What to draw on a page. Empty for a page with nothing on it, which is
  /// most of them, so the paint callback stays close to free.
  List<ReaderAnnotation> onPage(int page) => _byPage[page] ?? const [];

  /// The markup a tap at [point] should open, if any.
  ///
  /// Searched newest first, so the thing most recently put on the page — and
  /// therefore the thing drawn on top — is the thing that opens. Without this
  /// a highlight could only ever be recoloured or removed from the index sheet,
  /// because it is painted onto the page rather than being a widget.
  ReaderAnnotation? annotationAt(int page, NormPoint point) {
    final candidates = onPage(page);
    for (var i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].hitTest(point)) {
        return candidates[i];
      }
    }
    return null;
  }

  Future<void> load() async {
    final loaded = await repository.loadAnnotations(projectId);
    final settings = await repository.loadSettings();
    _annotations
      ..clear()
      ..addAll(loaded);
    _settings = settings;
    _loaded = true;
    _reindex();
    notifyListeners();
  }

  /// Whether the markup was made against a different build of the book.
  bool get needsReanchor =>
      _loaded &&
      _annotations.any(
        (entry) => !entry.isDeleted && entry.isStaleFor(revision),
      );

  /// Moves the markup onto a newly compiled edition.
  ///
  /// Returns the summary so the reader can be told what happened; nothing is
  /// written when the pass changed nothing.
  Future<ReanchorResult?> reanchor({
    required int pageCount,
    required int toRevision,
    required ReanchorPageLoader loadPage,
  }) async {
    if (!_loaded || _annotations.isEmpty) {
      revision = toRevision;
      return null;
    }
    final result = await reanchorAnnotations(
      annotations: List.of(_annotations),
      pageCount: pageCount,
      revision: toRevision,
      loadPage: loadPage,
    );
    revision = toRevision;
    if (!result.changed) {
      return null;
    }
    _annotations
      ..clear()
      ..addAll(result.annotations);
    _reindex();
    notifyListeners();
    await _persist();
    return result;
  }

  void setTool(ReaderTool tool) {
    if (_tool == tool && _markupOpen) return;
    _tool = tool;
    _markupOpen = true;
    notifyListeners();
  }

  void openMarkup() {
    if (_markupOpen) return;
    _markupOpen = true;
    notifyListeners();
  }

  void closeMarkup() {
    if (!_markupOpen && _tool == ReaderTool.none && _pendingMoveId == null) {
      return;
    }
    _markupOpen = false;
    _tool = ReaderTool.none;
    _pendingMoveId = null;
    notifyListeners();
  }

  void toggleMarkup() => _markupOpen ? closeMarkup() : openMarkup();

  /// Records a preference change and shows it immediately.
  ///
  /// The write is debounced because the brightness and thickness sliders emit
  /// on every pixel of travel, and none of those intermediate values is worth a
  /// file write.
  void updateSettings(ReaderSettings settings) {
    _settings = settings;
    notifyListeners();
    _settingsDebounce?.cancel();
    _settingsDebounce = Timer(
      _saveDelay,
      () => unawaited(repository.saveSettings(_settings)),
    );
  }

  /// Records the colour the active tool should use from now on.
  ///
  /// The pen and the highlighter remember different ones: a yellow wash is
  /// right for a highlight and useless for a line.
  void setActiveColor(int index) {
    updateSettings(
      _tool == ReaderTool.pen || _tool == ReaderTool.text
          ? _settings.copyWith(inkColorIndex: index)
          : _settings.copyWith(markupColorIndex: index),
    );
  }

  // ---------------------------------------------------------------- mutations

  ReaderAnnotation addTextMarkup({
    required int page,
    required ReaderMarkupStyle style,
    required List<NormRect> rects,
    required String quote,
    int? bookPageIndex,
    int? colorIndex,
  }) {
    final now = DateTime.now();
    final annotation = TextMarkupAnnotation(
      id: _newId(),
      page: page,
      revision: revision,
      colorIndex: colorIndex ?? _settings.markupColorIndex,
      createdAt: now,
      updatedAt: now,
      style: style,
      rects: rects,
      quote: quote,
      bookPageIndex: bookPageIndex,
    );
    // Highlighting the same words twice replaces rather than stacks. Two
    // translucent layers over one line read as a third, darker colour, and the
    // index would list the passage twice — so re-highlighting is how the colour
    // is changed, which is what people expect it to do.
    final superseded = _supersededBy(annotation);
    _mutate(() {
      final at = DateTime.now();
      for (final id in superseded) {
        _replaceById(id, (existing) => existing.deleted(at));
      }
      _annotations.add(annotation);
    });
    return annotation;
  }

  NoteAnnotation addNote({
    required int page,
    required NormPoint anchor,
    required String body,
    String? quote,
    int? bookPageIndex,
    List<NormRect> rects = const [],
    int? colorIndex,
  }) {
    final now = DateTime.now();
    final annotation = NoteAnnotation(
      id: _newId(),
      page: page,
      revision: revision,
      colorIndex: colorIndex ?? _settings.markupColorIndex,
      createdAt: now,
      updatedAt: now,
      anchor: anchor,
      body: body,
      quote: quote,
      bookPageIndex: bookPageIndex,
      rects: rects,
    );
    _mutate(() => _annotations.add(annotation));
    return annotation;
  }

  TextBoxAnnotation addTextBox({
    required int page,
    required NormPoint anchor,
    required String body,
    int? colorIndex,
  }) {
    final now = DateTime.now();
    final annotation = TextBoxAnnotation(
      id: _newId(),
      page: page,
      revision: revision,
      colorIndex: colorIndex ?? _settings.inkColorIndex,
      createdAt: now,
      updatedAt: now,
      anchor: anchor,
      body: body,
    );
    _mutate(() => _annotations.add(annotation));
    return annotation;
  }

  /// Commits a finished pen stroke.
  ///
  /// One annotation per stroke: erasing, undoing and orphaning all work at that
  /// granularity, so grouping a drawing session into one record would only make
  /// each of them harder.
  InkAnnotation? addStroke({required int page, required InkStroke stroke}) {
    if (stroke.points.length < 2) {
      return null;
    }
    final now = DateTime.now();
    final annotation = InkAnnotation(
      id: _newId(),
      page: page,
      revision: revision,
      colorIndex: stroke.colorIndex,
      createdAt: now,
      updatedAt: now,
      strokes: [stroke],
    );
    _mutate(() => _annotations.add(annotation));
    return annotation;
  }

  /// Rubs out any stroke under [point]. Returns whether anything went.
  bool eraseAt({required int page, required NormPoint point}) {
    final hits = <String>[];
    for (final annotation in onPage(page)) {
      if (annotation is! InkAnnotation) continue;
      final survivors = annotation.strokes
          .where((stroke) => !stroke.hitTest(point, eraserTolerance))
          .toList(growable: false);
      if (survivors.length != annotation.strokes.length) {
        hits.add(annotation.id);
      }
    }
    if (hits.isEmpty) {
      return false;
    }
    final at = DateTime.now();
    _mutate(() {
      for (final id in hits) {
        _replaceById(id, (annotation) => annotation.deleted(at));
      }
    });
    return true;
  }

  void replace(ReaderAnnotation annotation) {
    _mutate(() => _replaceById(annotation.id, (_) => annotation));
  }

  void remove(String id) {
    final at = DateTime.now();
    _mutate(() => _replaceById(id, (annotation) => annotation.deleted(at)));
  }

  /// Drops every annotation on the book. Undoable like anything else.
  void removeAll() {
    final at = DateTime.now();
    _mutate(() {
      for (var i = 0; i < _annotations.length; i++) {
        final annotation = _annotations[i];
        if (!annotation.isDeleted) {
          _annotations[i] = annotation.deleted(at);
        }
      }
    });
  }

  void undo() {
    if (_undoStack.isEmpty) return;
    final previous = _undoStack.removeLast();
    _annotations
      ..clear()
      ..addAll(previous);
    _reindex();
    notifyListeners();
    _scheduleSave();
  }

  /// Writes anything outstanding. Called from `dispose`, where awaiting is not
  /// an option, so the future is handed back for the rare caller that can.
  Future<void> flush() {
    _saveDebounce?.cancel();
    _saveDebounce = null;
    _settingsDebounce?.cancel();
    _settingsDebounce = null;
    return Future.wait([_persist(), repository.saveSettings(_settings)]);
  }

  @override
  void dispose() {
    _saveDebounce?.cancel();
    _settingsDebounce?.cancel();
    unawaited(_persist());
    unawaited(repository.saveSettings(_settings));
    super.dispose();
  }

  // ------------------------------------------------------------------ private

  void _mutate(VoidCallback change) {
    _undoStack.add(List.of(_annotations));
    if (_undoStack.length > _undoDepth) {
      _undoStack.removeAt(0);
    }
    change();
    _reindex();
    notifyListeners();
    _scheduleSave();
  }

  /// Existing markup of the same style covering the same words.
  ///
  /// Only the same style: an underline drawn through a highlight is two
  /// deliberate marks, not one replacing the other.
  List<String> _supersededBy(TextMarkupAnnotation incoming) {
    final ids = <String>[];
    for (final existing in onPage(incoming.page)) {
      if (existing is! TextMarkupAnnotation) continue;
      if (existing.style != incoming.style) continue;
      final overlaps = existing.rects.any(
        (rect) => incoming.rects.any(rect.overlaps),
      );
      if (overlaps) ids.add(existing.id);
    }
    return ids;
  }

  void _replaceById(
    String id,
    ReaderAnnotation Function(ReaderAnnotation) change,
  ) {
    for (var i = 0; i < _annotations.length; i++) {
      if (_annotations[i].id == id) {
        _annotations[i] = change(_annotations[i]);
        return;
      }
    }
  }

  void _reindex() {
    _byPage.clear();
    for (final annotation in _annotations) {
      if (!annotation.isPlaceable) continue;
      (_byPage[annotation.page] ??= []).add(annotation);
    }
  }

  void _scheduleSave() {
    _saveDebounce?.cancel();
    _saveDebounce = Timer(_saveDelay, () => unawaited(_persist()));
  }

  Future<void> _persist() =>
      repository.saveAnnotations(projectId, List.of(_annotations));

  static final _random = Random();

  /// Unique enough for a file only this device writes, and sortable by time,
  /// which is a useful accident when reading the JSON by hand.
  static String _newId() {
    final stamp = DateTime.now().microsecondsSinceEpoch.toRadixString(36);
    final salt = _random.nextInt(1 << 32).toRadixString(36).padLeft(7, '0');
    return '$stamp-$salt';
  }
}
