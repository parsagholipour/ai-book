import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';

import '../../../shared/api/api_client.dart';
import '../../projects/domain/project_models.dart';
import '../domain/reader_models.dart';
import 'reader_storage.dart';

/// Downloads a compiled export once and reuses it on later opens.
///
/// Before the reader existed, every "Open PDF" tap re-downloaded the whole
/// book. Reading is a repeat action, so the file is kept and revalidated
/// against the server's reported revision and size instead.
class ExportCache {
  ExportCache({required this.apiClient, required this.storage});

  final ApiClient apiClient;
  final ReaderStorage storage;

  static const _manifestName = 'manifest.json';

  /// The cached file for [export], or null when nothing usable is stored.
  Future<CachedExport?> lookup({
    required String projectId,
    required MobileExportAvailability export,
  }) async {
    final directory = await storage.projectDirectory(projectId);
    final file = File('${directory.path}/${_filename(export)}');
    final manifest = File('${directory.path}/$_manifestName');
    if (!await file.exists() || !await manifest.exists()) {
      return null;
    }

    Map<String, dynamic> json;
    try {
      json = jsonDecode(await manifest.readAsString()) as Map<String, dynamic>;
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }

    final cached = CachedExport.fromJson(json, file.path);
    if (cached == null || !cached.matches(export)) {
      return null;
    }
    // A file truncated by a crash would pass the manifest check but fail to
    // parse as a PDF, so the size on disk is confirmed too.
    if (await file.length() != cached.byteSize) {
      return null;
    }
    return cached;
  }

  /// Returns the cached export, downloading it when absent or stale.
  ///
  /// The download lands in a temporary file that is renamed into place only
  /// once it completes, so an interrupted download never leaves a half-written
  /// PDF that the viewer would reject.
  Future<CachedExport> ensure({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) async {
    final cached = await lookup(projectId: projectId, export: export);
    if (cached != null) {
      return cached;
    }

    final directory = await storage.projectDirectory(projectId);
    final path = '${directory.path}/${_filename(export)}';
    final partial = File('$path.part');
    if (await partial.exists()) {
      await partial.delete();
    }

    try {
      await apiClient.downloadFile(
        export.downloadUrl,
        partial.path,
        onReceiveProgress: onProgress,
        cancelToken: cancelToken,
      );
    } catch (_) {
      if (await partial.exists()) {
        await partial.delete();
      }
      rethrow;
    }

    final file = await partial.rename(path);
    final entry = CachedExport(
      path: file.path,
      revision: export.revision,
      byteSize: await file.length(),
      downloadedAt: DateTime.now(),
    );
    await File(
      '${directory.path}/$_manifestName',
    ).writeAsString(jsonEncode(entry.toJson()));
    return entry;
  }

  String _filename(MobileExportAvailability export) =>
      'book.${ReaderStorage.safeSegment(export.format)}';
}
