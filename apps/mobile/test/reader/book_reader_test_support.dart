import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';
import 'package:tomeza/features/reader/presentation/book_reader_screen.dart';
import 'package:tomeza/features/reader/presentation/reader_document_loader.dart';
import 'package:tomeza/features/reader/presentation/reader_view.dart';

/// A reader repository with no filesystem or network behind it.
class FakeReaderRepository implements ReaderRepository {
  FakeReaderRepository({this.failDownload = false, this.downloadError});

  bool failDownload;

  /// What a failed download throws. Null is an ordinary network failure; a
  /// refusal the app can act on — a 402, say — is passed explicitly.
  Object? downloadError;

  /// The compile the download was answered by, when it is not the one the
  /// descriptor asked for. Every compile of a book is published over the same
  /// URL, so a download that crosses one comes back as a different book than
  /// the status read named — and the response says so.
  int? answerWithRevision;

  /// Whether the server could name the compile these bytes came from. False is
  /// a file no publication recorded: shown, cached, but never re-stamped onto
  /// the reader's marks.
  bool exactProvenance = true;
  ReaderState state = const ReaderState();
  List<ReaderAnnotation> annotations = const [];
  ReaderSettings settings = const ReaderSettings();
  final saved = <ReaderState>[];
  final savedAnnotations = <List<ReaderAnnotation>>[];
  final downloadedRevisions = <int>[];
  final clearedProjects = <String>[];
  Completer<void>? gate;

  /// Holds the stored reading position back, so a test can put it after the
  /// document rather than before it. On a warm cache the two are close enough
  /// that either can win.
  Completer<void>? stateGate;

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
      throw downloadError ?? Exception('connection lost');
    }
    downloadedRevisions.add(export.revision);
    final delivered = answerWithRevision ?? export.revision;
    return CachedExport(
      // One path for every compile, as `ExportCache` really does it: each one
      // is published over `book.pdf`. A per-revision path here would hide the
      // thing the reader has to get right — telling one compile from the next
      // when the filename cannot.
      path: '/tmp/book.pdf',
      revision: delivered,
      revisionIsExact: exactProvenance,
      byteSize: export.byteSize ?? 0,
      downloadedAt: DateTime.utc(2026, 7, 25),
    );
  }

  @override
  Future<ReaderState> loadState(String projectId) async {
    await stateGate?.future;
    return state;
  }

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
  bool unlocked = true,
  int creditsRequired = 0,
  int revision = 1,
  int byteSize = 100,
}) {
  return MobileExportAvailability(
    format: 'pdf',
    available: available,
    unlocked: unlocked,
    creditsRequired: creditsRequired,
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
///
/// Reports the document's *key* rather than its path: the two are the same
/// thing for the sample book and deliberately not for a project's book, where
/// every compile is published over one filename.
Widget stubViewer(
  BuildContext context,
  PdfDocumentRef documentRef,
  controller,
  params,
  int initialPageNumber,
) {
  return Center(
    child: Text('pdf:${viewerIdentity(documentRef)}@$initialPageNumber'),
  );
}

/// The identity pdfrx would open the document under.
String viewerIdentity(PdfDocumentRef documentRef) {
  final key = documentRef.key;
  return [key.sourceName, ...key.parts].join('|');
}

/// What [stubViewer] renders for a book downloaded at [revision], open at
/// [page]. Two compiles of one book differ here and nowhere in the path.
String pdfAt(int page, {int revision = 1, int byteSize = 100}) {
  return 'pdf:/tmp/book.pdf|$revision|$byteSize|'
      '${DateTime.utc(2026, 7, 25)}@$page';
}

/// The box the viewer was laid out in, on each build.
List<Size> viewerBoxes = [];

Widget measuringViewer(
  BuildContext context,
  PdfDocumentRef documentRef,
  controller,
  params,
  int initialPageNumber,
) {
  return LayoutBuilder(
    builder: (context, constraints) {
      viewerBoxes.add(constraints.biggest);
      return const SizedBox.expand();
    },
  );
}

/// Every set of parameters the reader handed the viewer.
List<PdfViewerParams> viewerParams = [];

Widget capturingViewer(
  BuildContext context,
  PdfDocumentRef documentRef,
  PdfViewerController controller,
  PdfViewerParams params,
  int initialPageNumber,
) {
  viewerParams.add(params);
  return const SizedBox.expand();
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
