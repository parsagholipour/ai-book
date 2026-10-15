import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// Owns the timer lifecycle for a single synchronous UI polling loop.
///
/// Polling policy stays with the state that uses this mixin: callers decide
/// when to start and stop, and what each tick refreshes.
///
/// The loop only ticks while someone can see it. A screen under a pushed route
/// (its [TickerMode] is off) or an app in the background holds its timer, and
/// the moment it is showing again it reads once at once and resumes the
/// interval. Before this the root chat kept its four-second plan and transcript
/// reads going under every page pushed over it and for as long as the app sat
/// in the background. [isPolling] still reports a held loop as polling: the
/// caller asked for it, and its "stop, then one last refresh" logic must not
/// see a pause as a stop.
mixin PollingStateMixin<T extends StatefulWidget> on State<T> {
  Timer? _pollingTimer;
  Duration? _interval;
  VoidCallback? _callback;
  ValueListenable<TickerModeData>? _tickerMode;
  AppLifecycleListener? _lifecycle;
  bool _appShowing = true;

  /// Whether a loop has been started and not stopped, held or not.
  bool get isPolling => _interval != null;

  /// Whether a tick would run now: the app is in the foreground and this
  /// screen is not covered by another route.
  bool get pollingVisible =>
      _appShowing && (_tickerMode?.value.enabled ?? true);

  /// Starts one polling loop, leaving an active loop unchanged.
  void startPolling(Duration interval, VoidCallback callback) {
    if (_interval != null) return;
    _interval = interval;
    _callback = callback;
    _watchLifecycle();
    _syncTimer();
  }

  void stopPolling() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
    _interval = null;
    _callback = null;
  }

  @mustCallSuper
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final tickerMode = TickerMode.getValuesNotifier(context);
    if (identical(tickerMode, _tickerMode)) return;
    _tickerMode?.removeListener(_visibilityChanged);
    _tickerMode = tickerMode..addListener(_visibilityChanged);
    _syncTimer();
  }

  @mustCallSuper
  @override
  void dispose() {
    stopPolling();
    _tickerMode?.removeListener(_visibilityChanged);
    _tickerMode = null;
    _lifecycle?.dispose();
    _lifecycle = null;
    super.dispose();
  }

  void _watchLifecycle() {
    if (_lifecycle != null) return;
    final state = WidgetsBinding.instance.lifecycleState;
    _appShowing = state == null || _isShowing(state);
    _lifecycle = AppLifecycleListener(
      onStateChange: (state) {
        final showing = _isShowing(state);
        if (showing == _appShowing) return;
        _appShowing = showing;
        _visibilityChanged();
      },
    );
  }

  /// `inactive` is still on screen — a system dialog over the app, or the
  /// other half of a split screen — so it keeps polling.
  static bool _isShowing(AppLifecycleState state) =>
      state == AppLifecycleState.resumed ||
      state == AppLifecycleState.inactive;

  void _visibilityChanged() {
    final wasHeld = isPolling && _pollingTimer == null;
    _syncTimer();
    if (!wasHeld || _pollingTimer == null) return;
    // Back in view: what was missed is read now rather than an interval from
    // now. Out of the current call, which can be a build (TickerMode changes
    // while the navigator lays out its routes), so the tick may touch
    // providers.
    scheduleMicrotask(() {
      if (mounted && isPolling && pollingVisible) _callback?.call();
    });
  }

  void _syncTimer() {
    final interval = _interval;
    if (interval == null) return;
    if (!pollingVisible) {
      _pollingTimer?.cancel();
      _pollingTimer = null;
      return;
    }
    _pollingTimer ??= Timer.periodic(interval, (_) => _callback?.call());
  }
}
