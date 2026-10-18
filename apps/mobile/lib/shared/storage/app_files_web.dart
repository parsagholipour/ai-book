import 'dart:async';
import 'dart:convert';
import 'dart:io' show File, Directory;

import 'package:file/memory.dart';
import 'package:web/web.dart' as web;

// Binary downloads stay in the tab, never in localStorage. Small preferences,
// reader annotations and unsent studio drafts survive a browser reload. Auth
// tokens remain the responsibility of FlutterSecureStorage.
const _key = 'tomeza.files.v1';
bool _saving = false;
Timer? _save;
final _files = _createFiles();

MemoryFileSystem _createFiles() {
  final files = MemoryFileSystem(
    opHandle: (_, operation) {
      if (_saving ||
          operation == FileSystemOp.read ||
          operation == FileSystemOp.exists) {
        return;
      }
      _save ??= Timer(Duration.zero, _persist);
    },
  );
  files.directory('/documents').createSync();
  files.directory('/temporary').createSync();
  try {
    final raw = web.window.localStorage.getItem(_key);
    if (raw != null) {
      final saved = jsonDecode(raw) as Map<String, dynamic>;
      for (final entry in saved.entries) {
        if (!entry.key.startsWith('/documents/') ||
            !entry.key.endsWith('.json') ||
            entry.value is! String) {
          continue;
        }
        final file = files.file(entry.key);
        file.parent.createSync(recursive: true);
        file.writeAsStringSync(entry.value as String);
      }
    }
  } catch (_) {
    // Disabled/full browser storage must not prevent an online session.
  }
  return files;
}

void _persist() {
  _save = null;
  _saving = true;
  try {
    final saved = <String, String>{};
    for (final entry
        in _files.directory('/documents').listSync(recursive: true)) {
      if (entry is File && entry.path.endsWith('.json')) {
        saved[entry.path] = _files.file(entry.path).readAsStringSync();
      }
    }
    web.window.localStorage.setItem(_key, jsonEncode(saved));
  } catch (_) {
    // Browser quotas are best-effort, like the device's optional caches.
  } finally {
    _saving = false;
  }
}

File appFile(String path) => _files.file(path);
Directory appDirectory(String path) => _files.directory(path);
String get appPathSeparator => '/';
Future<Directory> getApplicationDocumentsDirectory() async =>
    _files.directory('/documents');
Future<Directory> getApplicationSupportDirectory() =>
    getApplicationDocumentsDirectory();
Future<Directory> getTemporaryDirectory() async =>
    _files.directory('/temporary');
