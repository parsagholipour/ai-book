import 'dart:convert';
import 'dart:io';

import '../domain/reader_settings.dart';
import 'reader_storage.dart';

/// Reader preferences, stored once for every book.
///
/// Sits at the root of the reader's storage rather than inside a project
/// directory: the tint someone reads at night is about them, not about the
/// title they happen to have open, and deleting a book must not reset it.
class ReaderSettingsStore {
  ReaderSettingsStore({required this.storage});

  final ReaderStorage storage;

  static const _filename = 'settings.json';

  Future<ReaderSettings> load() async {
    final file = await _file();
    if (!await file.exists()) {
      return const ReaderSettings();
    }
    try {
      final json = jsonDecode(await file.readAsString());
      if (json is! Map<String, dynamic>) {
        return const ReaderSettings();
      }
      return ReaderSettings.fromJson(json);
    } on FormatException {
      return const ReaderSettings();
    }
  }

  Future<void> save(ReaderSettings settings) async {
    final file = await _file();
    await file.writeAsString(jsonEncode(settings.toJson()));
  }

  Future<File> _file() async {
    final directory = await storage.rootDirectory();
    return File('${directory.path}/$_filename');
  }
}
