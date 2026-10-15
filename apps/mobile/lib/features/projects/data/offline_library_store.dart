import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../shared/api/api_error.dart';
import '../domain/project_models.dart';

/// What the phone keeps so a reader with no connection can still find their
/// books: the last library the server sent, and each book's last status that
/// offered a PDF — the descriptor the reader opens a downloaded file against.
///
/// An offline cold start opens with the account the phone holds
/// (`AuthSession.offline`), but the library and every book's status lived only
/// in memory, so the books and narrations already downloaded could not be
/// reached. Both are written here as the server sent them and read back by the
/// same parsers, never rebuilt from fields.
///
/// It belongs to whoever is signed in: `AuthController` clears it on every
/// sign-out and lost session, so the account an offline start opens is the
/// account these files are about. [epoch] fences the writes still in flight
/// when that happens — a request the old account started must not refill the
/// store after it was emptied.
///
/// Every method swallows its own failures. This is a convenience for being
/// offline; a full disk or an unreadable file costs the offline view, never
/// a screen that is online.
abstract interface class OfflineLibraryStore {
  /// Advanced by [clear]. A writer captures it before its request and passes
  /// it back, and a write from an earlier epoch is dropped.
  int get epoch;

  Future<void> saveLibrary(List<MobileProjectSummary> books, {int? epoch});

  Future<OfflineLibrary?> loadLibrary();

  /// Keeps [status] as its book's offline descriptor, when it offers a PDF.
  Future<void> saveStatus(MobileProjectStatus status, {int? epoch});

  Future<OfflineBookStatus?> loadStatus(String projectId);

  /// A book that was deleted.
  Future<void> forgetProject(String projectId);

  /// Everything, for the account that just left.
  Future<void> clear();
}

/// The library as last read from the server.
class OfflineLibrary {
  const OfflineLibrary({required this.books, required this.savedAt});

  final List<MobileProjectSummary> books;
  final DateTime savedAt;
}

/// A book's status as last read from the server with a PDF on offer.
class OfflineBookStatus {
  const OfflineBookStatus({required this.status, required this.savedAt});

  final MobileProjectStatus status;
  final DateTime savedAt;
}

/// Whether [error] says only that the server could not be reached — no
/// network, a timeout, or a gateway answering that the server behind it is
/// down (502, 503, 504) — rather than that it refused or failed.
///
/// Narrower than the offline session start's `cannotReachServer`, which lets
/// any 5xx open the stored session: here the answer decides whether a screen
/// says "you're offline" and shows the phone's copy, and a 500 from a server
/// that is up is that server's error to report, not a lost connection.
bool isOfflineFailure(Object? error) {
  if (error is! ApiException) return false;
  if (error.code == 'NETWORK_ERROR') return true;
  final status = error.statusCode;
  return status == 502 || status == 503 || status == 504;
}

/// The identity of the PDF a status offers. A status is rewritten on every
/// progress step; the offline copy only has to change when this does.
String? _descriptorKey(MobileProjectStatus status) {
  final pdf = status.exports.pdf;
  if (!pdf.available) return null;
  final numbering = status.pdfPageNumbering;
  return [
    pdf.revision,
    pdf.byteSize,
    pdf.filename,
    pdf.readUrl ?? pdf.downloadUrl,
    numbering?.pdfDigest,
    numbering?.hasCoverPage,
  ].join('|');
}

/// JSON files under `tomeza_offline/` in the app's documents directory.
class FileOfflineLibraryStore implements OfflineLibraryStore {
  FileOfflineLibraryStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;
  int _epoch = 0;

  /// What was last written per book, so an unchanged descriptor is not
  /// written again on every status the book sends.
  final Map<String, String> _writtenKeys = {};

  static const directoryName = 'tomeza_offline';
  static const libraryFilename = 'library.json';

  @override
  int get epoch => _epoch;

  static String _segment(String value) {
    final safe = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '-');
    return safe.isEmpty ? 'unknown' : safe;
  }

  Future<Directory> _directory() async {
    final root =
        _override ?? (_resolved ??= await getApplicationDocumentsDirectory());
    return Directory('${root.path}/$directoryName');
  }

  Future<File> _statusFile(String projectId) async {
    final directory = await _directory();
    return File('${directory.path}/status/${_segment(projectId)}.json');
  }

  @override
  Future<void> saveLibrary(
    List<MobileProjectSummary> books, {
    int? epoch,
  }) async {
    final written = epoch ?? _epoch;
    // A summary built in code has nothing to write as the server sent it.
    if (books.any((book) => book.payload == null)) return;
    try {
      final directory = await _directory();
      if (written != _epoch) return;
      await _write(File('${directory.path}/$libraryFilename'), {
        'savedAt': DateTime.now().toUtc().toIso8601String(),
        'projects': [for (final book in books) book.payload],
      }, written);
    } catch (_) {
      // See the class: never a failure anyone sees.
    }
  }

  @override
  Future<OfflineLibrary?> loadLibrary() async {
    try {
      final directory = await _directory();
      final json = await _read(File('${directory.path}/$libraryFilename'));
      if (json == null) return null;
      final savedAt = DateTime.tryParse(json['savedAt'] as String? ?? '');
      final projects = json['projects'];
      if (savedAt == null || projects is! List) return null;
      return OfflineLibrary(
        savedAt: savedAt,
        books: [
          for (final project in projects.whereType<Map<String, dynamic>>())
            MobileProjectSummary.fromJson(project),
        ],
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> saveStatus(MobileProjectStatus status, {int? epoch}) async {
    final written = epoch ?? _epoch;
    final key = _descriptorKey(status);
    final payload = status.payload;
    if (key == null || payload == null) return;
    if (_writtenKeys[status.projectId] == key) return;
    try {
      final file = await _statusFile(status.projectId);
      if (written != _epoch) return;
      await _write(file, {
        'savedAt': DateTime.now().toUtc().toIso8601String(),
        'status': jsonDecode(payload),
      }, written);
      if (written == _epoch) _writtenKeys[status.projectId] = key;
    } catch (_) {
      // See the class.
    }
  }

  @override
  Future<OfflineBookStatus?> loadStatus(String projectId) async {
    try {
      final json = await _read(await _statusFile(projectId));
      if (json == null) return null;
      final savedAt = DateTime.tryParse(json['savedAt'] as String? ?? '');
      final status = json['status'];
      if (savedAt == null || status is! Map<String, dynamic>) return null;
      return OfflineBookStatus(
        status: MobileProjectStatus.fromJson(status),
        savedAt: savedAt,
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> forgetProject(String projectId) async {
    _writtenKeys.remove(projectId);
    try {
      final file = await _statusFile(projectId);
      if (await file.exists()) await file.delete();
    } catch (_) {
      // See the class.
    }
  }

  @override
  Future<void> clear() async {
    _epoch++;
    _writtenKeys.clear();
    try {
      final directory = await _directory();
      if (await directory.exists()) await directory.delete(recursive: true);
    } catch (_) {
      // See the class.
    }
  }

  /// Writes beside the file and renames over it, so a crash mid-write leaves
  /// the previous copy rather than half of a new one.
  Future<void> _write(File file, Map<String, dynamic> json, int epoch) async {
    await file.parent.create(recursive: true);
    final partial = File('${file.path}.part');
    await partial.writeAsString(jsonEncode(json), flush: true);
    if (epoch != _epoch) {
      await partial.delete();
      return;
    }
    await partial.rename(file.path);
  }

  Future<Map<String, dynamic>?> _read(File file) async {
    if (!await file.exists()) return null;
    final json = jsonDecode(await file.readAsString());
    return json is Map<String, dynamic> ? json : null;
  }
}

/// The store in memory, for tests.
class MemoryOfflineLibraryStore implements OfflineLibraryStore {
  MemoryOfflineLibraryStore({
    this.library,
    Map<String, OfflineBookStatus>? statuses,
  }) : statuses = statuses ?? {};

  OfflineLibrary? library;
  final Map<String, OfflineBookStatus> statuses;
  int _epoch = 0;
  var clears = 0;

  @override
  int get epoch => _epoch;

  @override
  Future<void> saveLibrary(
    List<MobileProjectSummary> books, {
    int? epoch,
  }) async {
    if ((epoch ?? _epoch) != _epoch) return;
    library = OfflineLibrary(books: books, savedAt: DateTime.now());
  }

  @override
  Future<OfflineLibrary?> loadLibrary() async => library;

  @override
  Future<void> saveStatus(MobileProjectStatus status, {int? epoch}) async {
    if ((epoch ?? _epoch) != _epoch || _descriptorKey(status) == null) return;
    statuses[status.projectId] = OfflineBookStatus(
      status: status,
      savedAt: DateTime.now(),
    );
  }

  @override
  Future<OfflineBookStatus?> loadStatus(String projectId) async =>
      statuses[projectId];

  @override
  Future<void> forgetProject(String projectId) async {
    statuses.remove(projectId);
  }

  @override
  Future<void> clear() async {
    _epoch++;
    clears++;
    library = null;
    statuses.clear();
  }
}

final offlineLibraryStoreProvider = Provider<OfflineLibraryStore>((ref) {
  return FileOfflineLibraryStore();
});

/// Whether the library on screen came from the phone rather than the server,
/// and from when. Written by `projectsProvider` with every answer it gives —
/// a plain object, like `ProjectSnapshotCache`, because the list's type is
/// shared by every screen that shows a book and only the library asks this.
class OfflineLibraryMarker {
  /// When the list being shown was saved, or null when it is the server's.
  DateTime? savedAt;
}

final offlineLibraryMarkerProvider = Provider<OfflineLibraryMarker>(
  (ref) => OfflineLibraryMarker(),
);

/// A book's offline descriptor, for the reader when the server is out of
/// reach.
final offlineBookStatusProvider = FutureProvider.autoDispose
    .family<OfflineBookStatus?, String>(
      (ref, projectId) =>
          ref.watch(offlineLibraryStoreProvider).loadStatus(projectId),
    );
