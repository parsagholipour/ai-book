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

  /// The name every build before this one wrote, project-wide.
  static const _legacyManifestName = 'manifest.json';

  /// The only format that name can describe — see [_legacyManifestFile].
  static const _legacyManifestFormat = 'pdf';

  /// The cached file for [export], or null when nothing usable is stored.
  Future<CachedExport?> lookup({
    required String projectId,
    required MobileExportAvailability export,
    MobilePdfPageNumbering? pageNumbering,
  }) async {
    final directory = await storage.projectDirectory(projectId);
    final file = File('${directory.path}/${_filename(export)}');
    if (!await file.exists()) {
      return null;
    }
    final manifest = await _storedManifest(directory, export);
    if (manifest == null) {
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
    if (cached == null ||
        !cached.matches(export, pageNumbering: pageNumbering)) {
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
    MobilePdfPageNumbering? pageNumbering,
  }) async {
    // Retain the descriptor-compatible entry as an offline fallback even when
    // the stronger map digest says it should be refreshed. An older manifest
    // with no digest, or a same-revision repair, should retry online without
    // taking away the readable book already on disk if that retry fails.
    final cached = await lookup(projectId: projectId, export: export);
    if (cached != null &&
        cached.matches(export, pageNumbering: pageNumbering)) {
      // A descriptor-compatible entry stays reusable, including unknown
      // provenance, once its byte digest agrees with the map. Cover-skip is a
      // permanent fact about those bytes, so only that same digest may stamp it.
      return _withCoverPage(cached, pageNumbering, export);
    }

    final directory = await storage.projectDirectory(projectId);
    final path = '${directory.path}/${_filename(export)}';
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
    await _clearManifests(directory, export);
    final file = await partial.rename(path);
    // The stamp is permanent. Only equality between the downloaded byte digest
    // and the stored map digest can write it; revision and size both survive a
    // repair that changed pagination.
    final coverSkip =
        coverPageMapDescribes(
          fileDigest: resolved.digest,
          pageNumbering: pageNumbering,
        )
        ? pageNumbering?.hasCoverPage
        : null;
    final entry = CachedExport(
      path: file.path,
      revision: revision,
      revisionIsExact: resolved.revisionIsExact,
      digest: resolved.digest,
      byteSize: byteSize,
      downloadedAt: DateTime.now(),
      hasCoverPage: coverSkip,
    );
    if (entry.revision != null) {
      await _writeManifest(_manifestFile(directory, export), entry);
    }
    return entry;
  }

  /// Writes [hasCoverPage] onto a matching cache whose manifest never had it.
  ///
  /// Never overwrites a stamp already on the file: that value is about these
  /// bytes, and a later status flag can be about different bytes even at the
  /// same revision and size. The digest comparison refuses that mix just as the
  /// download path does. A stamp cannot be taken back once written.
  ///
  /// This is the cache-*hit* path: the reader already has the whole book, and
  /// nothing here may take it away again. The manifest write only ever makes
  /// the stamp outlive this open — see [_writeManifest].
  Future<CachedExport> _withCoverPage(
    CachedExport cached,
    MobilePdfPageNumbering? pageNumbering,
    MobileExportAvailability export,
  ) async {
    if (cached.hasCoverPage != null ||
        !coverPageMapDescribes(
          fileDigest: cached.digest,
          pageNumbering: pageNumbering,
        )) {
      return cached;
    }
    final stamped = cached.copyWith(hasCoverPage: pageNumbering!.hasCoverPage);
    // Written under the current name even for an entry that was read from the
    // old one: [_storedManifest] prefers this file, and a download clears both.
    await _writeManifest(
      _manifestFile(File(cached.path).parent, export),
      stamped,
    );
    // The stamp holds for this open whether or not it reached the disk. It is
    // a fact about the bytes the reader is about to be handed, established
    // from the map that describes them; a manifest that could not take it
    // costs durability only, and the next open asks the same map again.
    return stamped;
  }

  /// The manifest describing one cached export file, named after it.
  ///
  /// The entry inside is about one format's bytes — the revision they belong
  /// to, their size, and the permanent cover-skip stamp reader chrome numbers
  /// pages off. Both formats share a project directory, so a single
  /// project-wide manifest would have each download overwrite the other's
  /// entry: the PDF that is still current would read back as a miss, and the
  /// stamp deciding whether its footer skips the cover would go with it.
  File _manifestFile(Directory directory, MobileExportAvailability export) =>
      File('${directory.path}/${_filename(export)}.manifest.json');

  /// The project-wide manifest older builds wrote, when [export] is the format
  /// it can be describing.
  ///
  /// One name per project was enough while the reader cached a single file,
  /// and every device holding one wrote it for the PDF — the only export this
  /// cache has ever been asked for. It is still read, so an upgrade neither
  /// re-downloads the library nor drops the permanent stamp on it, and still
  /// cleared, so it cannot outlive the bytes it described. No other format may
  /// touch it: the entry names a revision and a size, and nothing in it says
  /// which file those are about.
  File? _legacyManifestFile(
    Directory directory,
    MobileExportAvailability export,
  ) {
    if (export.format != _legacyManifestFormat) {
      return null;
    }
    return File('${directory.path}/$_legacyManifestName');
  }

  /// The stored manifest for [export], preferring the per-format name.
  Future<File?> _storedManifest(
    Directory directory,
    MobileExportAvailability export,
  ) async {
    final manifest = _manifestFile(directory, export);
    if (await manifest.exists()) {
      return manifest;
    }
    final legacy = _legacyManifestFile(directory, export);
    if (legacy != null && await legacy.exists()) {
      return legacy;
    }
    return null;
  }

  /// Removes every manifest that could describe [export]'s cached file.
  ///
  /// Both names, because a device upgrading from the old scheme still has the
  /// project-wide one on disk: left behind after the bytes are replaced,
  /// [lookup] would read it back and claim a revision for a file that is not
  /// that revision's — the very thing deleting first exists to prevent.
  Future<void> _clearManifests(
    Directory directory,
    MobileExportAvailability export,
  ) async {
    for (final manifest in [
      _manifestFile(directory, export),
      ?_legacyManifestFile(directory, export),
    ]) {
      if (await manifest.exists()) {
        await manifest.delete();
      }
    }
  }

  /// Files [entry]'s manifest, degrading to no manifest when the write fails.
  ///
  /// A manifest is bookkeeping about bytes that are already on disk and
  /// already readable, so a volume that filled up or went read-only must not
  /// turn a finished download — or a cache hit that only wanted to stamp
  /// cover-skip onto one — into a failure the reader sees instead of a book.
  /// What is lost is durability: an unwritten entry makes the next open a miss
  /// and fetches again, and an unwritten stamp is taken from the same map on
  /// the next open. Both re-derive the answer this one had; neither can freeze
  /// a wrong one.
  Future<void> _writeManifest(File manifest, CachedExport entry) async {
    try {
      await manifest.writeAsString(jsonEncode(entry.toJson()));
    } on FileSystemException {
      // Nothing to fall back to and nothing to report: the caller's bytes are
      // unaffected, and every path that reads this entry treats it as absent.
    }
  }

  String _filename(MobileExportAvailability export) =>
      'book.${ReaderStorage.safeSegment(export.format)}';
}
