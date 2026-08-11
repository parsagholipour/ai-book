import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';

import '../../../shared/api/api_client.dart';
import '../../projects/domain/project_models.dart';
import '../domain/export_provenance.dart';
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
  ///
  /// The entry is filed under the compile that actually produced the bytes,
  /// which is not something [export] can promise on its own: every compile of a
  /// book is published over the same URL, and a book is routinely recompiled in
  /// the window between a status read and the download it leads to. The
  /// response says which one answered — see [ExportProvenance] — and only where
  /// it cannot does the descriptor stand in, guarded by the size it reported.
  /// Bytes nothing can vouch for are handed back with no revision and left out
  /// of the manifest rather than filed under a compile they may not be.
  Future<CachedExport> ensure({
    required String projectId,
    required MobileExportAvailability export,
    void Function(int received, int total)? onProgress,
    CancelToken? cancelToken,
  }) async {
    final cached = await lookup(projectId: projectId, export: export);
    if (cached != null) {
      // An approximate entry — one that predates provenance, came from an
      // older server, or belongs to a book the server can only ever call
      // `unknown` — is as good as it ever was for as long as it matches the
      // descriptor. Re-downloading it to chase an exact promotion re-fetched
      // the whole book on every open, permanently for books whose provenance
      // can never be established; promotion happens instead on the next real
      // miss, when the descriptor moves.
      return cached;
    }

    final directory = await storage.projectDirectory(projectId);
    final path = '${directory.path}/${_filename(export)}';
    final manifest = File('${directory.path}/$_manifestName');
    final partial = File('$path.part');
    if (await partial.exists()) {
      await partial.delete();
    }

    final DownloadedFile received;
    try {
      received = await apiClient.downloadFile(
        export.downloadUrl,
        partial.path,
        onReceiveProgress: onProgress,
        cancelToken: cancelToken,
      );
    } catch (_) {
      if (await partial.exists()) {
        await partial.delete();
      }
      if (cached != null) {
        return cached;
      }
      rethrow;
    }

    final byteSize = await partial.length();
    // The same resolution rule the save/share path validates through. This
    // surface keeps more than that one: an exact-but-older compile is still a
    // whole readable book filed under its own true revision — the next open
    // refetches — while a truncated transfer, a file replaced under the read,
    // or bytes nothing can vouch for are handed back with no revision and left
    // out of the manifest.
    final resolved = ExportProvenance.fromDownload(received).resolveDownload(
      byteSize: byteSize,
      declaredContentLength: received.contentLength,
      descriptorRevision: export.revision,
      descriptorByteSize: export.byteSize,
    );
    final revision = resolved.revision;
    if (cached != null && revision == null) {
      // Do not replace a readable approximate book with bytes a current server
      // explicitly could not identify. The next open retries promotion.
      await partial.delete();
      return cached;
    }

    // The manifest describes the file about to be replaced, so it goes first:
    // an entry that outlived its bytes — through a crash here, or because the
    // new ones cannot be identified — would claim a revision for a file that is
    // not that revision's.
    if (await manifest.exists()) {
      await manifest.delete();
    }
    final file = await partial.rename(path);
    final entry = CachedExport(
      path: file.path,
      revision: revision,
      revisionIsExact: resolved.revisionIsExact,
      byteSize: byteSize,
      downloadedAt: DateTime.now(),
    );
    if (entry.revision != null) {
      await manifest.writeAsString(jsonEncode(entry.toJson()));
    }
    return entry;
  }

  String _filename(MobileExportAvailability export) =>
      'book.${ReaderStorage.safeSegment(export.format)}';
}
