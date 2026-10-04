import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// An author's working copy. The cached vector settles into place once,
/// leaving the book still while the loading indicator continues.
class LaunchBookArt extends StatelessWidget {
  const LaunchBookArt({required this.reveal, super.key});

  static const assetName = 'assets/brand/launch-book.svg';

  final double reveal;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return ExcludeSemantics(
      child: Opacity(
        opacity: 0.65 + 0.35 * reveal,
        child: Transform.translate(
          offset: Offset(0, 8 * (1 - reveal)),
          child: RepaintBoundary(
            child: SvgPicture.asset(
              assetName,
              fit: BoxFit.contain,
              colorMapper: dark ? const _NightPalette() : null,
            ),
          ),
        ),
      ),
    );
  }
}

/// Only the backdrop changes at night; paper, ink, and brass retain their
/// material colors. Keep these source colors in sync with launch-book.svg.
class _NightPalette extends ColorMapper {
  const _NightPalette();

  @override
  Color substitute(
    String? id,
    String elementName,
    String attributeName,
    Color color,
  ) {
    return switch (color.toARGB32()) {
      0xFFEEF0E4 => const Color(0xFF22372B),
      0xFFE0E8DA => const Color(0xFF17281F),
      0xFFC6CEB8 => const Color(0xFF4A614A),
      0xFF173D32 => Colors.black,
      _ => color,
    };
  }
}
