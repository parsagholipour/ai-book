import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';
import 'package:tomeza/features/reader/data/reader_repository.dart';
import 'package:tomeza/features/reader/domain/reader_annotation.dart';
import 'package:tomeza/features/reader/domain/reader_models.dart';
import 'package:tomeza/features/reader/domain/reader_page_locator.dart';
import 'package:tomeza/features/reader/domain/reader_settings.dart';

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
      path: '/tmp/book-$delivered.pdf',
      revision: delivered,
      revisionIsExact: exactProvenance,
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
Widget stubViewer(
  BuildContext context,
  String path,
  controller,
  params,
  int initialPageNumber,
) {
  return Center(child: Text('pdf:$path@$initialPageNumber'));
}
