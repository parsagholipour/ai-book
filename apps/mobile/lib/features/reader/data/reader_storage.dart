import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Where the reader keeps per-book files on the device.
///
/// Separate from `tomeza_exports/`, which backs the share/open-elsewhere path:
/// that directory is a scratch area for handing a file to another app, while
/// this one is a cache the reader reuses across launches.
class ReaderStorage {
  ReaderStorage({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_reader';

  /// Strips anything that cannot appear in a path segment.
  ///
  /// Project ids are cuids today, but a value that reaches the filesystem is
  /// never trusted to stay that way.
  static String safeSegment(String value) {
    final safe = value.replaceAll(RegExp(r'[^A-Za-z0-9._-]+'), '-');
    return safe.isEmpty ? 'unknown' : safe;
  }

  Future<Directory> _root() async {
    final override = _override;
    if (override != null) {
      return override;
    }
    return _resolved ??= await getApplicationDocumentsDirectory();
  }

  /// The directory holding files that belong to the reader rather than to any
  /// one book — preferences that follow the reader between titles.
  Future<Directory> rootDirectory() async {
    final root = await _root();
    final directory = Directory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return directory;
  }

  /// The directory holding one project's reader files, created if absent.
  Future<Directory> projectDirectory(String projectId) async {
    final root = await _root();
    final directory = Directory(
      '${root.path}/$directoryName/${safeSegment(projectId)}',
    );
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return directory;
  }

  /// Removes every reader file for a project. Used when a book is deleted.
  Future<void> clearProject(String projectId) async {
    final root = await _root();
    final directory = Directory(
      '${root.path}/$directoryName/${safeSegment(projectId)}',
    );
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }
}
