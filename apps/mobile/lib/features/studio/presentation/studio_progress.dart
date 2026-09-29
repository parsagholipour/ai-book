import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../projects/presentation/plan_build_progress.dart';

/// The wait a Studio request shows while the server works: the planner's
/// sparkle, a line of copy that rises into place as the work moves on, and a
/// bar that paces itself toward a ceiling it never reaches.
///
/// None of these calls report progress, so the bar is honest about pace rather
/// than position: quick at first, slowing as it nears [ceiling], and only ever
/// filled when the caller says the work is [done]. It never rewinds.
class StudioWorkingProgress extends StatefulWidget {
  const StudioWorkingProgress({
    required this.stages,
    this.done = false,
    this.tau = const Duration(seconds: 5),
    this.stageInterval = const Duration(milliseconds: 2600),
    this.ceiling = 0.92,
    this.semanticLabel,
    super.key,
  });

  /// The copy, in order. Advances one line every [stageInterval] and settles
  /// on the last.
  final List<String> stages;

  /// Fills the bar. The copy stays on the last stage.
  final bool done;

  /// How quickly the bar approaches [ceiling]: about two thirds of the way
  /// there after one [tau].
  final Duration tau;
  final Duration stageInterval;
  final double ceiling;
  final String? semanticLabel;

  @override
  State<StudioWorkingProgress> createState() => _StudioWorkingProgressState();
}

class _StudioWorkingProgressState extends State<StudioWorkingProgress> {
  static const _tick = Duration(milliseconds: 250);

  Timer? _timer;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    // A quarter-second tick rather than a per-frame ticker: the bar eases
    // between readings on its own, so a frame-rate clock would only cost.
    _timer = Timer.periodic(_tick, (_) {
      if (!mounted) return;
      setState(() => _elapsed += _tick);
    });
  }

  @override
  void didUpdateWidget(covariant StudioWorkingProgress oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.done) {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  double get _paced {
    final t = _elapsed.inMilliseconds / widget.tau.inMilliseconds;
    // A small head start so the bar is visibly moving on the first frame.
    return 0.04 + (widget.ceiling - 0.04) * (1 - math.exp(-t));
  }

  String get _stage {
    final stages = widget.stages;
    if (stages.isEmpty) return '';
    if (widget.done) return stages.last;
    final index =
        _elapsed.inMilliseconds ~/ widget.stageInterval.inMilliseconds;
    return stages[index.clamp(0, stages.length - 1)];
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final value = widget.done ? 1.0 : _paced;
    final stage = _stage;
    return Semantics(
      container: true,
      liveRegion: true,
      label: widget.semanticLabel == null
          ? stage
          : '${widget.semanticLabel}. $stage',
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                PlanBuildSparkle(color: colors.primary, size: 24),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: ClipRect(
                    child: RisingStatusText(
                      text: stage,
                      maxLines: 1,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            PlanBuildProgressBar(value: value, active: !widget.done),
          ],
        ),
      ),
    );
  }
}
