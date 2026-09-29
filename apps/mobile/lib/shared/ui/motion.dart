import 'package:flutter/gestures.dart' show kTouchSlop;
import 'package:flutter/material.dart';

/// One motion vocabulary for the whole app.
///
/// Durations are deliberately short: this is a working tool, and motion is
/// there to explain what changed, not to make the user wait. Anything that sits
/// between a tap and a result stays under [medium].
abstract final class AppMotion {
  /// Press feedback: a control acknowledging a finger, well under a frame
  /// budget the eye can wait on.
  static const Duration instant = Duration(milliseconds: 90);

  /// State flips that must feel instant: icon swaps, colour changes.
  static const Duration fast = Duration(milliseconds: 140);

  /// The default for content entering, leaving, or resizing.
  static const Duration medium = Duration(milliseconds: 260);

  /// Screen-level transitions and celebratory moments.
  static const Duration slow = Duration(milliseconds: 420);

  /// One page-to-page navigation. Slower than [medium] because the whole
  /// screen moves, quicker than the platform's 450ms because this is a tool.
  static const Duration page = Duration(milliseconds: 320);

  /// One full cycle of a skeleton's shimmer.
  static const Duration shimmer = Duration(milliseconds: 1400);

  /// Decelerating curve for content arriving on screen.
  static const Curve enter = Curves.easeOutCubic;

  /// Accelerating curve for content leaving.
  static const Curve exit = Curves.easeInCubic;

  /// Symmetric curve for a value moving between two known states.
  static const Curve standard = Curves.easeInOutCubic;

  /// Slight overshoot for elements that should feel physical (badges, covers).
  static const Curve emphasized = Curves.easeOutBack;

  /// Material's emphasized-decelerate: a long, soft landing for large
  /// surfaces (sheets, whole screens) arriving.
  static const Curve enterEmphasized = Cubic(0.05, 0.7, 0.1, 1.0);

  /// Material's emphasized-accelerate: large surfaces leaving quickly.
  static const Curve exitEmphasized = Cubic(0.3, 0.0, 0.8, 0.15);

  /// How far a pressed control shrinks. Small enough to read as "it took the
  /// tap", never as "it moved".
  static const double pressedScale = 0.98;

  /// Per-item delay when a list staggers itself in.
  static const Duration stagger = Duration(milliseconds: 45);

  /// Longest stagger delay we will apply, so a long list never feels slow.
  static const int maxStaggerSteps = 8;

  /// True when the platform asks for reduced motion. Every animation helper in
  /// this file degrades to an instant state change when this is set.
  static bool reducedMotion(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  /// [base], or [Duration.zero] when the platform asks for reduced motion.
  ///
  /// For implicit animations (`AnimatedContainer`, `AnimatedSize`, ...), which
  /// have no other way to opt out.
  static Duration adapt(BuildContext context, Duration base) =>
      reducedMotion(context) ? Duration.zero : base;
}

/// Shrinks its child a touch while a finger is down on it.
///
/// It listens to raw pointers rather than a gesture, so it never joins the
/// gesture arena and cannot change which widget wins a tap or a scroll. The
/// press is dropped as soon as the finger travels far enough to be a scroll,
/// so a list dragged from a card does not leave that card sunk.
class AppPressScale extends StatefulWidget {
  const AppPressScale({
    required this.child,
    this.enabled = true,
    this.scale = AppMotion.pressedScale,
    super.key,
  });

  final Widget child;

  /// False for a disabled control, which acknowledges nothing.
  final bool enabled;
  final double scale;

  @override
  State<AppPressScale> createState() => _AppPressScaleState();
}

class _AppPressScaleState extends State<AppPressScale> {
  bool _pressed = false;
  Offset? _downAt;

  void _setPressed(bool value) {
    if (_pressed == value || !mounted) return;
    setState(() => _pressed = value);
  }

  void _down(PointerDownEvent event) {
    _downAt = event.position;
    _setPressed(true);
  }

  void _move(PointerMoveEvent event) {
    final start = _downAt;
    if (start != null && (event.position - start).distance > kTouchSlop) {
      _setPressed(false);
    }
  }

  void _end(PointerEvent event) {
    _downAt = null;
    _setPressed(false);
  }

  @override
  void didUpdateWidget(AppPressScale oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled) _setPressed(false);
  }

  @override
  Widget build(BuildContext context) {
    // The wrappers are always there, live or not: a control that flips between
    // enabled and disabled (a button starting to load) must keep its place in
    // the tree, or everything beneath it is rebuilt from nothing and cannot
    // animate the change.
    final live = widget.enabled && !AppMotion.reducedMotion(context);
    return Listener(
      onPointerDown: live ? _down : null,
      onPointerMove: live ? _move : null,
      onPointerUp: _end,
      onPointerCancel: _end,
      child: AnimatedScale(
        scale: live && _pressed ? widget.scale : 1,
        duration: AppMotion.instant,
        curve: AppMotion.standard,
        child: widget.child,
      ),
    );
  }
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
          // The first frame is fully transparent, and a transparent subtree
          // drops out of the semantics tree: a screen reader would lose the
          // content for exactly as long as it is arriving.
          alwaysIncludeSemantics: true,
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
        child: _ShadowSafeSize(animation: animation, child: child),
      ),
      child: child,
    );
  }
}

/// A soft, slow shimmer used for skeleton placeholders while content loads.
///
/// Skeletons that keep the shape of the real content make a load feel shorter
/// than a spinner does, because the user can already read the layout.
///
/// By default the whole child breathes (an opacity pulse). With [sweep] a band
/// of light travels across the child instead, which reads as "being fetched"
/// rather than "disabled"; it needs the child to be opaque blocks (see
/// `AppSkeleton`). Both stand still when the platform asks for reduced motion,
/// and stop their ticker rather than just hiding it, so a screen in reduced
/// motion settles under `pumpAndSettle`.
class AppShimmer extends StatefulWidget {
  const AppShimmer({required this.child, this.sweep = false, super.key});

  final Widget child;
  final bool sweep;

  @override
  State<AppShimmer> createState() => _AppShimmerState();
}

class _AppShimmerState extends State<AppShimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.shimmer,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncTicker();
  }

  @override
  void didUpdateWidget(AppShimmer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sweep != widget.sweep) {
      _controller.stop();
      _syncTicker();
    }
  }

  void _syncTicker() {
    if (AppMotion.reducedMotion(context)) {
      _controller.stop();
      return;
    }
    if (!_controller.isAnimating) {
      _controller.repeat(reverse: !widget.sweep);
    }
  }

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
    if (widget.sweep) {
      final light = Theme.of(context).brightness == Brightness.light;
      final band = Colors.white.withValues(alpha: light ? 0.55 : 0.10);
      final clear = band.withValues(alpha: 0);
      final direction = Directionality.of(context);
      return AnimatedBuilder(
        animation: _controller,
        child: widget.child,
        builder: (context, child) => ShaderMask(
          blendMode: BlendMode.srcATop,
          shaderCallback: (bounds) => LinearGradient(
            colors: [clear, band, clear],
            stops: const [0.3, 0.5, 0.7],
            transform: _SweepTransform(_controller.value, direction),
          ).createShader(bounds, textDirection: direction),
          child: child,
        ),
      );
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

/// Slides a gradient from one side of its box to beyond the other.
class _SweepTransform extends GradientTransform {
  const _SweepTransform(this.progress, this.direction);

  final double progress;
  final TextDirection direction;

  @override
  Matrix4? transform(Rect bounds, {TextDirection? textDirection}) {
    // -1..+1 of the width, so the band starts fully off one edge and leaves
    // fully off the other; mirrored in right-to-left layouts.
    final slide = (progress * 2 - 1) * bounds.width;
    return Matrix4.translationValues(
      direction == TextDirection.rtl ? -slide : slide,
      0,
      0,
    );
  }
}

/// A [SizeTransition] that does not clip the child's shadow.
///
/// `SizeTransition` wraps its child in a `ClipRect` sized to the animated box,
/// and that stays true when the animation has finished: a card with an
/// elevation shadow, sitting in an `AppSwitcher`, had the shadow sliced off at
/// its edges. This clips only while the size is still changing, and even then
/// lets the shadow bleed out sideways and upward. Once settled it also lets it
/// bleed below.
class _ShadowSafeSize extends StatelessWidget {
  const _ShadowSafeSize({required this.animation, required this.child});

  final Animation<double> animation;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: animation,
      child: child,
      builder: (context, child) => ClipRect(
        clipper: _ShadowBleedClipper(animation),
        child: Align(
          alignment: Alignment.topCenter,
          heightFactor: animation.value.clamp(0.0, 1.0),
          child: child,
        ),
      ),
    );
  }
}

class _ShadowBleedClipper extends CustomClipper<Rect> {
  _ShadowBleedClipper(this.animation) : super(reclip: animation);

  final Animation<double> animation;

  /// More than any shadow the theme casts (a card's is about 16px).
  static const double _bleed = 32;

  @override
  Rect getClip(Size size) {
    final settled = animation.value >= 1;
    return Rect.fromLTRB(
      -_bleed,
      -_bleed,
      size.width + _bleed,
      size.height + (settled ? _bleed : 0),
    );
  }

  @override
  bool shouldReclip(_ShadowBleedClipper oldClipper) =>
      oldClipper.animation != animation;
}
