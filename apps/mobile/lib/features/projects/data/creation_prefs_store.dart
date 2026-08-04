import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../domain/creation_prefs.dart';

abstract interface class CreationPrefsStore {
  Future<CreationPrefs> load();
  Future<void> save(CreationPrefs prefs);
}

/// [CreationPrefs] as a JSON file in the app documents directory.
///
/// Same shape as the reader's `ReaderSettingsStore`, and for the same reason:
/// these are a handful of flags read once per build, so a file is enough and
/// keeps the app free of another storage dependency.
class FileCreationPrefsStore implements CreationPrefsStore {
  FileCreationPrefsStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_creation';
  static const _filename = 'prefs.json';

  /// Never throws. A preference the app failed to read is a preference at its
  /// default — it must not be able to block someone from building a book.
  @override
  Future<CreationPrefs> load() async {
    try {
      final file = await _file();
      if (!await file.exists()) {
        return const CreationPrefs();
      }
      final json = jsonDecode(await file.readAsString());
      if (json is! Map<String, dynamic>) {
        return const CreationPrefs();
      }
      return CreationPrefs.fromJson(json);
    } catch (_) {
      return const CreationPrefs();
    }
  }

  /// Also never throws: failing to remember "don't ask again" only costs the
  /// user the dialog again next time.
  @override
  Future<void> save(CreationPrefs prefs) async {
    try {
      final file = await _file();
      await file.writeAsString(jsonEncode(prefs.toJson()));
    } catch (_) {
      // Ignored deliberately — see the doc comment.
    }
  }

  Future<File> _file() async {
    final root =
        _override ?? (_resolved ??= await getApplicationDocumentsDirectory());
    final directory = Directory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return File('${directory.path}/$_filename');
  }
}

class MemoryCreationPrefsStore implements CreationPrefsStore {
  MemoryCreationPrefsStore([this._prefs = const CreationPrefs()]);

  CreationPrefs _prefs;

  @override
  Future<CreationPrefs> load() async => _prefs;

  @override
  Future<void> save(CreationPrefs prefs) async {
    _prefs = prefs;
  }
}

final creationPrefsStoreProvider = Provider<CreationPrefsStore>((ref) {
  return FileCreationPrefsStore();
});
