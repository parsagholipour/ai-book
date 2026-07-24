import 'package:flutter/material.dart';

/// One motion vocabulary for the whole app.
///
/// Durations are deliberately short: this is a working tool, and motion is
/// there to explain what changed, not to make the user wait. Anything that sits
/// between a tap and a result stays under [medium].
abstract final class AppMotion {
  /// State flips that must feel instant: icon swaps, colour changes.
  static const Duration fast = Duration(milliseconds: 140);

  /// The default for content entering, leaving, or resizing.
  static const Duration medium = Duration(milliseconds: 260);

  /// Screen-level transitions and celebratory moments.
  static const Duration slow = Duration(milliseconds: 420);

  /// Decelerating curve for content arriving on screen.
  static const Curve enter = Curves.easeOutCubic;

  /// Accelerating curve for content leaving.
  static const Curve exit = Curves.easeInCubic;

  /// Symmetric curve for a value moving between two known states.
  static const Curve standard = Curves.easeInOutCubic;

  /// Slight overshoot for elements that should feel physical (badges, covers).
  static const Curve emphasized = Curves.easeOutBack;

  /// Per-item delay when a list staggers itself in.
  static const Duration stagger = Duration(milliseconds: 45);

  /// Longest stagger delay we will apply, so a long list never feels slow.
  static const int maxStaggerSteps = 8;

  /// True when the platform asks for reduced motion. Every animation helper in
  /// this file degrades to an instant state change when this is set.
  static bool reducedMotion(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;
}

/// Fades and lifts a child into place once, on first build.
///
/// Used for list items and cards so content arrives with a sense of direction
/// instead of popping in. [index] staggers siblings; pass the item's position
/// in its list.
class AppEntrance extends StatefulWidget {
  const AppEntrance({
    required this.child,
    this.index = 0,
    this.offset = 12,
    this.duration = AppMotion.medium,
    super.key,
  });

  final Widget child;
  final int index;

  /// Vertical distance travelled, in logical pixels. Negative lifts upward.
  final double offset;
  final Duration duration;

  @override
  State<AppEntrance> createState() => _AppEntranceState();
}

class _AppEntranceState extends State<AppEntrance>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: widget.duration,
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) {
      return;
    }
    _started = true;
    if (AppMotion.reducedMotion(context)) {
      _controller.value = 1;
      return;
    }
    final steps = widget.index.clamp(0, AppMotion.maxStaggerSteps);
    final delay = AppMotion.stagger * steps;
    if (delay == Duration.zero) {
      _controller.forward();
      return;
    }
    Future<void>.delayed(delay, () {
      if (mounted) {
        _controller.forward();
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final curved = CurvedAnimation(parent: _controller, curve: AppMotion.enter);
    return AnimatedBuilder(
      animation: curved,
      builder: (context, child) {
        return Opacity(
          opacity: curved.value,
          child: Transform.translate(
            offset: Offset(0, widget.offset * (1 - curved.value)),
            child: child,
          ),
        );
      },
      child: widget.child,
    );
  }
}

/// A progress bar whose value eases to each new reading.
///
/// Generation progress arrives in poll-sized jumps; tweening between them makes
/// the book feel like it is being written continuously rather than in lurches.
class AppAnimatedProgressBar extends StatelessWidget {
  const AppAnimatedProgressBar({
    required this.value,
    this.minHeight = 6,
    this.semanticLabel,
    super.key,
  });

  /// Progress in the range 0..1.
  final double value;
  final double minHeight;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final target = value.clamp(0.0, 1.0);
    final bar = AppMotion.reducedMotion(context)
        ? LinearProgressIndicator(value: target, minHeight: minHeight)
        : TweenAnimationBuilder<double>(
            tween: Tween<double>(begin: 0, end: target),
            duration: AppMotion.slow,
            curve: AppMotion.standard,
            builder: (context, animated, child) =>
                LinearProgressIndicator(value: animated, minHeight: minHeight),
          );

    if (semanticLabel == null) {
      return bar;
    }
    return Semantics(
      label: semanticLabel,
      value: '${(target * 100).round()} percent complete',
      child: ExcludeSemantics(child: bar),
    );
  }
}

/// An integer that counts up to each new value instead of snapping.
///
/// Reserved for numbers the user is watching change (pages written, credits
/// added); static counts should stay plain [Text].
class AppAnimatedCount extends StatelessWidget {
  const AppAnimatedCount({
    required this.value,
    this.style,
    this.builder,
    super.key,
  });

  final int value;
  final TextStyle? style;

  /// Formats the interpolated value. Defaults to the bare number.
  final String Function(int value)? builder;

  @override
  Widget build(BuildContext context) {
    String format(int v) => builder?.call(v) ?? '$v';

    if (AppMotion.reducedMotion(context)) {
      return Text(format(value), style: style);
    }
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: value.toDouble(), end: value.toDouble()),
      duration: AppMotion.medium,
      curve: AppMotion.standard,
      builder: (context, animated, child) =>
          Text(format(animated.round()), style: style),
    );
  }
}

/// Cross-fades between children, sized to the incoming child.
///
/// The default [AnimatedSwitcher] jumps layout when children differ in height;
/// this keeps the transition calm inside chat bubbles and status cards.
class AppSwitcher extends StatelessWidget {
  const AppSwitcher({
    required this.child,
    this.alignment = Alignment.topCenter,
    this.duration = AppMotion.medium,
    super.key,
  });

  final Widget child;
  final Alignment alignment;
  final Duration duration;

  @override
  Widget build(BuildContext context) {
    if (AppMotion.reducedMotion(context)) {
      return child;
    }
    return AnimatedSwitcher(
      duration: duration,
      switchInCurve: AppMotion.enter,
      switchOutCurve: AppMotion.exit,
      layoutBuilder: (currentChild, previousChildren) => Stack(
        alignment: alignment,
        children: [...previousChildren, ?currentChild],
      ),
      transitionBuilder: (child, animation) => FadeTransition(
        opacity: animation,
        child: SizeTransition(
          sizeFactor: animation,
          alignment: Alignment.topCenter,
          child: child,
        ),
      ),
      child: child,
    );
  }
}

/// A soft, slow shimmer used for skeleton placeholders while content loads.
///
/// Skeletons that keep the shape of the real content make a load feel shorter
/// than a spinner does, because the user can already read the layout.
class AppShimmer extends StatefulWidget {
  const AppShimmer({required this.child, super.key});

  final Widget child;

  @override
  State<AppShimmer> createState() => _AppShimmerState();
}

class _AppShimmerState extends State<AppShimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (AppMotion.reducedMotion(context)) {
      return Opacity(opacity: 0.6, child: widget.child);
    }
    return FadeTransition(
      opacity: _controller.drive(
        Tween<double>(
          begin: 0.45,
          end: 0.85,
        ).chain(CurveTween(curve: AppMotion.standard)),
      ),
      child: widget.child,
    );
  }
}
