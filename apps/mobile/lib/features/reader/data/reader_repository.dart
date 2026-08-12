import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../projects/data/projects_repository.dart';
import '../../projects/domain/project_models.dart';
import '../domain/reader_annotation.dart';
import '../domain/reader_models.dart';
import '../domain/reader_page_locator.dart';
import '../domain/reader_settings.dart';
import 'export_cache.dart';
import 'reader_annotation_store.dart';
import 'reader_settings_store.dart';
import 'reader_state_store.dart';
import 'reader_storage.dart';

/// Everything the reader screen needs from outside itself.
///
/// Kept apart from [ProjectsRepository] on purpose: that interface is
/// hand-implemented by several test fakes, and the reader has no business
/// growing it.
abstract interface class ReaderRepository {
  /// The downloaded export, from cache when it is still current.
  Future<CachedExport> ensureExport({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  });

  Future<ReaderState> loadState(String projectId);

  Future<void> saveState(String projectId, ReaderState state);

  /// A book's markup, tombstones included.
  Future<List<ReaderAnnotation>> loadAnnotations(String projectId);

  Future<void> saveAnnotations(
    String projectId,
    List<ReaderAnnotation> annotations,
  );

  /// Reader preferences, shared across every book.
  Future<ReaderSettings> loadSettings();

  Future<void> saveSettings(ReaderSettings settings);

  /// Drops everything the reader has cached for a book — the downloaded PDF,
  /// the reading position and the markup.
  Future<void> clearProject(String projectId);

  /// A locator for resolving selected text to book pages.
  ///
  /// Rebuilt whenever [revision] changes; repeated calls at the same revision
  /// reuse the loaded book rather than refetching it.
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  });
}

class MobileReaderRepository implements ReaderRepository {
  factory MobileReaderRepository({
    required ApiClient apiClient,
    required ProjectsRepository projects,
    ReaderStorage? storage,
  }) {
    final resolved = storage ?? ReaderStorage();
    return MobileReaderRepository._(
      projects,
      resolved,
      ExportCache(apiClient: apiClient, storage: resolved),
      ReaderStateStore(storage: resolved),
      ReaderAnnotationStore(storage: resolved),
      ReaderSettingsStore(storage: resolved),
    );
  }

  MobileReaderRepository._(
    this.projects,
    this._storage,
    this._cache,
    this._stateStore,
    this._annotationStore,
    this._settingsStore,
  );

  final ProjectsRepository projects;
  final ReaderStorage _storage;
  final ExportCache _cache;
  final ReaderStateStore _stateStore;
  final ReaderAnnotationStore _annotationStore;
  final ReaderSettingsStore _settingsStore;

  _LocatorCacheEntry? _locatorCache;

  /// The last position write for a book, so the next one waits for it.
  ///
  /// The store publishes through a temporary file it names after the real one,
  /// and three call sites write unawaited — the debounced page turn, a bookmark
  /// change and the flush in `dispose`. Overlapping writes would otherwise race
  /// on that one scratch name, and the loser renames a file the winner has
  /// already moved.
  final Map<String, Future<void>> _stateWrites = {};

  @override
  Future<CachedExport> ensureExport({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) {
    return _cache.ensure(
      projectId: projectId,
      export: export,
      onProgress: onProgress,
      cancelToken: cancelToken,
    );
  }

  @override
  Future<ReaderState> loadState(String projectId) =>
      _stateStore.load(projectId);

  @override
  Future<void> saveState(String projectId, ReaderState state) {
    // Chained rather than concurrent — see [_stateWrites]. A failed write does
    // not poison the chain: the next save still runs, against the same file.
    final pending = (_stateWrites[projectId] ?? Future<void>.value())
        .then((_) => _stateStore.save(projectId, state))
        .catchError((_) {});
    _stateWrites[projectId] = pending;
    return pending;
  }

  @override
  Future<List<ReaderAnnotation>> loadAnnotations(String projectId) =>
      _annotationStore.load(projectId);

  @override
  Future<void> saveAnnotations(
    String projectId,
    List<ReaderAnnotation> annotations,
  ) => _annotationStore.save(projectId, annotations);

  @override
  Future<ReaderSettings> loadSettings() => _settingsStore.load();

  @override
  Future<void> saveSettings(ReaderSettings settings) =>
      _settingsStore.save(settings);

  @override
  Future<void> clearProject(String projectId) async {
    // The cached locator holds the deleted book's text; leaving it would serve
    // stale pages to whatever project reuses this repository next.
    if (_locatorCache?.projectId == projectId) {
      _locatorCache = null;
    }
    _stateWrites.remove(projectId);
    await _storage.clearProject(projectId);
  }

  @override
  Future<ReaderPageLocator> pageLocator({
    required String projectId,
    required int revision,
  }) async {
    final cached = _locatorCache;
    if (cached != null &&
        cached.projectId == projectId &&
        cached.revision == revision) {
      return cached.locator;
    }
    final book = await projects.getEditableBook(projectId);
    final locator = ReaderPageLocator(book);
    _locatorCache = _LocatorCacheEntry(
      projectId: projectId,
      revision: revision,
      locator: locator,
    );
    return locator;
  }
}

class _LocatorCacheEntry {
  const _LocatorCacheEntry({
    required this.projectId,
    required this.revision,
    required this.locator,
  });

  final String projectId;
  final int revision;
  final ReaderPageLocator locator;
}

final readerRepositoryProvider = Provider<ReaderRepository>((ref) {
  return MobileReaderRepository(
    apiClient: ref.watch(apiClientProvider),
    projects: ref.watch(projectsRepositoryProvider),
  );
});
