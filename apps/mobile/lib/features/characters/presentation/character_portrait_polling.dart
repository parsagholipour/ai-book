import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/characters_repository.dart';

/// How long a screen keeps re-reading while something is being drawn.
///
/// A portrait takes about a minute. Four is generous; past that a QUEUED row
/// that will never land would poll for as long as the screen is open, so the
/// timer stops and the surface offers a manual check instead.
const Duration _pollBudget = Duration(minutes: 4);
const Duration _pollInterval = Duration(seconds: 3);

/// A 3-second re-read of the character library, running only while something
/// the host screen is watching is still being drawn.
///
/// Both the library and one character's profile need this, and neither owns the
/// other's lifetime: the profile is reachable with the library disposed the
/// moment the mention strip pushes it, and `charactersProvider` is autoDispose,
/// so leaning on the library screen's timer would break silently the day that
/// happens.
mixin CharacterPortraitPolling<T extends ConsumerStatefulWidget>
    on ConsumerState<T> {
  Timer? _poll;
  AppLifecycleListener? _lifecycle;
  DateTime? _startedAt;
  bool _budgetSpent = false;

  /// Whether this screen still has something worth waiting for.
  bool get isDrawing;

  /// Anything else that should be re-read on each tick. The library list is
  /// always invalidated; a profile also refreshes its pictures, because a
  /// finished drawing is a new entry in the strip.
  void onPollTick() {}

  /// True once the wait has gone on long enough that the screen should stop
  /// polling and say so.
  bool get portraitWaitGaveUp => _budgetSpent;

  @override
  void initState() {
    super.initState();
    // A drawing takes about a minute and readers switch away; a timer that
    // kept firing in the background would spend the budget on nothing.
    _lifecycle = AppLifecycleListener(
      onResume: () {
        if (!mounted) return;
        _tick();
        syncPortraitPolling();
      },
      onPause: _cancelPoll,
    );
  }

  @override
  void dispose() {
    _poll?.cancel();
    _lifecycle?.dispose();
    super.dispose();
  }

  /// Call from `build` once the current state is known.
  void syncPortraitPolling() {
    if (!isDrawing) {
      _cancelPoll();
      _startedAt = null;
      if (_budgetSpent) {
        // Something landed after all; the next wait gets the whole allowance.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) setState(() => _budgetSpent = false);
        });
      }
      return;
    }
    if (_budgetSpent) return;
    _startedAt ??= DateTime.now();
    _poll ??= Timer.periodic(_pollInterval, (_) {
      if (!mounted) return;
      final startedAt = _startedAt;
      if (startedAt != null &&
          DateTime.now().difference(startedAt) > _pollBudget) {
        _cancelPoll();
        setState(() => _budgetSpent = true);
        return;
      }
      _tick();
    });
  }

  /// What the "check again" affordance calls: one read, and the wait restarts.
  void resumePortraitPolling() {
    _tick();
    setState(() {
      _budgetSpent = false;
      _startedAt = DateTime.now();
    });
  }

  void _tick() {
    ref.invalidate(charactersProvider);
    onPollTick();
  }

  void _cancelPoll() {
    _poll?.cancel();
    _poll = null;
  }
}
