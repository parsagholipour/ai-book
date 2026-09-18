import 'package:flutter/material.dart';

/// The Promptbook symbol: an open book inside a speech bubble.
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
    final mark = Image.asset(
      'assets/brand/tomeza-promptbook-symbol.png',
      width: size,
      height: size,
      fit: BoxFit.contain,
      color: color ?? Theme.of(context).colorScheme.primary,
      colorBlendMode: BlendMode.srcIn,
      filterQuality: FilterQuality.high,
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
