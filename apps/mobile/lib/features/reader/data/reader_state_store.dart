import 'dart:convert';
import 'dart:io';

import '../domain/reader_models.dart';
import 'reader_storage.dart';

/// Reading position and bookmarks, stored as JSON on the device.
///
/// Deliberately local: reading state is cheap to lose, not worth a schema
/// change and a round trip on every page turn, and works offline. If it ever
/// needs to follow a user across devices, this is the seam to move server-side.
class ReaderStateStore {
  ReaderStateStore({required this.storage});

  final ReaderStorage storage;

  static const _filename = 'state.json';

  Future<ReaderState> load(String projectId) async {
    final file = await _file(projectId);
    if (!await file.exists()) {
      return const ReaderState();
    }
    try {
      final json = jsonDecode(await file.readAsString());
      if (json is! Map<String, dynamic>) {
        return const ReaderState();
      }
      return ReaderState.fromJson(json);
    } on FormatException {
      // A corrupt file is not worth surfacing — the reader just starts over.
      return const ReaderState();
    }
  }

  /// Written through a temporary file, for the same reason the markup store is:
  /// a process killed mid-write would otherwise leave a truncated file, and
  /// [load] reads a `FormatException` as "start over" — which drops every
  /// bookmark the reader made, not just the page they were on.
  Future<void> save(String projectId, ReaderState state) async {
    final file = await _file(projectId);
    final partial = File('${file.path}.part');
    await partial.writeAsString(jsonEncode(state.toJson()), flush: true);
    await partial.rename(file.path);
  }

  Future<File> _file(String projectId) async {
    final directory = await storage.projectDirectory(projectId);
    return File('${directory.path}/$_filename');
  }
}
