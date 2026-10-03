// A separate entry point for verifying Firebase delivery without signing in or
// loading any books. It is never imported by the production app.
import 'dart:async';
import 'dart:io';

import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:tomeza/shared/diagnostics/crash_reporting.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await initializeCrashReporting();
  runApp(
    const MaterialApp(
      home: Scaffold(body: Center(child: Text('Crashlytics verification'))),
    ),
  );
  final crashlytics = FirebaseCrashlytics.instance;
  if (!crashlytics.isCrashlyticsCollectionEnabled) {
    throw StateError('Run with --dart-define=CRASHLYTICS_ENABLED=true');
  }
  await crashlytics.setCustomKey('verification_run', true);

  // Crash natively once per install. Relaunching uploads the native report,
  // then exercises both Dart error paths without crashing again.
  final directory = await getApplicationSupportDirectory();
  final marker = File('${directory.path}/crashlytics_smoke_completed');
  if (!await marker.exists()) {
    await marker.writeAsString('native crash requested');
    await Future<void>.delayed(const Duration(seconds: 3));
    crashlytics.crash();
    return;
  }

  FlutterError.reportError(
    FlutterErrorDetails(
      exception: StateError(
        'Tomeza Crashlytics verification: Flutter framework',
      ),
      stack: StackTrace.current,
      library: 'Crashlytics verification',
    ),
  );
  unawaited(
    Future<void>.delayed(const Duration(seconds: 2), () {
      throw StateError('Tomeza Crashlytics verification: uncaught async');
    }),
  );
}
