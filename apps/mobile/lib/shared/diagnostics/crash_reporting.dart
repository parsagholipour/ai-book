import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/foundation.dart';

/// Sends one error to the crash service. [fatal] is true only for an error
/// nothing caught.
typedef CrashRecorder =
    Future<void> Function(
      Object error,
      StackTrace stack, {
      required bool fatal,
    });

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
      recordError: (error, stack, {required fatal}) => crashlytics.recordError(
        error,
        stack,
        fatal: fatal,
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
///
/// Only the second is fatal. An error that reaches [FlutterError.onError] was
/// caught — by the framework around a build, layout or paint, or by app code
/// handing a handled failure to [FlutterError.reportError] — and the app went
/// on running, so counting it as a crash made the crash-free rate a measure of
/// warnings. An error that reaches [PlatformDispatcher.onError] escaped every
/// handler, and that is the one Crashlytics should count.
void installCrashHandlers({required CrashRecorder recordError}) {
  final presentError = FlutterError.onError ?? FlutterError.presentError;
  FlutterError.onError = (details) {
    presentError(details);
    unawaited(
      _recordSafely(
        recordError,
        details.exception,
        details.stack ?? StackTrace.current,
        fatal: false,
      ),
    );
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    unawaited(_recordSafely(recordError, error, stack, fatal: true));
    return true;
  };
}

Future<void> _recordSafely(
  CrashRecorder recordError,
  Object error,
  StackTrace stack, {
  required bool fatal,
}) async {
  try {
    await recordError(error, stack, fatal: fatal);
  } catch (reportingError) {
    debugPrint('Crash report could not be recorded: $reportingError');
  }
}

/// Reports a failure the app survives but a person should hear about — a
/// feature that switched itself off. Silent when Firebase never started (a
/// local build) or collection is off; never throws.
Future<void> reportNonFatal(Object error, StackTrace stack) async {
  try {
    if (Firebase.apps.isEmpty) return;
    await FirebaseCrashlytics.instance.recordError(
      error,
      stack,
      fatal: false,
      printDetails: false,
    );
  } catch (reportingError) {
    debugPrint('Non-fatal report could not be recorded: $reportingError');
  }
}
