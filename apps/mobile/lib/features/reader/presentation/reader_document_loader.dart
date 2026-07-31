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

  /// Download progress in 0..1, or null when the size is not yet known.
  double? get progress {
    if (_stage != ReaderLoadStage.downloading || _total <= 0) {
      return null;
    }
    return (_received / _total).clamp(0.0, 1.0);
  }

  /// Whether a newer compile of the book is available than the one on screen.
  bool isStale(MobileExportAvailability export) {
    final current = _document;
    if (current == null || !export.available) {
      return false;
    }
    return !current.matches(export);
  }

  /// Loads [export], reusing the cached file when it is still current.
  ///
  /// Concurrent calls are ignored while a download is in flight so a rebuild
  /// cannot start a second one.
  Future<void> load(MobileExportAvailability export) async {
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
      final document = await repository.ensureExport(
        projectId: projectId,
        export: export,
        cancelToken: cancelToken,
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

  /// Fetches the current compile of [export].
  ///
  /// The document already on screen is kept until the new one arrives, so a
  /// reload after an edit never blanks the page the reader was on.
  Future<void> reload(MobileExportAvailability export) => load(export);

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
