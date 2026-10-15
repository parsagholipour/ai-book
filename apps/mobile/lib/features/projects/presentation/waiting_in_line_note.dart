import 'package:flutter/material.dart';

import '../../../shared/ui/motion.dart';
import '../domain/project_models.dart';
import 'plan_build_progress.dart';

/// "Waiting in line — 2 books ahead of yours", under a book's progress while
/// its writing waits behind other readers' books.
///
/// The server runs one book's long work at a time, so a book approved at a
/// busy moment can sit at 0% for a while; without this the progress card read
/// as stuck. It is a calm line rather than a notice — nothing is wrong and
/// there is nothing to do — and it moves on its own: the hourglass turns over
/// every few seconds, and a new count rises into place as the line shortens.
/// Draws nothing when the book is not waiting.
class WaitingInLineNote extends StatelessWidget {
  const WaitingInLineNote({required this.status, this.color, super.key});

  final MobileProjectStatus status;

  /// Defaults to the theme's quiet text colour.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final label = status.waitingInLineLabel;
    if (label == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final tint = color ?? theme.colorScheme.onSurfaceVariant;
    return Semantics(
      liveRegion: true,
      label: label,
      child: ExcludeSemantics(
        child: Row(
          children: [
            _TurningHourglass(color: tint, size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: RisingStatusText(
                text: label,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tint,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// An hourglass that rests, then turns over — the same rhythm as sand
/// running out. Still under reduced motion.
class _TurningHourglass extends StatefulWidget {
  const _TurningHourglass({required this.color, required this.size});

  final Color color;
  final double size;

  @override
  State<_TurningHourglass> createState() => _TurningHourglassState();
}

class _TurningHourglassState extends State<_TurningHourglass>
    with SingleTickerProviderStateMixin {
  late final AnimationController _cycle = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 3200),
  );

  /// Rest for most of the cycle, then a half turn — which lands on itself.
  late final Animation<double> _turns = TweenSequence<double>([
    TweenSequenceItem(tween: ConstantTween(0), weight: 70),
    TweenSequenceItem(
      tween: Tween<double>(
        begin: 0,
        end: 0.5,
      ).chain(CurveTween(curve: AppMotion.standard)),
      weight: 30,
    ),
  ]).animate(_cycle);

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
    return RotationTransition(
      turns: _turns,
      child: Icon(
        Icons.hourglass_bottom_rounded,
        size: widget.size,
        color: widget.color,
      ),
    );
  }
}
