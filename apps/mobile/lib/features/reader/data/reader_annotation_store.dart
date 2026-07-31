import 'dart:convert';
import 'dart:io';

import '../domain/reader_annotation.dart';
import 'reader_storage.dart';

/// A book's markup, stored as JSON on the device.
///
/// Kept in its own file rather than alongside the reading position in
/// `state.json`. That file is rewritten on a debounce every few page turns, and
/// ink is by far the heaviest thing the reader stores — pairing them would mean
/// rewriting every stroke in the book to record that someone scrolled.
///
/// Like the reading position this is deliberately local. If markup ever needs
/// to follow a user between devices, this class is the seam: the annotations
/// already carry ids, timestamps and deletion tombstones so a sync has
/// something to reconcile.
class ReaderAnnotationStore {
  ReaderAnnotationStore({required this.storage});

  final ReaderStorage storage;

  static const _filename = 'annotations.json';

  /// Every annotation for a book, tombstones included.
  ///
  /// Deleted entries are handed back rather than filtered here so a future sync
  /// can still see them; the reader itself skips them when drawing.
  Future<List<ReaderAnnotation>> load(String projectId) async {
    final file = await _file(projectId);
    if (!await file.exists()) {
      return const [];
    }
    try {
      final json = jsonDecode(await file.readAsString());
      if (json is! Map<String, dynamic>) {
        return const [];
      }
      final raw = json['annotations'];
      if (raw is! List) {
        return const [];
      }
      return raw
          .whereType<Map<String, dynamic>>()
          .map(ReaderAnnotation.fromJson)
          .whereType<ReaderAnnotation>()
          .toList();
    } on FormatException {
      // A corrupt file is not worth surfacing mid-read; the reader carries on
      // without the markup rather than refusing to open the book.
      return const [];
    }
  }

  Future<void> save(
    String projectId,
    List<ReaderAnnotation> annotations,
  ) async {
    final file = await _file(projectId);
    final payload = jsonEncode({
      'version': 1,
      'annotations': [
        for (final annotation in annotations) annotation.toJson(),
      ],
    });
    // Written through a temporary file: markup is the one thing in the reader's
    // storage the user made themselves, and a process killed mid-write would
    // otherwise leave a truncated file that parses as "no markup at all".
    final partial = File('${file.path}.part');
    await partial.writeAsString(payload, flush: true);
    await partial.rename(file.path);
  }

  Future<File> _file(String projectId) async {
    final directory = await storage.projectDirectory(projectId);
    return File('${directory.path}/$_filename');
  }
}
