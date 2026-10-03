import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What the server asks of this build.
///
/// The operator records each store release with a policy for older builds —
/// silent, prompt or required — and the server reduces them to one answer for
/// the build asking (`decideAppUpdate` in apps/api/src/appUpdates.ts). A silent
/// release reaches the app as [none]: the store's own auto-update handles it.
enum AppUpdateAction {
  none,
  prompt,
  required;

  /// An action this build does not know is treated as no update: a newer server
  /// must not be able to lock an older app out by adding a word.
  static AppUpdateAction fromWire(Object? value) => switch (value) {
    'prompt' => prompt,
    'required' => required,
    _ => none,
  };
}

@immutable
class AppUpdateStatus {
  const AppUpdateStatus({
    required this.action,
    this.latestBuild,
    this.latestVersion,
    this.message,
  });

  static const none = AppUpdateStatus(action: AppUpdateAction.none);

  /// Reads the `update` object the check route and the 426 body both carry.
  factory AppUpdateStatus.fromJson(Object? json) {
    if (json is! Map) return none;
    final latestBuild = json['latestBuild'];
    final latestVersion = json['latestVersion'];
    final message = json['message'];
    return AppUpdateStatus(
      action: AppUpdateAction.fromWire(json['action']),
      latestBuild: latestBuild is int ? latestBuild : null,
      latestVersion: latestVersion is String && latestVersion.trim().isNotEmpty
          ? latestVersion.trim()
          : null,
      message: message is String && message.trim().isNotEmpty
          ? message.trim()
          : null,
    );
  }

  final AppUpdateAction action;

  /// The newest build the store has for this platform, when anything is asked.
  final int? latestBuild;

  /// Its version name, e.g. "1.2.0".
  final String? latestVersion;

  /// The operator's note for readers, if the deciding release has one.
  final String? message;

  bool get isRequired => action == AppUpdateAction.required;

  @override
  bool operator ==(Object other) =>
      other is AppUpdateStatus &&
      other.action == action &&
      other.latestBuild == latestBuild &&
      other.latestVersion == latestVersion &&
      other.message == message;

  @override
  int get hashCode => Object.hash(action, latestBuild, latestVersion, message);
}

/// This install as the server knows it. Every request carries [headers], which
/// is what lets the server turn away a build it has retired even when the
/// launch check never ran.
@immutable
class AppBuild {
  const AppBuild({required this.build, required this.platform});

  /// [buildNumber] is `PackageInfo.buildNumber` — the Android `versionCode`,
  /// the `+N` in pubspec. Null when it is not a positive whole number, because
  /// a build the server cannot compare is one it must not gate.
  static AppBuild? parse(String buildNumber, {required String platform}) {
    final build = int.tryParse(buildNumber.trim());
    if (build == null || build < 1) return null;
    return AppBuild(build: build, platform: platform);
  }

  final int build;

  /// `android`, `ios`, `web` or `other`. The server only gates the first two.
  final String platform;

  Map<String, String> get headers => {
    'X-App-Build': '$build',
    'X-App-Platform': platform,
  };
}

String currentAppPlatform() {
  if (kIsWeb) return 'web';
  return switch (defaultTargetPlatform) {
    TargetPlatform.android => 'android',
    TargetPlatform.iOS => 'ios',
    _ => 'other',
  };
}

/// This install's build, read once in `main` before the first request and
/// overridden there. Null — the default, and every widget test — means no
/// build headers are sent and no update check is made.
final appBuildProvider = Provider<AppBuild?>((ref) => null);

/// What the server last said about this build. The router redirects to the
/// update screen while it is required; `AppUpdateChecker` keeps it current,
/// and a 426 from any request sets it directly (see `ApiClient`).
final appUpdateStatusProvider =
    NotifierProvider<AppUpdateStatusNotifier, AppUpdateStatus>(
      AppUpdateStatusNotifier.new,
    );

class AppUpdateStatusNotifier extends Notifier<AppUpdateStatus> {
  @override
  AppUpdateStatus build() => AppUpdateStatus.none;

  void update(AppUpdateStatus status) => state = status;

  /// A request was refused with 426. The body carries the same decision the
  /// check route would have given; without it, required is still the answer.
  void reportRequired(Map<String, dynamic> details) {
    final status = AppUpdateStatus.fromJson(details['update']);
    state = status.isRequired
        ? status
        : const AppUpdateStatus(action: AppUpdateAction.required);
  }
}
