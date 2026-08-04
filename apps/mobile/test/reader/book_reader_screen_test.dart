import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_annotation_geometry.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_app_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_bottom_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_markup_bar.dart';
import 'package:tomeza/features/reader/presentation/reader_markup_toolbar.dart';
import 'package:tomeza/features/reader/presentation/reader_selection_menu.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';

/// A reader repository with no filesystem or network behind it.
class FakeReaderRepository implements ReaderRepository {
  FakeReaderRepository({this.failDownload = false});

  bool failDownload;
  ReaderState state = const ReaderState();
  List<ReaderAnnotation> annotations = const [];
  ReaderSettings settings = const ReaderSettings();
  final saved = <ReaderState>[];
  final savedAnnotations = <List<ReaderAnnotation>>[];
  final downloadedRevisions = <int>[];
  final clearedProjects = <String>[];
  Completer<void>? gate;

  @override
  Future<CachedExport> ensureExport({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) async {
    onProgress?.call(50, 100);
    await gate?.future;
    if (failDownload) {
      throw Exception('connection lost');
    }
    downloadedRevisions.add(export.revision);
    return CachedExport(
      path: '/tmp/book-${export.revision}.pdf',
      revision: export.revision,
      byteSize: export.byteSize ?? 0,
      downloadedAt: DateTime.utc(2026, 7, 25),
    );
  }

  @override
  Future<ReaderState> loadState(String projectId) async => state;

  @override
  Future<void> saveState(String projectId, ReaderState next) async {
    state = next;
    saved.add(next);
  }

  @override
  Future<List<ReaderAnnotation>> loadAnnotations(String projectId) async =>
      annotations;

  @override
  Future<void> saveAnnotations(
    String projectId,
    List<ReaderAnnotation> next,
  ) async {
    annotations = next;
    savedAnnotations.add(next);
  }

  @override
  Future<ReaderSettings> loadSettings() async => settings;

  @override
  Future<void> saveSettings(ReaderSettings next) async => settings = next;

  @override
  Future<void> clearProject(String projectId) async =>
      clearedProjects.add(projectId);

  @override
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  }) async {
    return ReaderPageLocator(
      const MobileEditableBook(
        projectId: 'project-1',
        title: 'The Book',
        pages: [
          MobileEditableBookPage(
            id: 'page-1',
            index: 1,
            title: 'Opening',
            markdown: 'The rabbit stretched in the long grass.',
            revision: 1,
          ),
        ],
      ),
    );
  }
}

MobileExportAvailability pdfExport({
  bool available = true,
  int revision = 1,
  int byteSize = 100,
}) {
  return MobileExportAvailability(
    format: 'pdf',
    available: available,
    unlocked: true,
    creditsRequired: 0,
    downloadUrl: '/api/mobile/projects/project-1/export/pdf',
    filename: 'the-race.pdf',
    contentType: 'application/pdf',
    revision: revision,
    byteSize: byteSize,
    updatedAt: DateTime.utc(2026, 7, 25),
  );
}

MobileProjectStatus statusWith(MobileExportAvailability export) {
  return MobileProjectStatus(
    projectId: 'project-1',
    status: 'complete',
    statusLabel: 'Complete',
    progressPercent: 100,
    currentAction: 'Your book is ready.',
    retryAvailable: false,
    steps: const [],
    pageProgress: const MobilePageProgress(completed: 12, target: 12),
    imageCount: 4,
    exports: MobileExportSet(
      pdf: export,
      epub: pdfExport(available: false, byteSize: 0),
    ),
    updatedAt: DateTime.utc(2026, 7, 25),
  );
}

/// Stands in for PdfViewer, whose PDFium natives are not loaded under
/// `flutter test`.
Widget stubViewer(
  BuildContext context,
  String path,
  controller,
  params,
  int initialPageNumber,
) {
  return Center(child: Text('pdf:$path@$initialPageNumber'));
}

/// Records the params object handed to the viewer on each build.
List<PdfViewerParams> capturedParams = [];

/// A selection state the viewer can report back, and act on.
class FakeTextSelection implements PdfTextSelectionDelegate {
  FakeTextSelection({required this.hasSelectedText, this.text = ''});

  @override
  final bool hasSelectedText;
  final String text;
  bool cleared = false;

  @override
  bool get isTextSelectionEnabled => true;

  @override
  bool get isCopyAllowed => true;

  @override
  bool get isSelectingAllText => false;

  @override
  PdfTextSelectionRange? get textSelectionPointRange => null;

  @override
  Future<String> getSelectedText() async => text;

  @override
  Future<List<PdfPageTextRange>> getSelectedTextRanges() async {
    if (!hasSelectedText) return const [];
    final pageText = PdfPageText(
      pageNumber: 1,
      fullText: text,
      charRects: const [],
      fragments: const [],
    );
    return [PdfPageTextRange(pageText: pageText, start: 0, end: text.length)];
  }

  @override
  Future<bool> copyTextSelection() async => true;

  @override
  Future<void> clearTextSelection() async => cleared = true;

  @override
  Future<void> selectAllText() async {}

  @override
  Future<void> selectWord(Offset position) async {}

  @override
  Future<void> setTextSelectionPointRange(PdfTextSelectionRange range) async {}

  @override
  PdfViewerCoordinateConverter get doc2local => throw UnimplementedError();
}

Widget capturingViewer(
  BuildContext context,
  String path,
  controller,
  params,
  int initialPageNumber,
) {
  capturedParams.add(params as PdfViewerParams);
  return Center(child: Text('pdf:$path@$initialPageNumber'));
}

/// Opacity the selection bar has settled at.
double menuOpacity(WidgetTester tester) {
  return tester
      .widget<AnimatedOpacity>(
        find
            .ancestor(
              of: find.byType(ReaderSelectionMenu),
              matching: find.byType(AnimatedOpacity),
            )
            .first,
      )
      .opacity;
}

bool menuIgnoresPointers(WidgetTester tester) {
  return tester
      .widget<IgnorePointer>(
        find
            .ancestor(
              of: find.byType(ReaderSelectionMenu),
              matching: find.byType(IgnorePointer),
            )
            .first,
      )
      .ignoring;
}

/// Opens the reader's overflow menu and picks an entry.
Future<void> chooseFromMenu(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip('More'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

Future<void> pumpReader(
  WidgetTester tester, {
  required FakeReaderRepository repository,
  required MobileExportAvailability export,
  ReaderDocumentLoader? loader,
}) async {
  final documentLoader = loader;
  if (documentLoader == null) {
    // Only own the disposal of a loader this helper created; a caller-supplied
    // one is re-pumped across rebuilds and disposed by the test.
    final owned = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(owned.dispose);
    return _pump(tester, repository, export, owned);
  }
  return _pump(tester, repository, export, documentLoader);
}

Future<void> _pump(
  WidgetTester tester,
  FakeReaderRepository repository,
  MobileExportAvailability export,
  ReaderDocumentLoader documentLoader,
) async {

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        readerRepositoryProvider.overrideWithValue(repository),
        readerViewerBuilderProvider.overrideWithValue(stubViewer),
      ],
      child: MaterialApp(
        home: ReaderView(
          projectId: 'project-1',
          export: export,
          loader: documentLoader,
          status: statusWith(export),
          onOpenPaywall: () {},
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('shows download progress, then the book', (tester) async {
    final repository = FakeReaderRepository()..gate = Completer<void>();

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pump();

    expect(find.textContaining('Downloading your book'), findsOneWidget);

    repository.gate!.complete();
    await tester.pumpAndSettle();

    expect(find.textContaining('Downloading your book'), findsNothing);
    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);
    expect(find.text('the-race'), findsOneWidget);
  });

  testWidgets('hands the viewer the same params across rebuilds', (
    tester,
  ) async {
    // PdfViewerParams compares by value, and the viewer relayouts whenever it
    // changes. Rebuilding the params — or their callback closures — inside
    // build turns every setState into a relayout, and a callback that itself
    // calls setState then loops forever without ever rendering a page.
    capturedParams = [];
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(capturingViewer),
        ],
        child: MaterialApp(
          home: ReaderView(
            projectId: 'project-1',
            export: pdfExport(),
            loader: loader,
            status: statusWith(pdfExport()),
            onOpenPaywall: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Any setState-driven rebuild will do; bookmarking is the simplest.
    await chooseFromMenu(tester, 'Bookmark this page');
    await chooseFromMenu(tester, 'Remove bookmark');

    expect(capturedParams.length, greaterThan(1), reason: 'expected rebuilds');
    expect(
      capturedParams.toSet(),
      hasLength(1),
      reason: 'every build must pass the identical params object',
    );
  });

  testWidgets('drops the selection menu when the passage is deselected', (
    tester,
  ) async {
    // Tapping the page to deselect dismisses the viewer's context menu without
    // asking for a new one, so the menu builder cannot be what hides the
    // reader's own action bar.
    capturedParams = [];
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(capturingViewer),
        ],
        child: MaterialApp(
          home: ReaderView(
            projectId: 'project-1',
            export: pdfExport(),
            loader: loader,
            status: statusWith(pdfExport()),
            onOpenPaywall: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final params = capturedParams.last;
    final onSelectionChange = params.textSelectionParams?.onTextSelectionChange;
    expect(onSelectionChange, isNotNull);

    // Selecting a passage: the viewer asks for a context menu, which is how
    // the reader learns what was selected.
    final selected = FakeTextSelection(
      hasSelectedText: true,
      text: 'The rabbit stretched in the long grass.',
    );
    params.buildContextMenu!(
      tester.element(find.byType(ReaderView)),
      PdfViewerContextMenuBuilderParams(
        isTextSelectionEnabled: true,
        anchorA: const Offset(100, 300),
        textSelectionDelegate: selected,
        dismissContextMenu: () {},
        contextMenuFor: PdfViewerPart.selectedText,
      ),
    );
    await tester.pumpAndSettle();

    // The book actions are the body of the floating bar, so they are what
    // proves it is up: a reader who selects a passage in this app is usually
    // about to ask about it or have it rewritten.
    for (final label in const ['Ask', 'Rewrite', 'Replace', 'Edit page']) {
      expect(find.text(label), findsOneWidget, reason: 'menu should show');
    }
    // Marking up takes over the top bar for as long as the selection lasts.
    expect(find.byType(ReaderMarkupBar), findsOneWidget);
    expect(find.byType(ReaderAppBar), findsNothing);
    expect(find.byTooltip('Yellow highlight'), findsOneWidget);
    expect(menuOpacity(tester), 1.0);
    expect(menuIgnoresPointers(tester), isFalse);

    // Tapping the page to deselect: only this callback reports it.
    onSelectionChange!(FakeTextSelection(hasSelectedText: false));
    await tester.pumpAndSettle();

    // The bar stays mounted so it can animate out, but is fully faded and
    // takes no taps.
    expect(menuOpacity(tester), 0.0);
    expect(menuIgnoresPointers(tester), isTrue);
    // The reader's own bar comes back the moment the selection goes.
    expect(find.byType(ReaderMarkupBar), findsNothing);
    expect(find.byType(ReaderAppBar), findsOneWidget);
  });

  testWidgets('opens on the page the reader left off at', (tester) async {
    final repository = FakeReaderRepository()
      ..state = const ReaderState(revision: 1, lastPage: 17);

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    expect(find.text('pdf:/tmp/book-1.pdf@17'), findsOneWidget);
  });

  testWidgets('saves a bookmark for the current page', (tester) async {
    final repository = FakeReaderRepository()
      ..state = const ReaderState(revision: 1, lastPage: 9);

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    await chooseFromMenu(tester, 'Bookmark this page');

    expect(repository.state.bookmarks.single.page, 9);
    expect(repository.state.bookmarks.single.revision, 1);

    await chooseFromMenu(tester, 'Saved places');
    expect(find.text('Page 9'), findsOneWidget);
  });

  testWidgets('offers a reload once an edit recompiles the book', (
    tester,
  ) async {
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await pumpReader(
      tester,
      repository: repository,
      export: pdfExport(),
      loader: loader,
    );
    await tester.pumpAndSettle();
    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);

    // The edit has landed and the export was recompiled at a new revision.
    await pumpReader(
      tester,
      repository: repository,
      export: pdfExport(revision: 2, byteSize: 140),
      loader: loader,
    );
    await tester.pumpAndSettle();

    expect(find.text('Your edits are in. Reload to see them.'), findsOneWidget);
    // The old compile stays on screen until the reader asks for the new one.
    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);

    await tester.tap(find.text('Reload'));
    await tester.pumpAndSettle();

    expect(repository.downloadedRevisions, [1, 2]);
    expect(find.text('pdf:/tmp/book-2.pdf@1'), findsOneWidget);
  });

  testWidgets('says the book is updating while the export is rebuilt', (
    tester,
  ) async {
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await pumpReader(
      tester,
      repository: repository,
      export: pdfExport(),
      loader: loader,
    );
    await tester.pumpAndSettle();

    // An edit deletes the compiled files until the recompile finishes.
    await pumpReader(
      tester,
      repository: repository,
      export: pdfExport(available: false),
      loader: loader,
    );
    // Not pumpAndSettle: the rebuilding banner spins indefinitely by design.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(
      find.text('Updating this book with your changes…'),
      findsOneWidget,
    );
    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);
  });

  testWidgets('offers a retry when the download fails', (tester) async {
    final repository = FakeReaderRepository(failDownload: true);

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    expect(find.text('Could not download this book'), findsOneWidget);

    repository.failDownload = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(find.text('pdf:/tmp/book-1.pdf@1'), findsOneWidget);
  });

  testWidgets('keeps the bar to three actions and the rest in the menu', (
    tester,
  ) async {
    // The point of the overflow: a reading screen that spends a third of its
    // width on buttons is a screen about its buttons.
    await pumpReader(
      tester,
      repository: FakeReaderRepository(),
      export: pdfExport(),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Search this book'), findsOneWidget);
    expect(find.byTooltip('Mark up this book'), findsOneWidget);
    expect(find.byTooltip('More'), findsOneWidget);
    // Contents and Bookmark live in the bottom bar now, within reach of a
    // thumb; the top bar must not grow a second copy of either.
    for (final tooltip in const ['Contents', 'Bookmark', 'Saved places']) {
      expect(
        find.descendant(
          of: find.byType(ReaderAppBar),
          matching: find.byTooltip(tooltip),
        ),
        findsNothing,
        reason: '"$tooltip" belongs below, not in the top bar',
      );
    }
    expect(
      find.descendant(
        of: find.byType(ReaderBottomChrome),
        matching: find.byTooltip('Contents'),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byTooltip('More'));
    await tester.pumpAndSettle();

    for (final label in const [
      'Contents',
      'Bookmark this page',
      'Saved places',
      'My markup',
      'Share my notes',
      'Appearance',
      'Full screen',
    ]) {
      expect(find.text(label), findsOneWidget, reason: 'missing "$label"');
    }
  });

  testWidgets('opens the tool tray and takes it away again', (tester) async {
    final repository = FakeReaderRepository()
      ..state = const ReaderState(revision: 1, lastPage: 3);

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    expect(find.byType(ReaderMarkupToolbar), findsNothing);

    await tester.tap(find.byTooltip('Mark up this book'));
    await tester.pumpAndSettle();

    expect(find.byType(ReaderMarkupToolbar), findsOneWidget);
    // Nothing is chosen yet, so selecting text still highlights.
    expect(
      find.text('Pick a tool, or select text to highlight it.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Pen'));
    await tester.pumpAndSettle();
    expect(
      find.text('Draw with one finger. Two fingers still move the page.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.byType(ReaderMarkupToolbar), findsNothing);
  });

  testWidgets('rebuilds the viewer params only when the gesture mode changes', (
    tester,
  ) async {
    // The params are memoized per mode: identical within a mode so a setState
    // never relayouts the viewer, and different across modes because that is
    // when panning and text selection actually have to change.
    capturedParams = [];
    final repository = FakeReaderRepository();
    final loader = ReaderDocumentLoader(
      repository: repository,
      projectId: 'project-1',
    );
    addTearDown(loader.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          readerRepositoryProvider.overrideWithValue(repository),
          readerViewerBuilderProvider.overrideWithValue(capturingViewer),
        ],
        child: MaterialApp(
          home: ReaderView(
            projectId: 'project-1',
            export: pdfExport(),
            loader: loader,
            status: statusWith(pdfExport()),
            onOpenPaywall: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final whileReading = capturedParams.last;
    expect(whileReading.panEnabled, isTrue);
    expect(whileReading.textSelectionParams?.enabled, isTrue);

    await tester.tap(find.byTooltip('Mark up this book'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pen'));
    await tester.pumpAndSettle();

    final whileDrawing = capturedParams.last;
    expect(
      whileDrawing.panEnabled,
      isFalse,
      reason: 'one finger has to be free to draw',
    );
    expect(
      whileDrawing.scaleEnabled,
      isTrue,
      reason: 'two fingers must still move and zoom the page',
    );
    expect(whileDrawing.textSelectionParams?.enabled, isFalse);

    // Back to reading hands over the very same object it started with, not a
    // rebuilt copy.
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(identical(capturedParams.last, whileReading), isTrue);
  });

  testWidgets('lists saved markup and offers to undo a deletion', (
    tester,
  ) async {
    final repository = FakeReaderRepository()
      ..annotations = [
        TextMarkupAnnotation(
          id: 'a1',
          page: 4,
          revision: 1,
          colorIndex: 0,
          createdAt: DateTime.utc(2026, 7, 20),
          updatedAt: DateTime.utc(2026, 7, 20),
          style: ReaderMarkupStyle.highlight,
          rects: const [NormRect(0.1, 0.2, 0.5, 0.02)],
          quote: 'The rabbit stretched in the long grass.',
        ),
      ];

    await pumpReader(tester, repository: repository, export: pdfExport());
    await tester.pumpAndSettle();

    // The count is what tells the reader there is anything in there.
    await tester.tap(find.byTooltip('More'));
    await tester.pumpAndSettle();
    expect(find.text('My markup (1)'), findsOneWidget);

    await tester.tap(find.text('My markup (1)'));
    await tester.pumpAndSettle();

    expect(
      find.text('The rabbit stretched in the long grass.'),
      findsOneWidget,
    );
    expect(find.text('Page 4'), findsOneWidget);

    await tester.tap(find.byTooltip('Delete'));
    await tester.pumpAndSettle();

    // Writes are debounced, so the file only catches up once the timer fires.
    await tester.pump(const Duration(seconds: 1));
    expect(
      repository.annotations.single.isDeleted,
      isTrue,
      reason: 'a deletion is a tombstone, not a missing row',
    );

    // Undo has to live in the sheet: it is modal, so a snackbar shown behind it
    // by the scaffold could never be tapped.
    await tester.tap(find.byTooltip('Undo'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 1));
    expect(repository.annotations.single.isDeleted, isFalse);
    expect(
      find.text('The rabbit stretched in the long grass.'),
      findsOneWidget,
    );
  });
}
