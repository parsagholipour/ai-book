import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// The line under Log out, or null when the platform cannot name this build.
///
/// Widget tests do not register the plugin, so a missing read hides the
/// footer rather than failing the page.
final appVersionProvider = FutureProvider<String?>((ref) async {
  try {
    final info = await PackageInfo.fromPlatform();
    return 'Tomeza ${info.version} (${info.buildNumber})';
  } catch (_) {
    return null;
  }
});
