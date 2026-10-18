import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/api/api_client.dart';
import '../../../shared/storage/app_files.dart';
import '../domain/app_update.dart';

/// Never throws: a build the platform cannot name is one the server never gates.
Future<AppBuild?> readAppBuild() async {
  try {
    final info = await PackageInfo.fromPlatform();
    return AppBuild.parse(info.buildNumber, platform: currentAppPlatform());
  } catch (_) {
    return null;
  }
}

abstract interface class AppUpdateRepository {
  Future<AppUpdateStatus> check();
}

class ApiAppUpdateRepository implements AppUpdateRepository {
  ApiAppUpdateRepository(this._api);

  final ApiClient _api;

  @override
  Future<AppUpdateStatus> check() async {
    // Public: a signed-out build has to be told too.
    final body = await _api.getMap(
      '/api/mobile/app-update',
      requiresAuth: false,
    );
    return AppUpdateStatus.fromJson(body['update']);
  }
}

/// Null when this install has no build to name: the server would answer
/// "nothing" to a request without one, so there is nothing to ask.
final appUpdateRepositoryProvider = Provider<AppUpdateRepository?>((ref) {
  if (ref.watch(appBuildProvider) == null) return null;
  return ApiAppUpdateRepository(ref.watch(apiClientProvider));
});

final appUpdateCheckerProvider = Provider<AppUpdateChecker>(
  AppUpdateChecker.new,
);

/// Asks the server about this build and writes the answer to
/// [appUpdateStatusProvider].
class AppUpdateChecker {
  AppUpdateChecker(this._ref);

  final Ref _ref;
  DateTime? _checkedAt;
  Future<void>? _inFlight;

  /// [ifOlderThan] skips a check made more recently than that. Never throws: a
  /// failed check leaves the last answer standing, and a required build is
  /// still caught by the 426 on its next request.
  Future<void> refresh({Duration? ifOlderThan}) {
    final checkedAt = _checkedAt;
    if (ifOlderThan != null &&
        checkedAt != null &&
        DateTime.now().difference(checkedAt) < ifOlderThan) {
      return Future.value();
    }
    return _inFlight ??= _check().whenComplete(() => _inFlight = null);
  }

  Future<void> _check() async {
    final repository = _ref.read(appUpdateRepositoryProvider);
    if (repository == null) return;
    try {
      final status = await repository.check();
      _checkedAt = DateTime.now();
      _ref.read(appUpdateStatusProvider.notifier).update(status);
    } catch (_) {
      // See the doc comment on [refresh].
    }
  }
}

/// Remembers the newest build the "update available" prompt was shown for,
/// so each release asks once.
abstract interface class AppUpdatePromptStore {
  Future<int?> lastPromptedBuild();
  Future<void> recordPrompted(int build);
}

/// A JSON file in the app documents directory, like the appearance store.
class FileAppUpdatePromptStore implements AppUpdatePromptStore {
  Directory? _resolved;

  static const directoryName = 'tomeza_app_update';
  static const filename = 'prompt.json';

  /// Never throws: an unreadable record asks again, which is the safe mistake.
  @override
  Future<int?> lastPromptedBuild() async {
    try {
      final file = await _file();
      if (!await file.exists()) return null;
      final json = jsonDecode(await file.readAsString());
      final build = json is Map ? json['build'] : null;
      return build is int ? build : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> recordPrompted(int build) async {
    try {
      final file = await _file();
      await file.writeAsString(jsonEncode({'build': build}));
    } catch (_) {
      // Failing to remember costs one more prompt next launch, nothing more.
    }
  }

  Future<File> _file() async {
    final root = _resolved ??= await getApplicationDocumentsDirectory();
    final directory = appDirectory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return appFile('${directory.path}/$filename');
  }
}

class MemoryAppUpdatePromptStore implements AppUpdatePromptStore {
  MemoryAppUpdatePromptStore([this._build]);

  int? _build;

  @override
  Future<int?> lastPromptedBuild() async => _build;

  @override
  Future<void> recordPrompted(int build) async => _build = build;
}

final appUpdatePromptStoreProvider = Provider<AppUpdatePromptStore>((ref) {
  return FileAppUpdatePromptStore();
});

/// Opens this app's store page, where the reader taps Update. False where
/// there is no store page to open — iOS until it ships, the web build.
typedef StoreListingOpener = Future<bool> Function();

final storeListingOpenerProvider = Provider<StoreListingOpener>((ref) {
  return openStoreListing;
});

Future<bool> openStoreListing() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return false;
  // `market://` opens the Play Store app directly; the web address is for a
  // phone that has no handler for it.
  for (final uri in [
    Uri.parse('market://details?id=$androidPackageName'),
    Uri.parse(
      'https://play.google.com/store/apps/details?id=$androidPackageName',
    ),
  ]) {
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        return true;
      }
    } catch (_) {
      // Try the next address.
    }
  }
  return false;
}
