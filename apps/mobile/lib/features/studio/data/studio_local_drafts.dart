import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../domain/manuscript_models.dart';

/// One chapter's text as this device last had it, kept on disk until the
/// server has confirmed a save of it.
///
/// It is written *before* every network save, so a crash, a dead battery or a
/// lost connection never costs a word: the next time the chapter opens, the
/// buffer is compared with the server's copy (see `StudioSession`).
class StudioLocalDraft {
  const StudioLocalDraft({
    required this.projectId,
    required this.chapterId,
    required this.baseRevision,
    required this.title,
    required this.markdown,
    required this.notes,
    required this.savedAt,
    this.status,
  });

  final String projectId;
  final String chapterId;

  /// The server revision this text was edited from.
  final int baseRevision;
  final String title;
  final String markdown;
  final String notes;
  final ManuscriptChapterStatus? status;
  final DateTime savedAt;

  Map<String, Object?> toJson() => {
    'projectId': projectId,
    'chapterId': chapterId,
    'baseRevision': baseRevision,
    'title': title,
    'markdown': markdown,
    'notes': notes,
    'status': status?.wire,
    'savedAt': savedAt.toUtc().toIso8601String(),
  };

  static StudioLocalDraft? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final projectId = json['projectId'];
    final chapterId = json['chapterId'];
    final baseRevision = json['baseRevision'];
    final markdown = json['markdown'];
    if (projectId is! String ||
        chapterId is! String ||
        baseRevision is! int ||
        markdown is! String) {
      return null;
    }
    final status = json['status'];
    return StudioLocalDraft(
      projectId: projectId,
      chapterId: chapterId,
      baseRevision: baseRevision,
      title: json['title'] as String? ?? '',
      markdown: markdown,
      notes: json['notes'] as String? ?? '',
      status: status is String
          ? ManuscriptChapterStatus.fromWire(status)
          : null,
      savedAt:
          DateTime.tryParse(json['savedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }
}

/// Where chapter buffers live. The session only needs these three calls, so
/// tests hand it an in-memory store instead of the disk.
abstract interface class StudioLocalDrafts {
  Future<StudioLocalDraft?> read(String projectId, String chapterId);

  Future<void> write(StudioLocalDraft draft);

  Future<void> delete(String projectId, String chapterId);
}

/// Buffers as JSON files:
/// `<application support>/studio/<projectId>/<chapterId>.json`.
///
/// Each write goes to a temporary file first and is renamed over the old one,
/// so a crash mid-write leaves the previous buffer rather than half of one.
/// Unreadable or foreign files read as "no buffer"; a buffer is a safety net,
/// and a torn one must never stop a chapter from opening.
class FileStudioLocalDrafts implements StudioLocalDrafts {
  FileStudioLocalDrafts({Future<Directory> Function()? root})
    : _root = root ?? getApplicationSupportDirectory;

  final Future<Directory> Function() _root;

  Future<File> _file(String projectId, String chapterId) async {
    final root = await _root();
    return File(
      '${root.path}/studio/${_safe(projectId)}/${_safe(chapterId)}.json',
    );
  }

  @override
  Future<StudioLocalDraft?> read(String projectId, String chapterId) async {
    try {
      final file = await _file(projectId, chapterId);
      if (!await file.exists()) return null;
      final draft = StudioLocalDraft.fromJson(
        jsonDecode(await file.readAsString()),
      );
      if (draft == null ||
          draft.projectId != projectId ||
          draft.chapterId != chapterId) {
        return null;
      }
      return draft;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(StudioLocalDraft draft) async {
    final file = await _file(draft.projectId, draft.chapterId);
    await file.parent.create(recursive: true);
    final temp = File('${file.path}.tmp');
    await temp.writeAsString(jsonEncode(draft.toJson()), flush: true);
    await temp.rename(file.path);
  }

  @override
  Future<void> delete(String projectId, String chapterId) async {
    try {
      final file = await _file(projectId, chapterId);
      if (await file.exists()) await file.delete();
    } catch (_) {
      // Nothing to clean up is not a failure.
    }
  }

  /// Ids are server cuids; this only guards the path against anything else.
  static String _safe(String id) =>
      id.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
}

/// Keeps buffers in memory. For tests, and a fallback nobody else needs.
class MemoryStudioLocalDrafts implements StudioLocalDrafts {
  final Map<String, StudioLocalDraft> drafts = {};

  static String _key(String projectId, String chapterId) =>
      '$projectId/$chapterId';

  @override
  Future<StudioLocalDraft?> read(String projectId, String chapterId) async =>
      drafts[_key(projectId, chapterId)];

  @override
  Future<void> write(StudioLocalDraft draft) async {
    drafts[_key(draft.projectId, draft.chapterId)] = draft;
  }

  @override
  Future<void> delete(String projectId, String chapterId) async {
    drafts.remove(_key(projectId, chapterId));
  }
}

final studioLocalDraftsProvider = Provider<StudioLocalDrafts>(
  (ref) => FileStudioLocalDrafts(),
);
