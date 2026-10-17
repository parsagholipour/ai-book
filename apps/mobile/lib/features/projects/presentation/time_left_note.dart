import 'dart:async';

import 'package:flutter/material.dart';

import 'generation_duration.dart';
import 'plan_build_progress.dart';

/// "About 4 min left" under a plan's or a book's progress bar.
///
/// The number is the server's (`estimatedSecondsLeft`), and the server sends a
/// status only when something in it changed — so between two statuses this
/// counts down on its own, every [tick] from the moment the latest value
/// arrived. It never counts back up: only a different value from the server
/// can raise it. Once the count reaches zero with the work still running it
/// says "Almost done" and stops. A calm line like `WaitingInLineNote`'s, never
/// a notice; it draws nothing when the server has no estimate.
class TimeLeftNote extends StatefulWidget {
  const TimeLeftNote({
    required this.secondsLeft,
    this.color,
    this.tick = const Duration(seconds: 10),
    super.key,
  });

  final int? secondsLeft;

  /// Defaults to the theme's quiet text colour.
  final Color? color;

  /// How often the count steps down. Coarse on purpose: the words change at
  /// most once a minute above one minute.
  final Duration tick;

  @override
  State<TimeLeftNote> createState() => _TimeLeftNoteState();
}

class _TimeLeftNoteState extends State<TimeLeftNote> {
  Timer? _countdown;

  /// Ticks since the latest value arrived. `Timer.tick` rather than a count of
  /// callbacks, because it also counts the ticks a backgrounded app slept
  /// through.
  int _ticks = 0;

  int get _remaining =>
      (widget.secondsLeft ?? 0) - (_ticks * widget.tick.inMilliseconds) ~/ 1000;

  @override
  void initState() {
    super.initState();
    _restart();
  }

  @override
  void didUpdateWidget(TimeLeftNote oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A status that resends the same estimate is not a new one: restarting on
    // it would wind the count back up to where the server last left it.
    if (oldWidget.secondsLeft != widget.secondsLeft ||
        oldWidget.tick != widget.tick) {
      _restart();
    }
  }

  void _restart() {
    _countdown?.cancel();
    _countdown = null;
    _ticks = 0;
    if (_remaining <= 0) return;
    _countdown = Timer.periodic(widget.tick, (timer) {
      if (!mounted) return;
      setState(() => _ticks = timer.tick);
      if (_remaining <= 0) timer.cancel();
    });
  }

  @override
  void dispose() {
    _countdown?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.secondsLeft == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final tint = widget.color ?? theme.colorScheme.onSurfaceVariant;
    final label = formatTimeLeft(_remaining);
    return Semantics(
      label: label,
      child: ExcludeSemantics(
        child: Row(
          children: [
            Icon(Icons.schedule_outlined, size: 16, color: tint),
            const SizedBox(width: 7),
            Expanded(
              child: RisingStatusText(
                text: label,
                style: theme.textTheme.bodySmall?.copyWith(color: tint),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
