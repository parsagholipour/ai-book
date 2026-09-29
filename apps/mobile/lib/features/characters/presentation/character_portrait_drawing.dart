import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/plan_build_progress.dart'
    show PlanBuildSparkle, RisingStatusText;

// What a character's picture looks like while it is being drawn.
//
// The server reports a portrait as queued or generating and nothing finer, so
// like the Build button this paces its own reading: an ease toward a ceiling it
// never reaches, and stage words that only move forward. It is drawn only while
// the row says work is in flight, so a finished character holds still.

/// How far along the drawing reads [elapsed] in.
///
/// An exponential approach: quick at first, slowing as it nears the ceiling, so
/// a long wait keeps moving without ever claiming to have arrived.
double pacedDrawingProgress(Duration elapsed) {
  const floor = 0.04;
  const ceiling = 0.92;
  const tau = Duration(seconds: 28);
  final t = elapsed.inMilliseconds / tau.inMilliseconds;
  return ceiling - (ceiling - floor) * math.exp(-t);
}

/// What is happening now, [elapsed] in. Only ever advances, and the last word
/// is honest about a wait that has run long.
String drawingStageLabel(Duration elapsed) {
  final seconds = elapsed.inSeconds;
  if (seconds >= 60) return 'Still drawing';
  if (seconds >= 32) return 'Finishing touches';
  if (seconds >= 18) return 'Adding colour';
  if (seconds >= 8) return 'Sketching the outline';
  return 'Getting started';
}

/// The veil drawn over a character's art while their picture is on its way:
/// a soft sweep of light, a working sparkle, and — at hero size — the name, the
/// stage and a bar that only climbs.
///
/// Fills its parent. [compact] is the library card and list row: a sparkle and
/// a thin bar with no words, because the card already carries a status pill.
class CharacterDrawingOverlay extends StatefulWidget {
  const CharacterDrawingOverlay({
    required this.name,
    this.compact = false,
    super.key,
  });

  final String name;
  final bool compact;

  @override
  State<CharacterDrawingOverlay> createState() =>
      _CharacterDrawingOverlayState();
}

class _CharacterDrawingOverlayState extends State<CharacterDrawingOverlay>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;

  /// Frame time since the veil appeared — the scheduler's clock, so a test that
  /// pumps a duration moves it and a wall clock would not.
  Duration _clock = Duration.zero;

  /// The highest reading shown so far; the bar is never allowed to fall.
  double _shown = 0;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick)..start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  void _tick(Duration elapsed) {
    // Reduced motion keeps the reading honest but stops the per-frame repaint:
    // a bar that advances once a second is not an animation.
    if (AppMotion.reducedMotion(context) &&
        elapsed.inSeconds == _clock.inSeconds) {
      return;
    }
    setState(() => _clock = elapsed);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final reduced = AppMotion.reducedMotion(context);
    _shown = math.max(_shown, pacedDrawingProgress(_clock));
    final percent = ((_shown * 100) / 5).round() * 5;
    final stage = drawingStageLabel(_clock);
    final sweep = (_clock.inMilliseconds % 2400) / 2400;

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Drawing ${widget.name}. $stage.',
      value: '$percent percent',
      child: ExcludeSemantics(
        child: Stack(
          fit: StackFit.expand,
          children: [
            ColoredBox(color: colors.surface.withValues(alpha: 0.6)),
            if (!reduced)
              CustomPaint(
                painter: _SweepPainter(t: sweep, color: colors.primary),
              ),
            if (widget.compact) _compact(colors) else _hero(theme, stage),
          ],
        ),
      ),
    );
  }

  Widget _compact(ColorScheme colors) {
    return Stack(
      fit: StackFit.expand,
      children: [
        Center(
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: colors.surface.withValues(alpha: 0.92),
              shape: BoxShape.circle,
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.xs),
              child: PlanBuildSparkle(color: colors.primary, size: 26),
            ),
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: LinearProgressIndicator(value: _shown, minHeight: 4),
        ),
      ],
    );
  }

  Widget _hero(ThemeData theme, String stage) {
    final colors = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Center(
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: SizedBox(
            width: 264,
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: colors.surface.withValues(alpha: 0.94),
                borderRadius: BorderRadius.circular(AppRadii.sheet - 6),
                border: Border.all(color: colors.outlineVariant),
              ),
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.primaryContainer,
                        shape: BoxShape.circle,
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.sm + 2),
                        child: PlanBuildSparkle(
                          color: colors.primary,
                          size: 36,
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Text(
                      'Drawing ${widget.name}',
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xxs),
                    RisingStatusText(
                      text: stage,
                      maxLines: 1,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(AppRadii.pill),
                      child: LinearProgressIndicator(
                        value: _shown,
                        minHeight: 6,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      'Usually about a minute.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A soft diagonal band of light crossing the art, so a drawing in progress
/// reads as working rather than stuck.
class _SweepPainter extends CustomPainter {
  const _SweepPainter({required this.t, required this.color});

  final double t;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final band = size.shortestSide * 0.9;
    final x = -band + (size.width + 2 * band) * t;
    // Explicit stops: a gradient of three or more colours needs them.
    final shader = ui.Gradient.linear(
      Offset(x, 0),
      Offset(x + band, 0),
      [
        color.withValues(alpha: 0),
        color.withValues(alpha: 0.18),
        color.withValues(alpha: 0),
      ],
      const [0, 0.5, 1],
    );
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.skew(-0.35, 0);
    canvas.drawRect(
      Rect.fromLTWH(
        x - size.height,
        -size.height,
        band + 2 * size.height,
        size.height * 3,
      ),
      Paint()..shader = shader,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_SweepPainter oldDelegate) =>
      oldDelegate.t != t || oldDelegate.color != color;
}
