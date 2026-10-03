import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

typedef FatalErrorRecorder =
    Future<void> Function(Object error, StackTrace stack);

/// Firebase remains optional for local builds without native configuration.
/// Collection is on in release builds; opt in during a diagnostic debug run
/// with --dart-define=CRASHLYTICS_ENABLED=true.
Future<void> initializeCrashReporting() async {
  if (kIsWeb ||
      (defaultTargetPlatform != TargetPlatform.android &&
          defaultTargetPlatform != TargetPlatform.iOS)) {
    return;
  }
  try {
    if (Firebase.apps.isEmpty) await Firebase.initializeApp();
    final crashlytics = FirebaseCrashlytics.instance;
    const enabled = bool.fromEnvironment(
      'CRASHLYTICS_ENABLED',
      defaultValue: kReleaseMode,
    );
    await crashlytics.setCrashlyticsCollectionEnabled(enabled);
    if (!enabled) return;

    installCrashHandlers(
      recordError: (error, stack) => crashlytics.recordError(
        error,
        stack,
        fatal: true,
        printDetails: false,
      ),
    );
    await crashlytics.setCustomKey(
      'app_environment',
      const String.fromEnvironment(
        'APP_ENV',
        defaultValue: kReleaseMode ? 'production' : 'local',
      ),
    );
  } catch (error) {
    // A missing config or unavailable reporting service must not block launch.
    debugPrint('Crash reporting could not start: $error');
  }
}

/// Keep Flutter's existing error presentation, and report both framework
/// failures and uncaught async errors outside the framework. Reporter failures
/// are consumed so they cannot recursively become new crash reports.
void installCrashHandlers({required FatalErrorRecorder recordError}) {
  final presentError = FlutterError.onError ?? FlutterError.presentError;
  FlutterError.onError = (details) {
    presentError(details);
    unawaited(
      _recordSafely(
        recordError,
        details.exception,
        details.stack ?? StackTrace.current,
      ),
    );
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    unawaited(_recordSafely(recordError, error, stack));
    return true;
  };
}

Future<void> _recordSafely(
  FatalErrorRecorder recordError,
  Object error,
  StackTrace stack,
) async {
  try {
    await recordError(error, stack);
  } catch (reportingError) {
    debugPrint('Crash report could not be recorded: $reportingError');
  }
}
