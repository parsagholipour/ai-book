import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import 'audiobook_cache.dart';

/// How far into a book a listener got, and which narration they got there in.
///
/// The narration id is the whole point. Re-narrating a book produces different
/// audio of different lengths, so a position measured against the old one
/// would land somewhere plausible and wrong rather than obviously broken.
class AudiobookListeningPosition {
  const AudiobookListeningPosition({
    required this.audiobookId,
    required this.positionMs,
    required this.updatedAt,
  });

  final String audiobookId;

  /// Position in the whole book, not in a chapter file — the chapter a book
  /// position falls in changes as later chapters are narrated, the book
  /// position does not.
  final int positionMs;
  final DateTime updatedAt;

  Map<String, dynamic> toJson() => {
    'audiobookId': audiobookId,
    'positionMs': positionMs,
    'updatedAt': updatedAt.toUtc().toIso8601String(),
  };

  /// Null for anything that cannot be trusted to point at real audio.
  static AudiobookListeningPosition? tryParse(Map<String, dynamic> json) {
    final audiobookId = json['audiobookId'];
    final positionMs = json['positionMs'];
    if (audiobookId is! String || audiobookId.isEmpty || positionMs is! num) {
      return null;
    }
    final updatedAt = json['updatedAt'];
    return AudiobookListeningPosition(
      audiobookId: audiobookId,
      positionMs: positionMs.round().clamp(0, 1 << 40),
      updatedAt:
          (updatedAt is String ? DateTime.tryParse(updatedAt) : null) ??
          DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

/// Where the listener left off, stored as JSON on the device.
///
/// Deliberately local, for the same reasons as the reader's bookmarks: it is
/// cheap to lose, means nothing on a device that has not downloaded the audio,
/// and has to be writable with the screen off and the phone offline. It sits
/// under the project rather than under one narration, so
/// [AudiobookCache.pruneOtherAudiobooks] — which only removes directories —
/// leaves it alone, while deleting the book takes it along with the audio.
class AudiobookProgressStore {
  AudiobookProgressStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const _filename = 'progress.json';

  /// Serialises writes. Position is saved on a timer while the app may be
  /// killed at any moment, so two writes overlapping is an ordinary event
  /// rather than a corner case.
  Future<void> _writes = Future<void>.value();

  Future<AudiobookListeningPosition?> load(String projectId) async {
    final file = await _file(projectId);
    if (!await file.exists()) {
      return null;
    }
    try {
      final json = jsonDecode(await file.readAsString());
      return json is Map<String, dynamic>
          ? AudiobookListeningPosition.tryParse(json)
          : null;
    } on FormatException {
      // A corrupt file just means starting the book over, which is not worth
      // telling anyone about.
      return null;
    }
  }

  Future<void> save(String projectId, AudiobookListeningPosition position) {
    return _writes = _afterPendingWrites(() => _write(projectId, position));
  }

  Future<void> clear(String projectId) {
    return _writes = _afterPendingWrites(() async {
      final file = await _file(projectId);
      if (await file.exists()) {
        await file.delete();
      }
    });
  }

  /// Queues [action] behind whatever write is in flight, swallowing the
  /// predecessor's failure first — chaining straight onto a rejected future
  /// once left every later save rejecting without ever touching the disk.
  /// Each caller still sees its own action's result.
  Future<void> _afterPendingWrites(Future<void> Function() action) {
    return _writes.catchError((_) {}).then((_) => action());
  }

  /// Writes through a `.part` file and renames, so being killed mid-save costs
  /// the last five seconds rather than the whole position.
  Future<void> _write(
    String projectId,
    AudiobookListeningPosition position,
  ) async {
    final file = await _file(projectId);
    await file.parent.create(recursive: true);
    final partial = File('${file.path}.part');
    await partial.writeAsString(jsonEncode(position.toJson()), flush: true);
    await partial.rename(file.path);
  }

  Future<Directory> _root() async {
    final override = _override;
    if (override != null) {
      return override;
    }
    return _resolved ??= await getApplicationDocumentsDirectory();
  }

  Future<File> _file(String projectId) async {
    final root = await _root();
    return File(
      '${root.path}/${AudiobookCache.directoryName}'
      '/${AudiobookCache.safeSegment(projectId)}/$_filename',
    );
  }
}

final audiobookProgressStoreProvider = Provider<AudiobookProgressStore>(
  (ref) => AudiobookProgressStore(),
);
