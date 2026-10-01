import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import '../../../shared/ui/app_components.dart';

/// An [AppToggleTile] that keeps one height whichever way it is switched.
///
/// A switch's two subtitles differ in length — "Free: a designed cover is
/// chosen to match your book." against "One cover image drawn for your book,
/// 45 credits." — so the card grew or shrank under the finger and moved the
/// switch below it to where the next tap was about to land. The first tap
/// also adds a "Your choice" badge, which wraps to a line of its own on a
/// phone. Every variant is laid out; the tile takes the tallest height and
/// only the current one is painted, tapped, announced or found by a test.
class StableToggleTile extends StatelessWidget {
  const StableToggleTile({
    required this.value,
    required this.tileFor,
    this.chosen = false,
    this.canBeChosen = false,
    super.key,
  });

  final bool value;

  /// Whether the tile wears its "Your choice" badge now.
  final bool chosen;

  /// Whether it can come to wear one, so its room is held from the start.
  final bool canBeChosen;

  /// The tile as it looks switched to [value], with or without the badge.
  final AppToggleTile Function(bool value, bool chosen) tileFor;

  @override
  Widget build(BuildContext context) {
    return TallestOf(
      index: 0,
      children: [
        tileFor(value, chosen),
        for (final on in const [true, false]) ...[
          tileFor(on, chosen),
          if (canBeChosen && !chosen) tileFor(on, true),
        ],
      ],
    );
  }
}

/// Lays out every child at the incoming width, sizes itself to the tallest,
/// and shows only the child at [index], stretched to that height. The others
/// are measured and nothing else: not painted, not hit-tested, not in the
/// semantics tree and, like `IndexedStack`'s, offstage to finders.
class TallestOf extends MultiChildRenderObjectWidget {
  const TallestOf({required this.index, required super.children, super.key});

  final int index;

  @override
  RenderTallestOf createRenderObject(BuildContext context) =>
      RenderTallestOf(index);

  @override
  void updateRenderObject(BuildContext context, RenderTallestOf renderObject) {
    renderObject.index = index;
  }

  @override
  MultiChildRenderObjectElement createElement() => _TallestOfElement(this);
}

class _TallestOfElement extends MultiChildRenderObjectElement {
  _TallestOfElement(TallestOf super.widget);

  @override
  void debugVisitOnstageChildren(ElementVisitor visitor) {
    final index = (widget as TallestOf).index;
    var position = 0;
    for (final child in children) {
      if (position++ == index) visitor(child);
    }
  }
}

class _TallestOfParentData extends ContainerBoxParentData<RenderBox> {}

class RenderTallestOf extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _TallestOfParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _TallestOfParentData> {
  RenderTallestOf(this._index);

  int _index;
  set index(int value) {
    if (_index == value) return;
    _index = value;
    markNeedsLayout();
    markNeedsSemanticsUpdate();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _TallestOfParentData) {
      child.parentData = _TallestOfParentData();
    }
  }

  RenderBox? get _shown {
    var position = 0;
    for (var child = firstChild; child != null; child = childAfter(child)) {
      if (position++ == _index) return child;
    }
    return null;
  }

  Size _measure(
    BoxConstraints constraints,
    Size Function(RenderBox, BoxConstraints) sizeOf,
  ) {
    final loose = constraints.widthConstraints();
    var width = constraints.minWidth;
    var height = 0.0;
    for (var child = firstChild; child != null; child = childAfter(child)) {
      final childSize = sizeOf(child, loose);
      width = math.max(width, childSize.width);
      height = math.max(height, childSize.height);
    }
    return constraints.constrain(Size(width, height));
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) =>
      _measure(constraints, (child, loose) => child.getDryLayout(loose));

  @override
  void performLayout() {
    size = _measure(constraints, (child, loose) {
      child.layout(loose, parentUsesSize: true);
      return child.size;
    });
    _shown?.layout(BoxConstraints.tight(size));
  }

  double _maxOf(double Function(RenderBox child) measure) {
    var result = 0.0;
    for (var child = firstChild; child != null; child = childAfter(child)) {
      result = math.max(result, measure(child));
    }
    return result;
  }

  @override
  double computeMinIntrinsicWidth(double height) =>
      _maxOf((child) => child.getMinIntrinsicWidth(height));

  @override
  double computeMaxIntrinsicWidth(double height) =>
      _maxOf((child) => child.getMaxIntrinsicWidth(height));

  @override
  double computeMinIntrinsicHeight(double width) =>
      _maxOf((child) => child.getMinIntrinsicHeight(width));

  @override
  double computeMaxIntrinsicHeight(double width) =>
      _maxOf((child) => child.getMaxIntrinsicHeight(width));

  @override
  void paint(PaintingContext context, Offset offset) {
    final shown = _shown;
    if (shown != null) context.paintChild(shown, offset);
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      _shown?.hitTest(result, position: position) ?? false;

  @override
  void visitChildrenForSemantics(RenderObjectVisitor visitor) {
    final shown = _shown;
    if (shown != null) visitor(shown);
  }
}
