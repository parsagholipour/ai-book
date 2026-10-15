import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Every return of the app to the foreground, for code that is not a widget.
///
/// A provider cannot register an `AppLifecycleListener` itself: it can be
/// built where no Flutter binding exists (a plain `ProviderContainer` test),
/// and the listener needs one. So `main` starts this once the binding is up,
/// and until then — in every test that does not ask for it — it never fires.
abstract final class AppResumeSignal {
  static final _resumes = StreamController<void>.broadcast();
  static AppLifecycleListener? _listener;

  static Stream<void> get resumes => _resumes.stream;

  /// Starts listening to the app lifecycle. Idempotent.
  static void start() {
    _listener ??= AppLifecycleListener(onResume: () => _resumes.add(null));
  }
}

/// [AppResumeSignal.resumes] for providers, and the seam a test overrides to
/// bring the app back to the foreground.
final appResumesProvider = Provider<Stream<void>>(
  (ref) => AppResumeSignal.resumes,
);
