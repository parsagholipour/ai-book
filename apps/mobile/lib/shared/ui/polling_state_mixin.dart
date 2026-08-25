import 'dart:async';

import 'package:flutter/widgets.dart';

/// Owns the timer lifecycle for a single synchronous UI polling loop.
///
/// Polling policy stays with the state that uses this mixin: callers decide
/// when to start and stop, and what each tick refreshes.
mixin PollingStateMixin<T extends StatefulWidget> on State<T> {
  Timer? _pollingTimer;

  bool get isPolling => _pollingTimer?.isActive ?? false;

  /// Starts one polling loop, leaving an active loop unchanged.
  void startPolling(Duration interval, VoidCallback callback) {
    _pollingTimer ??= Timer.periodic(interval, (_) => callback());
  }

  void stopPolling() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
  }

  @mustCallSuper
  @override
  void dispose() {
    stopPolling();
    super.dispose();
  }
}
