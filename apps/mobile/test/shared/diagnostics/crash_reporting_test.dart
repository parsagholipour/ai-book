import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/shared/diagnostics/crash_reporting.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FlutterExceptionHandler? originalFlutterHandler;
  late ErrorCallback? originalPlatformHandler;

  setUp(() {
    originalFlutterHandler = FlutterError.onError;
    originalPlatformHandler = PlatformDispatcher.instance.onError;
  });

  tearDown(() {
    FlutterError.onError = originalFlutterHandler;
    PlatformDispatcher.instance.onError = originalPlatformHandler;
    debugDefaultTargetPlatformOverride = null;
  });

  test('framework failures retain presentation and their original stack', () {
    final presented = <FlutterErrorDetails>[];
    final recorded = <(Object, StackTrace)>[];
    FlutterError.onError = presented.add;
    installCrashHandlers(
      recordError: (error, stack) async => recorded.add((error, stack)),
    );
    final error = StateError('widget build failed');
    final stack = StackTrace.current;
    final details = FlutterErrorDetails(exception: error, stack: stack);

    FlutterError.reportError(details);

    expect(presented, [details]);
    expect(recorded, [(error, stack)]);
  });

  test('uncaught async failures are recorded and marked handled', () {
    final recorded = <(Object, StackTrace)>[];
    installCrashHandlers(
      recordError: (error, stack) async => recorded.add((error, stack)),
    );
    final error = StateError('unawaited operation failed');
    final stack = StackTrace.current;

    expect(PlatformDispatcher.instance.onError!(error, stack), isTrue);
    expect(recorded, [(error, stack)]);
  });

  test('a reporting failure does not escape and report itself again', () async {
    var calls = 0;
    installCrashHandlers(
      recordError: (error, stack) async {
        calls++;
        throw StateError('reporting service unavailable');
      },
    );

    PlatformDispatcher.instance.onError!(
      StateError('original'),
      StackTrace.current,
    );
    await Future<void>.delayed(Duration.zero);

    expect(calls, 1);
  });

  test('unsupported platforms preserve existing error handlers', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    await initializeCrashReporting();
    expect(FlutterError.onError, originalFlutterHandler);
    expect(PlatformDispatcher.instance.onError, originalPlatformHandler);
  });

  test('missing Firebase configuration does not prevent startup', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    await initializeCrashReporting();
    expect(FlutterError.onError, originalFlutterHandler);
    expect(PlatformDispatcher.instance.onError, originalPlatformHandler);
  });
}
