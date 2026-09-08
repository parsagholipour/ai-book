import 'package:flutter/material.dart';

/// The Keystone symbol: a sculpted T with a bookmark cut into its crown.
class TomezaBrandMark extends StatelessWidget {
  const TomezaBrandMark({
    super.key,
    this.size = 32,
    this.color,
    this.semanticLabel,
  });

  final double size;
  final Color? color;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final mark = SizedBox.square(
      dimension: size,
      child: CustomPaint(
        painter: _KeystoneMarkPainter(
          color ?? Theme.of(context).colorScheme.primary,
        ),
      ),
    );

    final label = semanticLabel;
    if (label == null) {
      return ExcludeSemantics(child: mark);
    }
    return Semantics(
      image: true,
      label: label,
      child: ExcludeSemantics(child: mark),
    );
  }
}

/// The preferred horizontal lockup used in app chrome and loading states.
class TomezaWordmark extends StatelessWidget {
  const TomezaWordmark({
    super.key,
    this.markSize = 28,
    this.gap = 9,
    this.markColor,
    this.textStyle,
  });

  final double markSize;
  final double gap;
  final Color? markColor;
  final TextStyle? textStyle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final resolvedTextStyle =
        textStyle ??
        theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800);

    return Semantics(
      label: 'Tomeza',
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TomezaBrandMark(
              size: markSize,
              color: markColor ?? theme.colorScheme.primary,
            ),
            SizedBox(width: gap),
            Text('Tomeza', style: resolvedTextStyle),
          ],
        ),
      ),
    );
  }
}

class _KeystoneMarkPainter extends CustomPainter {
  const _KeystoneMarkPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / 100, size.height / 100);

    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    final keystone = Path()
      ..fillType = PathFillType.evenOdd
      ..moveTo(10, 13)
      ..lineTo(90, 13)
      ..lineTo(82, 35)
      ..lineTo(61, 35)
      ..lineTo(61, 66)
      ..cubicTo(61, 77, 65, 82, 71, 88)
      ..lineTo(29, 88)
      ..cubicTo(35, 82, 39, 77, 39, 66)
      ..lineTo(39, 35)
      ..lineTo(18, 35)
      ..close()
      ..moveTo(45, 13)
      ..lineTo(55, 13)
      ..lineTo(55, 25)
      ..lineTo(50, 31)
      ..lineTo(45, 25)
      ..close();

    canvas.drawPath(keystone, paint);
    canvas.restore();
  }

  @override
  bool shouldRepaint(_KeystoneMarkPainter oldDelegate) =>
      oldDelegate.color != color;
}
