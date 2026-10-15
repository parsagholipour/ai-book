import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'design_system/app_tokens.dart';

/// A small control that answers a full-size touch without taking full-size
/// room in the layout.
///
/// Some controls are drawn small on purpose and sit inside a padded surface —
/// the pencil beside a sent message, the branch arrows under it. A 48dp box
/// around each pushed the bubble 16dp taller; at their drawn size they were
/// easy to miss. So the control keeps its drawn size in the layout, and:
///
/// - its accessibility node reports a box at least [minSize] square, centred
///   on it, so a screen reader and the accessibility scanner see a full-size
///   target (the node merges the control's own label and actions);
/// - a touch inside that box but outside the control is handed to it by the
///   nearest [TouchTargetRegion] — the padded surface — which is the only
///   ancestor large enough to receive the touch at all.
///
/// Without a region the control still works at its drawn size.
class TouchTarget extends SingleChildRenderObjectWidget {
  const TouchTarget({
    required super.child,
    this.minSize = AppSizes.minimumTouchTarget,
    super.key,
  });

  final double minSize;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderTouchTarget(minSize);

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderTouchTarget renderObject,
  ) {
    renderObject.minSize = minSize;
  }
}

/// The padded surface whose [TouchTarget]s answer touches beyond their drawn
/// size. Wrap the surface's whole box — the padding is where those touches
/// land.
class TouchTargetRegion extends SingleChildRenderObjectWidget {
  const TouchTargetRegion({required super.child, super.key});

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderTouchTargetRegion();
}

class RenderTouchTarget extends RenderProxyBox {
  RenderTouchTarget(this._minSize);

  double _minSize;
  double get minSize => _minSize;
  set minSize(double value) {
    if (value == _minSize) return;
    _minSize = value;
    markNeedsSemanticsUpdate();
  }

  RenderTouchTargetRegion? _region;

  /// This control's touch box in its own coordinates.
  Rect get touchRect {
    final width = size.width < minSize ? minSize : size.width;
    final height = size.height < minSize ? minSize : size.height;
    return Rect.fromCenter(
      center: size.center(Offset.zero),
      width: width,
      height: height,
    );
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    var ancestor = parent;
    while (ancestor != null && ancestor is! RenderTouchTargetRegion) {
      ancestor = ancestor.parent;
    }
    _region = ancestor as RenderTouchTargetRegion?;
    _region?._targets.add(this);
  }

  @override
  void detach() {
    _region?._targets.remove(this);
    _region = null;
    super.detach();
  }

  @override
  Rect get semanticBounds => touchRect;

  @override
  void describeSemanticsConfiguration(SemanticsConfiguration config) {
    super.describeSemanticsConfiguration(config);
    // One node, sized as the touch, carrying the control's label and actions.
    config
      ..isSemanticBoundary = true
      ..isMergingSemanticsOfDescendants = true;
  }
}

class RenderTouchTargetRegion extends RenderProxyBox {
  final Set<RenderTouchTarget> _targets = {};

  @override
  bool hitTest(BoxHitTestResult result, {required Offset position}) {
    if (!size.contains(position)) return false;
    final redirected = _redirect(position);
    return super.hitTest(result, position: redirected ?? position);
  }

  /// The point inside a target's drawn box that a touch at [position] stands
  /// for, when it fell in that target's touch box but outside what is drawn.
  /// The nearest target wins where two touch boxes overlap.
  Offset? _redirect(Offset position) {
    Offset? best;
    var bestDistance = double.infinity;
    for (final target in _targets) {
      if (!target.attached || !target.hasSize) continue;
      final transform = target.getTransformTo(this);
      final drawn = MatrixUtils.transformRect(
        transform,
        Offset.zero & target.size,
      );
      if (drawn.contains(position)) return null;
      final touch = MatrixUtils.transformRect(transform, target.touchRect);
      if (!touch.contains(position)) continue;
      final inside = Offset(
        position.dx.clamp(drawn.left + 1, drawn.right - 1),
        position.dy.clamp(drawn.top + 1, drawn.bottom - 1),
      );
      final distance = (inside - position).distanceSquared;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = inside;
      }
    }
    return best;
  }
}
