import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../shared/ui/design_system/app_tokens.dart';
import '../../../shared/ui/motion.dart';
import 'creation_chat_state.dart';

// The Build button while a plan is being started, and the progress pieces the
// planning footer draws once it has.
//
// Two calls sit behind one tap: a preflight that has the advisor model read
// the conversation (most of the wait), then the build that creates the project
// and queues the planner. Neither reports progress, so the button paces its
// own: each phase eases toward a ceiling it never reaches, the second phase's
// floor sits above the first's ceiling, and the planning footer's real percent
// takes over from there. It never rewinds and never claims to be finished.

/// How far along the paced progress reads [elapsed] into [phase].
///
/// An exponential approach: quick at first, then slowing as it nears the
/// ceiling, so a long preflight keeps moving without ever arriving.
double pacedBuildProgress(Duration elapsed, CreationBuildPhase phase) {
  final band = _bandFor(phase);
  final t = elapsed.inMilliseconds / band.tau.inMilliseconds;
  return band.ceiling - (band.ceiling - band.floor) * math.exp(-t);
}

/// What the button says [elapsed] into [phase]. Advances one stage every
/// [buildStageInterval], never rewinds, and settles on the last entry.
String buildStageLabel(Duration elapsed, CreationBuildPhase phase) {
  final stages = buildStagesFor(phase);
  final index = elapsed.inMilliseconds ~/ buildStageInterval.inMilliseconds;
  return stages[index.clamp(0, stages.length - 1)];
}

const Duration buildStageInterval = Duration(milliseconds: 3500);

List<String> buildStagesFor(CreationBuildPhase phase) => switch (phase) {
  CreationBuildPhase.preparing => const [
    'Reading your idea',
    'Checking the details',
    'Sizing your book',
    'Almost ready',
  ],
  CreationBuildPhase.building => const [
    'Setting up your book',
    'Starting the planner',
    'Almost there',
  ],
  CreationBuildPhase.idle => const ['Build the plan'],
};

({double floor, double ceiling, Duration tau}) _bandFor(
  CreationBuildPhase phase,
) => switch (phase) {
  CreationBuildPhase.preparing => (
    floor: 0.03,
    ceiling: 0.46,
    tau: const Duration(seconds: 7),
  ),
  CreationBuildPhase.building => (
    floor: 0.48,
    ceiling: 0.94,
    tau: const Duration(seconds: 3),
  ),
  CreationBuildPhase.idle => (
    floor: 0,
    ceiling: 0,
    tau: const Duration(seconds: 1),
  ),
};

/// The Build button once it has been tapped: the same pill, filling from the
/// left as the two calls run, with a sheen crossing it, a sparkle working at
/// the leading edge, the current stage, and a percent that only climbs.
class PlanBuildProcessingButton extends StatefulWidget {
  const PlanBuildProcessingButton({required this.phase, super.key});

  final CreationBuildPhase phase;

  @override
  State<PlanBuildProcessingButton> createState() =>
      _PlanBuildProcessingButtonState();
}

class _PlanBuildProcessingButtonState extends State<PlanBuildProcessingButton>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;

  /// Frame time since the button appeared — the scheduler's clock, so tests
  /// that pump a duration move it and a wall clock does not.
  Duration _clock = Duration.zero;
  Duration _phaseStart = Duration.zero;

  /// The highest reading shown so far. A phase change re-bases the pacing but
  /// the bar is never allowed to fall.
  double _shown = 0;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick)..start();
  }

  @override
  void didUpdateWidget(covariant PlanBuildProcessingButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.phase != widget.phase) {
      _phaseStart = _clock;
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  void _tick(Duration elapsed) {
    setState(() => _clock = elapsed);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final reduced = AppMotion.reducedMotion(context);
    final sincePhase = _clock - _phaseStart;
    _shown = math.max(_shown, pacedBuildProgress(sincePhase, widget.phase));
    final progress = _shown;
    final percent = (progress * 100).round();
    final stage = buildStageLabel(sincePhase, widget.phase);
    // One sheen crossing every 1.6 s, and the sparkle's own slower cycle.
    final sheen = (_clock.inMilliseconds % 1600) / 1600;
    final labelStyle = theme.textTheme.labelLarge?.copyWith(
      color: colors.onPrimary,
      fontWeight: FontWeight.w700,
      letterSpacing: 0.1,
    );

    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Building the plan. $stage.',
      // Announced to the nearest five so a live region is not re-read on
      // every frame the bar moves.
      value: '${(percent / 5).round() * 5} percent',
      child: ExcludeSemantics(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.control),
          child: CustomPaint(
            painter: _CapsulePainter(
              progress: progress,
              sheen: sheen,
              base: colors.primary,
              // White rather than onPrimary: in the dark theme onPrimary is
              // the dark ink, and a band of it read as the finished part
              // going out rather than lighting up.
              tint: Colors.white,
              animate: !reduced,
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minHeight: AppSizes.controlHeight,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18),
                child: Row(
                  children: [
                    PlanBuildSparkle(color: colors.onPrimary, size: 22),
                    const SizedBox(width: 10),
                    Expanded(
                      child: ClipRect(
                        child: RisingStatusText(
                          text: stage,
                          style: labelStyle,
                          maxLines: 1,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    ConstrainedBox(
                      constraints: const BoxConstraints(minWidth: 44),
                      child: Text(
                        '$percent%',
                        textAlign: TextAlign.end,
                        style: labelStyle?.copyWith(
                          fontWeight: FontWeight.w800,
                          fontFeatures: const [ui.FontFeature.tabularFigures()],
                        ),
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

/// A status line whose every new value rises into place as the old one
/// sinks out — the Build pill's stage, the footer's and the writing bubble's
/// "what is happening now".
class RisingStatusText extends StatelessWidget {
  const RisingStatusText({
    required this.text,
    required this.style,
    this.maxLines,
    super.key,
  });

  final String text;
  final TextStyle? style;

  /// Null wraps freely; a line count truncates with an ellipsis.
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final line = Text(
      text,
      key: ValueKey(text),
      maxLines: maxLines,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
      style: style,
    );
    if (AppMotion.reducedMotion(context)) {
      return line;
    }
    return AnimatedSwitcher(
      duration: AppMotion.medium,
      switchInCurve: AppMotion.enter,
      switchOutCurve: AppMotion.exit,
      layoutBuilder: (currentChild, previousChildren) => Stack(
        alignment: AlignmentDirectional.centerStart,
        children: [...previousChildren, ?currentChild],
      ),
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.7),
            end: Offset.zero,
          ).animate(animation),
          child: child,
        ),
      ),
      child: line,
    );
  }
}

/// Clear at both edges, brightest in the middle: every moving band below.
const List<double> _softBandStops = [0, 0.5, 1];

class _CapsulePainter extends CustomPainter {
  const _CapsulePainter({
    required this.progress,
    required this.sheen,
    required this.base,
    required this.tint,
    required this.animate,
  });

  final double progress;
  final double sheen;
  final Color base;
  final Color tint;
  final bool animate;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = base);
    final fillWidth = size.width * progress.clamp(0.0, 1.0);
    canvas.drawRect(
      Rect.fromLTWH(0, 0, fillWidth, size.height),
      Paint()..color = tint.withValues(alpha: 0.16),
    );
    // A brighter hairline at the leading edge so the fill reads as an edge
    // moving, not a slightly different shade of the same pill.
    canvas.drawRect(
      Rect.fromLTWH(math.max(0, fillWidth - 2), 0, 2, size.height),
      Paint()..color = tint.withValues(alpha: 0.45),
    );
    if (!animate) {
      return;
    }
    final band = size.height * 2.4;
    final x = -band + (size.width + 2 * band) * sheen;
    final shader = ui.Gradient.linear(Offset(x, 0), Offset(x + band, 0), [
      tint.withValues(alpha: 0),
      tint.withValues(alpha: 0.22),
      tint.withValues(alpha: 0),
    ], _softBandStops);
    canvas.save();
    // Slant the band so it reads as light passing over the pill.
    canvas.skew(-0.45, 0);
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
  bool shouldRepaint(covariant _CapsulePainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.sheen != sheen ||
      oldDelegate.base != base ||
      oldDelegate.tint != tint ||
      oldDelegate.animate != animate;
}

/// A four-point sparkle that turns and breathes, with two smaller ones
/// orbiting and twinkling. The working icon for everything the planner does.
class PlanBuildSparkle extends StatefulWidget {
  const PlanBuildSparkle({required this.color, this.size = 22, super.key});

  final Color color;
  final double size;

  @override
  State<PlanBuildSparkle> createState() => _PlanBuildSparkleState();
}

class _PlanBuildSparkleState extends State<PlanBuildSparkle>
    with SingleTickerProviderStateMixin {
  late final AnimationController _cycle = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (AppMotion.reducedMotion(context)) {
      _cycle.stop();
    } else if (!_cycle.isAnimating) {
      _cycle.repeat();
    }
  }

  @override
  void dispose() {
    _cycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animate = !AppMotion.reducedMotion(context);
    return SizedBox.square(
      dimension: widget.size,
      child: AnimatedBuilder(
        animation: _cycle,
        builder: (context, _) => CustomPaint(
          painter: _SparklePainter(
            t: _cycle.value,
            color: widget.color,
            animate: animate,
          ),
        ),
      ),
    );
  }
}

class _SparklePainter extends CustomPainter {
  const _SparklePainter({
    required this.t,
    required this.color,
    required this.animate,
  });

  /// Position in the cycle, 0..1. Every motion below is periodic in it, so the
  /// wrap from 1 back to 0 is invisible.
  final double t;
  final Color color;
  final bool animate;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    final radius = size.shortestSide / 2;
    final wave = math.sin(t * 2 * math.pi);
    final breathe = animate ? 0.94 + 0.06 * wave : 1.0;
    // A quarter turn per cycle: the star has four-fold symmetry, so the wrap
    // lands on itself.
    final angle = animate ? t * math.pi / 2 : 0.0;

    canvas.save();
    canvas.translate(centre.dx, centre.dy);
    canvas.rotate(angle);
    canvas.drawPath(
      sparklePath(Offset.zero, radius * 0.66 * breathe),
      Paint()..color = color,
    );
    canvas.restore();
    if (!animate) {
      return;
    }
    // Two satellites half a turn apart, orbiting half a turn per cycle: at the
    // wrap each has moved into the other's place, and their twinkle is a
    // function of where they are, so nothing jumps.
    for (var i = 0; i < 2; i++) {
      final orbitAngle = t * math.pi + i * math.pi - math.pi / 4;
      final position =
          centre +
          Offset(math.cos(orbitAngle), math.sin(orbitAngle)) * (radius * 0.8);
      final twinkle = 0.5 + 0.5 * math.sin(2 * orbitAngle);
      canvas.drawPath(
        sparklePath(position, radius * (0.13 + 0.13 * twinkle)),
        Paint()..color = color.withValues(alpha: 0.35 + 0.65 * twinkle),
      );
    }
  }

  @override
  bool shouldRepaint(covariant _SparklePainter oldDelegate) =>
      oldDelegate.t != t ||
      oldDelegate.color != color ||
      oldDelegate.animate != animate;
}

/// A four-point star of [radius] around [centre], its sides pulled in toward
/// the middle so the arms taper.
Path sparklePath(Offset centre, double radius) {
  final pinch = radius * 0.2;
  final path = Path();
  final tips = [
    centre + Offset(0, -radius),
    centre + Offset(radius, 0),
    centre + Offset(0, radius),
    centre + Offset(-radius, 0),
  ];
  path.moveTo(tips[0].dx, tips[0].dy);
  for (var i = 0; i < 4; i++) {
    final from = tips[i];
    final to = tips[(i + 1) % 4];
    // The control point sits a little way out from the centre, along the
    // diagonal between the two tips.
    final mid = Offset((from.dx + to.dx) / 2, (from.dy + to.dy) / 2);
    final direction = mid - centre;
    final length = direction.distance;
    final control = length == 0 ? centre : centre + direction / length * pinch;
    path.quadraticBezierTo(control.dx, control.dy, to.dx, to.dy);
  }
  path.close();
  return path;
}

/// The planning footer's progress bar: a gradient fill that eases to each
/// reading with a sheen passing over it, and a sweeping band while the first
/// reading is still on its way.
class PlanBuildProgressBar extends StatefulWidget {
  const PlanBuildProgressBar({
    required this.value,
    this.active = true,
    this.height = 8,
    this.trackColor,
    this.semanticLabel,
    super.key,
  });

  /// Progress 0..1, or null while nothing has reported yet.
  final double? value;

  /// False once the work behind the bar has stopped short — a failed book,
  /// a book waiting on a person — so the sheen stops promising more.
  final bool active;
  final double height;

  /// Defaults to `surfaceContainerHighest`; a host drawn in that colour
  /// passes something lighter so the track still shows.
  final Color? trackColor;
  final String? semanticLabel;

  @override
  State<PlanBuildProgressBar> createState() => _PlanBuildProgressBarState();
}

class _PlanBuildProgressBarState extends State<PlanBuildProgressBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _sheen = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncSheen();
  }

  @override
  void didUpdateWidget(covariant PlanBuildProgressBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncSheen();
  }

  /// The sheen runs only while there is something to wait for: a finished or
  /// stopped bar stops moving, and reduced motion never starts it.
  void _syncSheen() {
    final finished = (widget.value ?? 0) >= 1;
    if (AppMotion.reducedMotion(context) || finished || !widget.active) {
      _sheen.stop();
    } else if (!_sheen.isAnimating) {
      _sheen.repeat();
    }
  }

  @override
  void dispose() {
    _sheen.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final reduced = AppMotion.reducedMotion(context);
    final target = widget.value?.clamp(0.0, 1.0);
    final fillEnd = Color.lerp(colors.primary, Colors.white, 0.3)!;

    final bar = SizedBox(
      height: widget.height,
      width: double.infinity,
      child: AnimatedBuilder(
        animation: _sheen,
        builder: (context, _) => TweenAnimationBuilder<double>(
          tween: Tween<double>(end: target ?? 0),
          duration: reduced ? Duration.zero : AppMotion.slow,
          curve: AppMotion.enter,
          builder: (context, animated, _) => CustomPaint(
            painter: _BarPainter(
              value: target == null ? null : animated,
              sheen: _sheen.value,
              track: widget.trackColor ?? colors.surfaceContainerHighest,
              fillStart: colors.primary,
              fillEnd: fillEnd,
              animate: !reduced && widget.active,
            ),
          ),
        ),
      ),
    );

    final label = widget.semanticLabel;
    if (label == null) {
      return bar;
    }
    return Semantics(
      label: label,
      value: target == null
          ? 'Working'
          : '${(target * 100).round()} percent complete',
      child: ExcludeSemantics(child: bar),
    );
  }
}

class _BarPainter extends CustomPainter {
  const _BarPainter({
    required this.value,
    required this.sheen,
    required this.track,
    required this.fillStart,
    required this.fillEnd,
    required this.animate,
  });

  final double? value;
  final double sheen;
  final Color track;
  final Color fillStart;
  final Color fillEnd;
  final bool animate;

  @override
  void paint(Canvas canvas, Size size) {
    final radius = Radius.circular(size.height / 2);
    final trackRect = RRect.fromRectAndRadius(Offset.zero & size, radius);
    canvas.drawRRect(trackRect, Paint()..color = track);
    canvas.save();
    canvas.clipRRect(trackRect);

    final value = this.value;
    if (value == null) {
      // Nothing has reported yet: a soft band sweeps the track, or sits in
      // the middle when motion is off.
      final width = size.width * 0.32;
      final x = animate
          ? -width + (size.width + width) * sheen
          : (size.width - width) / 2;
      final rect = Rect.fromLTWH(x, 0, width, size.height);
      canvas.drawRect(
        rect,
        Paint()
          ..shader = ui.Gradient.linear(rect.centerLeft, rect.centerRight, [
            fillStart.withValues(alpha: 0),
            fillStart.withValues(alpha: 0.85),
            fillStart.withValues(alpha: 0),
          ], _softBandStops),
      );
      canvas.restore();
      return;
    }

    final fillWidth = size.width * value;
    if (fillWidth > 0) {
      final fill = Rect.fromLTWH(0, 0, fillWidth, size.height);
      canvas.drawRRect(
        RRect.fromRectAndRadius(fill, radius),
        Paint()
          ..shader = ui.Gradient.linear(fill.centerLeft, fill.centerRight, [
            fillStart,
            fillEnd,
          ]),
      );
      if (animate && value < 1) {
        final band = math.max(size.height * 6, 36.0);
        final x = -band + (fillWidth + band) * sheen;
        canvas.save();
        canvas.clipRect(fill);
        canvas.drawRect(
          Rect.fromLTWH(x, 0, band, size.height),
          Paint()
            ..shader = ui.Gradient.linear(Offset(x, 0), Offset(x + band, 0), [
              Colors.white.withValues(alpha: 0),
              Colors.white.withValues(alpha: 0.4),
              Colors.white.withValues(alpha: 0),
            ], _softBandStops),
        );
        canvas.restore();
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _BarPainter oldDelegate) =>
      oldDelegate.value != value ||
      oldDelegate.sheen != sheen ||
      oldDelegate.track != track ||
      oldDelegate.fillStart != fillStart ||
      oldDelegate.fillEnd != fillEnd ||
      oldDelegate.animate != animate;
}
