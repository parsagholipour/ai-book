import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

/// The "Make a book like this" link a reader opened before they could use it.
///
/// A signed-out reader who taps the button on a shared page lands on the sign
/// in screen, and the link they came in on is gone the moment the router sends
/// them there. This holds its slug until the remix screen opens, so signing in
/// or creating an account ends in the chat they asked for rather than at home.
///
/// A plain object rather than provider state on purpose: the router's
/// `redirect` both reads and records it, synchronously, and a redirect is no
/// place to change a provider. It is also written to a file, so an app the
/// system killed while the reader was fetching a password-reset code still
/// knows where they were going — for [maxAge], and no longer, so a link opened
/// and abandoned does not ambush a launch days later.
class PendingRemix {
  PendingRemix(this._store) {
    unawaited(_restore());
  }

  final PendingRemixStore _store;
  String? _slug;

  /// Set once anything has decided the slug in this run, so a saved one that
  /// finishes loading afterwards cannot override it.
  bool _decided = false;

  static const maxAge = Duration(hours: 1);

  /// The slug waiting for the reader to be able to open it.
  String? get slug => _slug;

  void remember(String slug) {
    _decided = true;
    if (_slug == slug) return;
    _slug = slug;
    unawaited(_store.save(PendingRemixRecord(slug, DateTime.now())));
  }

  /// Called by the remix screen once it is open: the slug has arrived.
  void clear() {
    _decided = true;
    if (_slug == null) return;
    _slug = null;
    unawaited(_store.save(null));
  }

  Future<void> _restore() async {
    final saved = await _store.load();
    if (_decided || saved == null) return;
    if (DateTime.now().difference(saved.savedAt) > maxAge) {
      unawaited(_store.save(null));
      return;
    }
    _slug = saved.slug;
  }
}

class PendingRemixRecord {
  const PendingRemixRecord(this.slug, this.savedAt);

  final String slug;
  final DateTime savedAt;
}

abstract interface class PendingRemixStore {
  Future<PendingRemixRecord?> load();

  /// Null forgets the pending link.
  Future<void> save(PendingRemixRecord? record);
}

/// The pending link as a JSON file beside the app's other small stores.
class FilePendingRemixStore implements PendingRemixStore {
  FilePendingRemixStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_sharing';
  static const filename = 'pending_remix.json';

  /// Never throws: a pending link the app cannot read is one it forgot, which
  /// costs the reader a trip through the home screen and nothing else.
  @override
  Future<PendingRemixRecord?> load() async {
    try {
      final file = await _file();
      if (!await file.exists()) return null;
      final json = jsonDecode(await file.readAsString());
      if (json is! Map<String, dynamic>) return null;
      final slug = json['slug'];
      final savedAt = DateTime.tryParse(json['savedAt'] as String? ?? '');
      if (slug is! String || slug.isEmpty || savedAt == null) return null;
      return PendingRemixRecord(slug, savedAt);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> save(PendingRemixRecord? record) async {
    try {
      final file = await _file();
      if (record == null) {
        if (await file.exists()) await file.delete();
        return;
      }
      await file.writeAsString(
        jsonEncode({
          'slug': record.slug,
          'savedAt': record.savedAt.toIso8601String(),
        }),
      );
    } catch (_) {
      // Ignored deliberately — see [load].
    }
  }

  Future<File> _file() async {
    final root =
        _override ?? (_resolved ??= await getApplicationDocumentsDirectory());
    final directory = Directory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return File('${directory.path}/$filename');
  }
}

class MemoryPendingRemixStore implements PendingRemixStore {
  MemoryPendingRemixStore([this.record]);

  PendingRemixRecord? record;

  @override
  Future<PendingRemixRecord?> load() async => record;

  @override
  Future<void> save(PendingRemixRecord? record) async {
    this.record = record;
  }
}

final pendingRemixStoreProvider = Provider<PendingRemixStore>((ref) {
  return FilePendingRemixStore();
});

final pendingRemixProvider = Provider<PendingRemix>((ref) {
  return PendingRemix(ref.watch(pendingRemixStoreProvider));
});
