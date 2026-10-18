import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_client.dart';
import '../../../shared/api/api_error.dart';
import '../../../shared/storage/app_files.dart';
import '../domain/install_attribution.dart';
import 'install_referrer_source.dart';

/// Where this install came from, read once and remembered for good.
///
/// On the first home screen after an install it asks Play for the install
/// referrer, tells the operator's growth funnel where the install came from
/// (`install_attributed`, once, from whichever account is signed in — the
/// first touch), and, when the install came through a shared book's page,
/// hands that share's slug out exactly once so the home screen can offer the
/// remix the reader went to Play for. Everything is written to a file, so a
/// relaunch neither reads Play again nor offers the remix twice.
///
/// Nothing here may fail or hold the app: every step that fails is skipped,
/// and Play is asked at most [maxAttempts] times in total.
class InstallAttributionTracker {
  InstallAttributionTracker({
    required this._source,
    required this._store,
    required this._report,
  });

  /// Play's referrer service can be briefly unreachable after an update of
  /// the Play Store itself; a few launches are worth one more question each.
  static const maxAttempts = 3;

  final InstallReferrerSource _source;
  final InstallAttributionStore _store;

  /// True once the event is delivered, or refused for good; false to retry on
  /// a later visit.
  final Future<bool> Function(InstallAttribution attribution) _report;

  Future<void>? _loading;
  InstallAttributionRecord _record = const InstallAttributionRecord();
  Future<void> _saving = Future.value();
  var _reporting = false;

  /// What is known about this install, asking Play first if it never has.
  Future<InstallAttributionRecord> resolve() async {
    await (_loading ??= _load());
    return _record;
  }

  /// Sends the install's attribution once per install. Call it only with a
  /// session, since the event belongs to the account that is signed in.
  Future<void> reportIfNeeded() async {
    await resolve();
    final attribution = _record.attribution;
    if (attribution == null || _record.reported || _reporting) return;
    _reporting = true;
    try {
      if (!await _report(attribution)) return;
      _record = _record.copyWith(reported: true);
      await _persist();
    } finally {
      _reporting = false;
    }
  }

  /// The share this install came from, the first time it is asked for, and
  /// null ever after — the offer is shown once whatever the reader answers.
  Future<String?> takeRemixOffer() async {
    await resolve();
    final slug = _record.attribution?.shareSlug;
    if (slug == null || _record.remixOffered) return null;
    _record = _record.copyWith(remixOffered: true);
    await _persist();
    return slug;
  }

  Future<void> _load() async {
    final saved = await _store.load();
    if (saved != null) _record = saved;
    if (_record.settled || _record.attempts >= maxAttempts) return;
    final answer = await _source.read();
    final attempts = _record.attempts + 1;
    _record = switch (answer) {
      InstallReferrerFound(:final referrer) => InstallAttributionRecord(
        attempts: attempts,
        settled: true,
        attribution: parseInstallReferrer(referrer),
      ),
      InstallReferrerNone() => InstallAttributionRecord(
        attempts: attempts,
        settled: true,
      ),
      InstallReferrerUnavailable() => _record.copyWith(attempts: attempts),
    };
    await _persist();
  }

  /// Writes one after another, each the record as it stood when asked.
  Future<void> _persist() {
    final snapshot = _record;
    return _saving = _saving.then((_) => _store.save(snapshot));
  }
}

class InstallAttributionRecord {
  const InstallAttributionRecord({
    this.attempts = 0,
    this.settled = false,
    this.attribution,
    this.reported = false,
    this.remixOffered = false,
  });

  /// How many times Play has been asked.
  final int attempts;

  /// Play has answered for good, with a referrer or with none.
  final bool settled;
  final InstallAttribution? attribution;
  final bool reported;
  final bool remixOffered;

  InstallAttributionRecord copyWith({
    int? attempts,
    bool? reported,
    bool? remixOffered,
  }) {
    return InstallAttributionRecord(
      attempts: attempts ?? this.attempts,
      settled: settled,
      attribution: attribution,
      reported: reported ?? this.reported,
      remixOffered: remixOffered ?? this.remixOffered,
    );
  }

  Map<String, Object?> toJson() => {
    'attempts': attempts,
    'settled': settled,
    'attribution': attribution?.toJson(),
    'reported': reported,
    'remixOffered': remixOffered,
  };

  static InstallAttributionRecord? fromJson(Object? json) {
    if (json is! Map) return null;
    final attempts = json['attempts'];
    return InstallAttributionRecord(
      attempts: attempts is int && attempts >= 0 ? attempts : 0,
      settled: json['settled'] == true,
      attribution: InstallAttribution.fromJson(json['attribution']),
      reported: json['reported'] == true,
      remixOffered: json['remixOffered'] == true,
    );
  }
}

abstract interface class InstallAttributionStore {
  /// Never throws: a record that cannot be read is one never written.
  Future<InstallAttributionRecord?> load();

  /// Never throws.
  Future<void> save(InstallAttributionRecord record);
}

/// A JSON file beside the app's other small stores.
class FileInstallAttributionStore implements InstallAttributionStore {
  FileInstallAttributionStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_attribution';
  static const filename = 'install_referrer.json';

  @override
  Future<InstallAttributionRecord?> load() async {
    try {
      final file = await _file();
      if (!await file.exists()) return null;
      return InstallAttributionRecord.fromJson(
        jsonDecode(await file.readAsString()),
      );
    } on Object {
      return null;
    }
  }

  @override
  Future<void> save(InstallAttributionRecord record) async {
    try {
      final file = await _file();
      await file.writeAsString(jsonEncode(record.toJson()));
    } on Object {
      // Forgotten, the record is read again next launch: Play is asked once
      // more and an unsent event is sent again. Nothing worse.
    }
  }

  Future<File> _file() async {
    final root =
        _override ?? (_resolved ??= await getApplicationDocumentsDirectory());
    final directory = appDirectory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return appFile('${directory.path}/$filename');
  }
}

class MemoryInstallAttributionStore implements InstallAttributionStore {
  MemoryInstallAttributionStore([this.record]);

  InstallAttributionRecord? record;
  var saves = 0;

  @override
  Future<InstallAttributionRecord?> load() async => record;

  @override
  Future<void> save(InstallAttributionRecord record) async {
    saves += 1;
    this.record = record;
  }
}

/// Posts `install_attributed`. True when the server took it, or refused it
/// outright (a 400 would only be refused again); false to try on a later visit.
Future<bool> sendInstallAttribution(
  ApiClient client,
  InstallAttribution attribution,
) async {
  try {
    await client.postMap('/api/mobile/events', data: attribution.toEventJson());
    return true;
  } on ApiException catch (error) {
    return error.statusCode == 400;
  } on Object {
    return false;
  }
}

final installReferrerSourceProvider = Provider<InstallReferrerSource>((ref) {
  return const PlatformInstallReferrerSource();
});

final installAttributionStoreProvider = Provider<InstallAttributionStore>((
  ref,
) {
  return FileInstallAttributionStore();
});

final installAttributionProvider = Provider<InstallAttributionTracker>((ref) {
  return InstallAttributionTracker(
    source: ref.watch(installReferrerSourceProvider),
    store: ref.watch(installAttributionStoreProvider),
    report: (attribution) async {
      try {
        return await sendInstallAttribution(
          ref.read(apiClientProvider),
          attribution,
        );
      } on Object {
        return false;
      }
    },
  );
});
