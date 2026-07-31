import 'dart:math' as math;
import 'dart:ui';

/// Geometry for reader markup, expressed as fractions of a page.
///
/// Nothing here stores pixels. A highlight recorded at 0.1 of the way down the
/// page is still 0.1 of the way down after a zoom, a rotation, a screen change
/// or a reinstall onto a different device, whereas a pixel rectangle is only
/// meaningful for the one layout that produced it. The viewer hands us the
/// page's on-screen rectangle on every paint, so converting back is a
/// multiplication.
///
/// Values are not clamped on construction: a stroke drawn slightly past the
/// edge of a page is better kept as drawn and clipped when painted than
/// silently reshaped.
class NormPoint {
  const NormPoint(this.x, this.y);

  final double x;
  final double y;

  Offset toOffset(Rect pageRect) {
    return Offset(
      pageRect.left + x * pageRect.width,
      pageRect.top + y * pageRect.height,
    );
  }

  static NormPoint fromOffset(Offset offset, Rect pageRect) {
    if (pageRect.width <= 0 || pageRect.height <= 0) {
      return const NormPoint(0, 0);
    }
    return NormPoint(
      (offset.dx - pageRect.left) / pageRect.width,
      (offset.dy - pageRect.top) / pageRect.height,
    );
  }

  double distanceTo(NormPoint other) {
    final dx = x - other.x;
    final dy = y - other.y;
    return math.sqrt(dx * dx + dy * dy);
  }

  List<double> toJson() => [_round(x), _round(y)];

  static NormPoint? fromJson(Object? json) {
    if (json is! List || json.length < 2) {
      return null;
    }
    final x = _asDouble(json[0]);
    final y = _asDouble(json[1]);
    if (x == null || y == null) {
      return null;
    }
    return NormPoint(x, y);
  }

  @override
  bool operator ==(Object other) =>
      other is NormPoint && other.x == x && other.y == y;

  @override
  int get hashCode => Object.hash(x, y);

  @override
  String toString() => 'NormPoint($x, $y)';
}

/// A rectangle on a page, in the same fractional units as [NormPoint].
class NormRect {
  const NormRect(this.left, this.top, this.width, this.height);

  final double left;
  final double top;
  final double width;
  final double height;

  double get right => left + width;
  double get bottom => top + height;

  Rect toRect(Rect pageRect) {
    return Rect.fromLTWH(
      pageRect.left + left * pageRect.width,
      pageRect.top + top * pageRect.height,
      width * pageRect.width,
      height * pageRect.height,
    );
  }

  static NormRect fromRect(Rect rect, Rect pageRect) {
    if (pageRect.width <= 0 || pageRect.height <= 0) {
      return const NormRect(0, 0, 0, 0);
    }
    return NormRect(
      (rect.left - pageRect.left) / pageRect.width,
      (rect.top - pageRect.top) / pageRect.height,
      rect.width / pageRect.width,
      rect.height / pageRect.height,
    );
  }

  bool contains(NormPoint point) {
    return point.x >= left &&
        point.x <= right &&
        point.y >= top &&
        point.y <= bottom;
  }

  /// The same rectangle grown by [amount] on every side.
  ///
  /// A line of type is a couple of percent of the page tall, which is a much
  /// smaller target than a fingertip, so hit-testing markup works on the grown
  /// rectangle rather than the drawn one.
  NormRect inflate(double amount) {
    return NormRect(
      left - amount,
      top - amount,
      width + amount * 2,
      height + amount * 2,
    );
  }

  /// Whether the two rectangles share any area.
  bool overlaps(NormRect other) {
    return left < other.right &&
        other.left < right &&
        top < other.bottom &&
        other.top < bottom;
  }

  List<double> toJson() => [
    _round(left),
    _round(top),
    _round(width),
    _round(height),
  ];

  static NormRect? fromJson(Object? json) {
    if (json is! List || json.length < 4) {
      return null;
    }
    final values = [
      _asDouble(json[0]),
      _asDouble(json[1]),
      _asDouble(json[2]),
      _asDouble(json[3]),
    ];
    if (values.any((value) => value == null)) {
      return null;
    }
    return NormRect(values[0]!, values[1]!, values[2]!, values[3]!);
  }

  @override
  bool operator ==(Object other) =>
      other is NormRect &&
      other.left == left &&
      other.top == top &&
      other.width == width &&
      other.height == height;

  @override
  int get hashCode => Object.hash(left, top, width, height);

  @override
  String toString() => 'NormRect($left, $top, $width, $height)';
}

/// One continuous pen stroke.
///
/// [width] is a fraction of the page width rather than a pixel thickness, so a
/// line drawn on a phone keeps its weight relative to the text when the same
/// book is opened on a tablet.
class InkStroke {
  const InkStroke({
    required this.points,
    required this.colorIndex,
    required this.width,
  });

  final List<NormPoint> points;
  final int colorIndex;
  final double width;

  /// The smallest gap between recorded points.
  ///
  /// Touch screens report far more points than a stroke needs. Dropping the
  /// ones that land almost on top of the last keeps a page of drawing in
  /// kilobytes instead of hundreds of them, and the curve is visually identical.
  static const minimumSampleDistance = 0.002;

  /// Whether [point] falls within [tolerance] of the stroke.
  ///
  /// Measured against the segments, not just the recorded points, so the eraser
  /// catches the middle of a long straight line that has only two points.
  bool hitTest(NormPoint point, double tolerance) {
    if (points.isEmpty) {
      return false;
    }
    if (points.length == 1) {
      return points.first.distanceTo(point) <= tolerance;
    }
    for (var i = 0; i < points.length - 1; i++) {
      if (_distanceToSegment(point, points[i], points[i + 1]) <= tolerance) {
        return true;
      }
    }
    return false;
  }

  static double _distanceToSegment(NormPoint p, NormPoint a, NormPoint b) {
    final dx = b.x - a.x;
    final dy = b.y - a.y;
    final lengthSquared = dx * dx + dy * dy;
    if (lengthSquared == 0) {
      return p.distanceTo(a);
    }
    // Projection of p onto the segment, clamped to its ends.
    final t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared).clamp(
      0.0,
      1.0,
    );
    return p.distanceTo(NormPoint(a.x + t * dx, a.y + t * dy));
  }

  /// The stroke's bounding box, used to skip strokes that cannot be on screen.
  NormRect get bounds {
    if (points.isEmpty) {
      return const NormRect(0, 0, 0, 0);
    }
    var minX = points.first.x;
    var maxX = minX;
    var minY = points.first.y;
    var maxY = minY;
    for (final point in points) {
      minX = math.min(minX, point.x);
      maxX = math.max(maxX, point.x);
      minY = math.min(minY, point.y);
      maxY = math.max(maxY, point.y);
    }
    return NormRect(minX, minY, maxX - minX, maxY - minY);
  }

  Map<String, dynamic> toJson() {
    return {
      'colorIndex': colorIndex,
      'width': _round(width),
      'points': [
        for (final point in points) ...point.toJson(),
      ],
    };
  }

  /// Points are stored as one flat number list rather than nested pairs — a
  /// long stroke is mostly punctuation otherwise.
  static InkStroke? fromJson(Map<String, dynamic> json) {
    final raw = json['points'];
    if (raw is! List || raw.length < 2) {
      return null;
    }
    final points = <NormPoint>[];
    for (var i = 0; i + 1 < raw.length; i += 2) {
      final x = _asDouble(raw[i]);
      final y = _asDouble(raw[i + 1]);
      if (x == null || y == null) {
        return null;
      }
      points.add(NormPoint(x, y));
    }
    if (points.isEmpty) {
      return null;
    }
    return InkStroke(
      points: points,
      colorIndex: json['colorIndex'] as int? ?? 0,
      width: _asDouble(json['width']) ?? 0.004,
    );
  }
}

/// Six decimals is roughly a tenth of a pixel on a page rendered at any sane
/// size, and keeps the JSON a fraction of the size full doubles would need.
double _round(double value) => double.parse(value.toStringAsFixed(6));

double? _asDouble(Object? value) {
  if (value is double) {
    return value.isFinite ? value : null;
  }
  if (value is int) {
    return value.toDouble();
  }
  return null;
}
