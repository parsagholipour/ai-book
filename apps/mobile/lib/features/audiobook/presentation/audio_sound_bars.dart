import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/motion.dart';

/// Three bars that dance while [active] and stand at rest otherwise.
///
/// The mark for "there is sound coming from this": the chapter that is playing,
/// the narrator sample that is being previewed. It moves only while it is true,
/// and never under reduced motion, where the resting bars still say which item
/// is meant.
class AudioSoundBars extends StatefulWidget {
  const AudioSoundBars({
    required this.active,
    required this.color,
    this.size = 16,
    super.key,
  });

  final bool active;
  final Color color;
  final double size;

  @override
  State<AudioSoundBars> createState() => _AudioSoundBarsState();
}

class _AudioSoundBarsState extends State<AudioSoundBars>
    with SingleTickerProviderStateMixin {
  late final AnimationController _cycle = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(covariant AudioSoundBars oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  void _sync() {
    final run = widget.active && !AppMotion.reducedMotion(context);
    if (run && !_cycle.isAnimating) {
      _cycle.repeat();
    } else if (!run && _cycle.isAnimating) {
      _cycle.stop();
    }
  }

  @override
  void dispose() {
    _cycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: widget.size,
        child: AnimatedBuilder(
          animation: _cycle,
          builder: (context, _) => CustomPaint(
            painter: _SoundBarsPainter(
              t: _cycle.isAnimating ? _cycle.value : null,
              color: widget.color,
            ),
          ),
        ),
      ),
    );
  }
}

class _SoundBarsPainter extends CustomPainter {
  const _SoundBarsPainter({required this.t, required this.color});

  /// Position in the cycle, or null when the bars are at rest.
  final double? t;
  final Color color;

  static const _rest = [0.45, 0.85, 0.6];

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    final barWidth = size.width / 5;
    for (var i = 0; i < 3; i += 1) {
      final phase = t == null ? null : (t! + i / 3) * 2 * math.pi;
      final level = phase == null
          ? _rest[i]
          : 0.5 +
                0.5 *
                    math.sin(phase + i * 1.3) *
                    (0.75 + 0.25 * math.sin(phase * 2));
      final height = size.height * (0.28 + 0.72 * level.clamp(0.0, 1.0));
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(
            barWidth * i * 2,
            size.height - height,
            barWidth,
            height,
          ),
          Radius.circular(barWidth / 2),
        ),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _SoundBarsPainter oldDelegate) =>
      oldDelegate.t != t || oldDelegate.color != color;
}
