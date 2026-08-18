import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../projects/domain/project_models.dart';
import '../data/reader_repository.dart';
import '../domain/reader_models.dart';

enum ReaderLoadStage { idle, preparing, downloading, ready, failed }

/// Owns the lifecycle of the on-device PDF: download, cache reuse, progress and
/// the reload that follows an edit.
///
/// Kept out of the screen's `State` so the download can be driven and observed
/// in tests without a rendered viewer.
class ReaderDocumentLoader extends ChangeNotifier {
  ReaderDocumentLoader({required this.repository, required this.projectId});

  final ReaderRepository repository;
  final String projectId;

  ReaderLoadStage _stage = ReaderLoadStage.idle;
  CachedExport? _document;
  Object? _error;
  int _received = 0;
  int _total = 0;
  CancelToken? _cancelToken;
  bool _disposed = false;

  ReaderLoadStage get stage => _stage;
  CachedExport? get document => _document;
  Object? get error => _error;

  /// The exact revision displayed for [expectedProjectId].
  ///
  /// The project check is intentionally part of this answer. A loader is owned
  /// by one reader screen today, but accepting a reused loader from another book
  /// would otherwise make an exact revision from project B authorize marks and
  /// edits against project A.
  int? exactRevisionForProject(String expectedProjectId) {
    if (projectId != expectedProjectId) return null;
    return _document?.exactRevision;
  }

  /// The exact byte digest displayed for [expectedProjectId].
  String? digestForProject(String expectedProjectId) {
    if (projectId != expectedProjectId) return null;
    return _document?.digest;
  }

  /// The displayed revision that may be mapped to the current editable book.
  ///
  /// An exact PDF from another revision is safe to keep reading and to bookmark
  /// under its own revision, but the repository can fetch only the manuscript
  /// described by the screen's current export snapshot. Mapping either older or
  /// newer pages against a different snapshot can aim an edit or character call
  /// at the wrong scene, so those actions stand down until the states agree.
  int? mappingRevisionFor({
    required String expectedProjectId,
    required int offeredRevision,
  }) {
    final exact = exactRevisionForProject(expectedProjectId);
    if (exact == null || exact != offeredRevision) return null;
    return exact;
  }

  /// The open file's digest, when the map in force was measured from these
  /// exact bytes — and null otherwise.
  ///
  /// A revision cannot answer this. A same-revision repair publishes different
  /// PDF bytes and stamps the new map with the revision the open file already
  /// has, so [mappingRevisionFor] keeps agreeing while the two files have
  /// stopped being the same book on the page. Anything that names a *physical
  /// sheet* — the `readerContext.pdfPage` a selection sends when its local
  /// locator could not resolve one — has to be gated on this instead: sheet 7
  /// of the file on screen is not sheet 7 of the file that replaced it, and the
  /// server would translate it through the replacement's map.
  ///
  /// Model-space answers the locator already resolved are unaffected. A
  /// `pageIndex` is a page of the manuscript, not a sheet of one PDF.
  String? mappedPdfDigestFor({
    required String expectedProjectId,
    required MobilePdfPageNumbering? pageNumbering,
  }) {
    final digest = digestForProject(expectedProjectId);
    if (!coverPageMapDescribes(
      fileDigest: digest,
      pageNumbering: pageNumbering,
    )) {
      return null;
    }
    return digest;
  }

  /// Download progress in 0..1, or null when the size is not yet known.
  double? get progress {
    if (_stage != ReaderLoadStage.downloading || _total <= 0) {
      return null;
    }
    return (_received / _total).clamp(0.0, 1.0);
  }

  /// Whether a newer compile of the book is available than the one on screen.
  bool isStale(
    MobileExportAvailability export, {
    MobilePdfPageNumbering? pageNumbering,
  }) {
    final current = _document;
    if (current == null || !export.available) {
      return false;
    }
    return !current.matches(export, pageNumbering: pageNumbering);
  }

  /// Loads [export], reusing the cached file when it is still current.
  ///
  /// Concurrent calls are ignored while a download is in flight so a rebuild
  /// cannot start a second one.
  ///
  /// [refresh] re-reads what the server is offering and, when it answers,
  /// replaces [export] for this attempt. A descriptor is a snapshot of one
  /// moment, and the attempts that need it most are the ones taken long after
  /// it: a retry that follows a failed download is answered by whatever compile
  /// is behind that URL *now*, which is how a newer book ends up filed under an
  /// older revision. Only a caller that can produce a current descriptor passes
  /// this; the rest fetch what they were given.
  Future<void> load(
    MobileExportAvailability export, {
    Future<MobileExportAvailability?> Function()? refresh,
    MobilePdfPageNumbering? pageNumbering,
  }) async {
    if (_stage == ReaderLoadStage.downloading ||
        _stage == ReaderLoadStage.preparing) {
      return;
    }
    _error = null;
    _received = 0;
    _total = 0;
    _setStage(ReaderLoadStage.preparing);

    final cancelToken = CancelToken();
    _cancelToken = cancelToken;
    try {
      final target = refresh == null
          ? export
          : await _currentExport(refresh, export, cancelToken);
      if (_disposed || cancelToken.isCancelled) return;
      // [hasCoverPage] describes the compile [export] named. A refresh that
      // landed on a different revision must not inherit it.
      final numbering = target.revision == export.revision
          ? pageNumbering
          : null;
      final document = await repository.ensureExport(
        projectId: projectId,
        export: target,
        cancelToken: cancelToken,
        pageNumbering: numbering,
        onProgress: (received, total) {
          if (_disposed) return;
          _received = received;
          _total = total;
          if (_stage != ReaderLoadStage.downloading) {
            _setStage(ReaderLoadStage.downloading);
          } else {
            notifyListeners();
          }
        },
      );
      if (_disposed) return;
      _document = document;
      _setStage(ReaderLoadStage.ready);
    } catch (error) {
      if (_disposed || cancelToken.isCancelled) return;
      _error = error;
      // A failed refresh must not discard a document that is already on
      // screen — the reader keeps showing the older compile and surfaces the
      // failure as a retry instead of an empty page.
      _setStage(
        _document == null ? ReaderLoadStage.failed : ReaderLoadStage.ready,
      );
    } finally {
      if (identical(_cancelToken, cancelToken)) {
        _cancelToken = null;
      }
    }
  }

  /// Cover-skip for the file already on screen, when the map in force still
  /// describes it and the download never stamped one.
  ///
  /// Never overwrites a stamp: that value is about these bytes, and a newly
  /// published map's flag is about a different compile.
  void stampHasCoverPage(MobilePdfPageNumbering pageNumbering) {
    final current = _document;
    if (current == null ||
        current.hasCoverPage != null ||
        !coverPageMapDescribes(
          fileDigest: current.digest,
          pageNumbering: pageNumbering,
        )) {
      return;
    }
    _document = current.copyWith(hasCoverPage: pageNumbering.hasCoverPage);
    if (!_disposed) {
      notifyListeners();
    }
  }

  /// Fetches the current compile of [export].
  ///
  /// The document already on screen is kept until the new one arrives, so a
  /// reload after an edit never blanks the page the reader was on.
  Future<void> reload(
    MobileExportAvailability export, {
    MobilePdfPageNumbering? pageNumbering,
  }) => load(export, pageNumbering: pageNumbering);

  /// The descriptor to fetch: the re-read one, or [fallback] when the re-read
  /// cannot be made.
  ///
  /// A failed re-check is not the attempt failing. The download is the real
  /// test and reports its own reason, so a status call that times out or
  /// refuses leaves the reader with the same retry they had rather than a
  /// second kind of error to read. The bound matters because nothing else here
  /// has one: the stage is already `preparing`, so an answer that never comes
  /// would leave the screen on its spinner with no way back to the retry.
  Future<MobileExportAvailability> _currentExport(
    Future<MobileExportAvailability?> Function() refresh,
    MobileExportAvailability fallback,
    CancelToken cancelToken,
  ) async {
    try {
      final current = await refresh().timeout(_refreshTimeout);
      if (_disposed || cancelToken.isCancelled) {
        return fallback;
      }
      return current ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  static const _refreshTimeout = Duration(seconds: 15);

  void _setStage(ReaderLoadStage stage) {
    _stage = stage;
    if (!_disposed) {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _cancelToken?.cancel('Reader closed');
    super.dispose();
  }
}
