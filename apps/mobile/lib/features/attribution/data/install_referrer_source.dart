import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// What asking Play for the install referrer came to.
sealed class InstallReferrerAnswer {
  const InstallReferrerAnswer();
}

/// Play answered with the referrer this install was started with.
final class InstallReferrerFound extends InstallReferrerAnswer {
  const InstallReferrerFound(this.referrer);

  final String referrer;
}

/// There is nothing to read, and asking again will not change that: not
/// Android, no Play Store, or an install that carried no referrer.
final class InstallReferrerNone extends InstallReferrerAnswer {
  const InstallReferrerNone();
}

/// The Play service could not be reached this time.
final class InstallReferrerUnavailable extends InstallReferrerAnswer {
  const InstallReferrerUnavailable();
}

abstract interface class InstallReferrerSource {
  /// Never throws.
  Future<InstallReferrerAnswer> read();
}

/// The Play Install Referrer API, through `InstallReferrer.kt`.
class PlatformInstallReferrerSource implements InstallReferrerSource {
  const PlatformInstallReferrerSource({
    this._channel = const MethodChannel('tomeza/install_referrer'),
  });

  final MethodChannel _channel;

  /// The Play service answers in well under a second; a connection that never
  /// calls back must not hold the home screen's offer forever.
  static const timeout = Duration(seconds: 10);

  @override
  Future<InstallReferrerAnswer> read() async {
    if (kIsWeb || !Platform.isAndroid) return const InstallReferrerNone();
    try {
      final answer = await _channel
          .invokeMapMethod<String, Object?>('read')
          .timeout(timeout);
      switch (answer?['status']) {
        case 'ok':
          final referrer = answer?['referrer'];
          return referrer is String && referrer.trim().isNotEmpty
              ? InstallReferrerFound(referrer)
              : const InstallReferrerNone();
        case 'unsupported':
          return const InstallReferrerNone();
        default:
          return const InstallReferrerUnavailable();
      }
    } on MissingPluginException {
      return const InstallReferrerNone();
    } on Object {
      return const InstallReferrerUnavailable();
    }
  }
}
