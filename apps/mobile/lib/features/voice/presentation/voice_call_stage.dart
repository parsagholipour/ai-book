import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../shared/ui/design_system/app_tokens.dart';
import '../../../shared/ui/motion.dart';
import '../domain/voice_models.dart';
import 'voice_call_avatar.dart';
import 'voice_call_controller.dart';

/// What the call is doing, in the words a caller would use.
///
/// A voice call has no other visual feedback, so this is how "they are thinking"
/// is told apart from "the line is dead". The controller only knows whether the
/// character is speaking; the rest is read off the captions.
enum VoiceCallMood {
  connecting,
  preparing,
  listening,
  thinking,
  speaking,
  muted,
  reconnecting,
  ended,
  failed,
}

/// The mood a call is in.
///
/// [callerQuiet] is the one input the state cannot supply: the caller has said
/// something, stopped, and no reply has started. Until then a caption that is
/// still growing means they are talking, not waiting.
VoiceCallMood callMoodOf(VoiceCallState state, {required bool callerQuiet}) {
  return switch (state.phase) {
    VoiceCallPhase.idle || VoiceCallPhase.ringing => VoiceCallMood.connecting,
    VoiceCallPhase.preparing => VoiceCallMood.preparing,
    VoiceCallPhase.reconnecting => VoiceCallMood.reconnecting,
    VoiceCallPhase.ended => VoiceCallMood.ended,
    VoiceCallPhase.failed => VoiceCallMood.failed,
    VoiceCallPhase.connected =>
      state.characterSpeaking ||
              state.liveCaptions.any(
                (line) => line.speaker == VoiceCallSpeaker.character,
              )
          ? VoiceCallMood.speaking
          : state.muted
          ? VoiceCallMood.muted
          : callerQuiet &&
                state.liveCaptions.any(
                  (line) => line.speaker == VoiceCallSpeaker.caller,
                )
          ? VoiceCallMood.thinking
          : VoiceCallMood.listening,
  };
}

/// The character's face with a ring around it that changes with the mood:
/// ripples while the line is being opened, a steady ring while they listen, a
/// sweeping arc while they think, and a waveform while they speak.
///
/// Only the moods that mean "something is happening" move, and only the
/// ripples of a call still being opened are allowed to run out — a screen left
/// on a steady ring costs nothing, and reduced motion holds every mood still.
class VoiceCallStage extends StatefulWidget {
  const VoiceCallStage({
    required this.character,
    required this.mood,
    required this.muted,
    this.diameter = 168,
    super.key,
  });

  final VoiceCharacter character;
  final VoiceCallMood mood;

  /// Whether the caller's microphone is off, shown on the face whatever else
  /// the mood is: a muted caller can still be listening to a reply.
  final bool muted;
  final double diameter;

  @override
  State<VoiceCallStage> createState() => _VoiceCallStageState();
}

class _VoiceCallStageState extends State<VoiceCallStage>
    with SingleTickerProviderStateMixin {
  /// One cycle is long enough for every motion below to be a whole number of
  /// repeats of itself, so the loop never shows a seam.
  late final AnimationController _cycle = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 4800),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(covariant VoiceCallStage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.mood != widget.mood) {
      _sync();
    }
  }

  static bool _moves(VoiceCallMood mood) => switch (mood) {
    VoiceCallMood.connecting ||
    VoiceCallMood.preparing ||
    VoiceCallMood.reconnecting ||
    VoiceCallMood.thinking ||
    VoiceCallMood.speaking => true,
    _ => false,
  };

  void _sync() {
    if (!_moves(widget.mood) || AppMotion.reducedMotion(context)) {
      _cycle.stop();
      return;
    }
    if (widget.mood == VoiceCallMood.connecting) {
      // A handshake takes seconds. Ripples for a few cycles say "ringing"; past
      // that they would be promising progress nobody is making.
      _cycle
        ..reset()
        ..repeat(count: 4);
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
    final colors = Theme.of(context).colorScheme;
    final diameter = widget.diameter;
    final reach = diameter * 0.26;
    final moving = _moves(widget.mood) && !AppMotion.reducedMotion(context);
    final tone = widget.mood == VoiceCallMood.reconnecting
        ? colors.tertiary
        : widget.mood == VoiceCallMood.failed
        ? colors.error
        : colors.primary;

    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: diameter + reach * 2,
        child: Stack(
          alignment: Alignment.center,
          children: [
            AnimatedBuilder(
              animation: _cycle,
              builder: (context, _) => CustomPaint(
                size: Size.square(diameter + reach * 2),
                painter: _StagePainter(
                  mood: widget.mood,
                  t: moving ? _cycle.value : null,
                  faceRadius: diameter / 2,
                  color: tone,
                  quiet: colors.outlineVariant,
                ),
              ),
            ),
            VoiceCallFace(character: widget.character, diameter: diameter),
            if (widget.muted)
              PositionedDirectional(
                end: reach + diameter * 0.02,
                bottom: reach + diameter * 0.02,
                child: Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    color: colors.inverseSurface,
                    shape: BoxShape.circle,
                    border: Border.all(color: colors.surface, width: 3),
                  ),
                  child: Icon(
                    Icons.mic_off,
                    size: 17,
                    color: colors.onInverseSurface,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _StagePainter extends CustomPainter {
  const _StagePainter({
    required this.mood,
    required this.t,
    required this.faceRadius,
    required this.color,
    required this.quiet,
  });

  final VoiceCallMood mood;

  /// Position in the 4.8 s cycle, or null when nothing is to move.
  final double? t;
  final double faceRadius;
  final Color color;
  final Color quiet;

  static const _barCount = 44;

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.center(Offset.zero);
    final inner = faceRadius + 8;
    final reach = size.shortestSide / 2 - inner;
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;

    switch (mood) {
      case VoiceCallMood.connecting:
      case VoiceCallMood.preparing:
      case VoiceCallMood.reconnecting:
        if (t == null) {
          canvas.drawCircle(
            centre,
            inner,
            ring..color = color.withValues(alpha: 0.4),
          );
          return;
        }
        // Three rings, a third of a cycle apart, each fading as it leaves.
        for (var i = 0; i < 3; i += 1) {
          final phase = (t! * 2 + i / 3) % 1;
          canvas.drawCircle(
            centre,
            inner + reach * Curves.easeOut.transform(phase),
            ring..color = color.withValues(alpha: 0.42 * (1 - phase)),
          );
        }
      case VoiceCallMood.listening:
        canvas.drawCircle(
          centre,
          inner,
          ring..color = color.withValues(alpha: 0.55),
        );
        canvas.drawCircle(
          centre,
          inner + reach * 0.4,
          ring..color = color.withValues(alpha: 0.16),
        );
      case VoiceCallMood.muted:
        _dashedRing(canvas, centre, inner, quiet.withValues(alpha: 1));
      case VoiceCallMood.thinking:
        canvas.drawCircle(
          centre,
          inner,
          ring..color = color.withValues(alpha: 0.16),
        );
        final start = t == null ? -math.pi / 2 : t! * 3 * 2 * math.pi;
        final arc = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 4
          ..strokeCap = StrokeCap.round
          ..color = color;
        final rect = Rect.fromCircle(center: centre, radius: inner);
        canvas.drawArc(rect, start, 1.5, false, arc);
        canvas.drawArc(
          rect,
          start + math.pi,
          0.7,
          false,
          arc..color = color.withValues(alpha: 0.5),
        );
      case VoiceCallMood.speaking:
        // A soft glow under the bars so the waveform sits on the face.
        canvas.drawCircle(
          centre,
          inner + reach * 0.2,
          Paint()..color = color.withValues(alpha: 0.10),
        );
        final bar = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3.2
          ..strokeCap = StrokeCap.round
          ..color = color;
        for (var i = 0; i < _barCount; i += 1) {
          final angle = i / _barCount * 2 * math.pi - math.pi / 2;
          final level = t == null
              ? 0.35 + 0.3 * math.sin(i * 0.9).abs()
              : 0.5 +
                    0.5 *
                        math.sin(2 * math.pi * (t! * 4 + i * 0.13)) *
                        (0.6 +
                            0.4 * math.sin(2 * math.pi * (t! * 3 + i * 0.29)));
          final length = 3 + (reach - 4) * level.clamp(0.0, 1.0);
          final direction = Offset(math.cos(angle), math.sin(angle));
          canvas.drawLine(
            centre + direction * (inner + 2),
            centre + direction * (inner + 2 + length),
            bar,
          );
        }
      case VoiceCallMood.ended:
        canvas.drawCircle(centre, inner, ring..color = quiet);
      case VoiceCallMood.failed:
        canvas.drawCircle(
          centre,
          inner,
          ring..color = color.withValues(alpha: 0.6),
        );
    }
  }

  void _dashedRing(Canvas canvas, Offset centre, double radius, Color colour) {
    final dash = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.4
      ..strokeCap = StrokeCap.round
      ..color = colour;
    const count = 36;
    final rect = Rect.fromCircle(center: centre, radius: radius);
    for (var i = 0; i < count; i += 1) {
      canvas.drawArc(rect, i / count * 2 * math.pi, 0.09, false, dash);
    }
  }

  @override
  bool shouldRepaint(covariant _StagePainter oldDelegate) =>
      oldDelegate.mood != mood ||
      oldDelegate.t != t ||
      oldDelegate.faceRadius != faceRadius ||
      oldDelegate.color != color ||
      oldDelegate.quiet != quiet;
}

/// Tracks whether the caller has gone quiet after speaking, which is the only
/// thing the captions can say about "thinking".
///
/// A caption that has not grown for [quietAfter] and has no reply after it is a
/// caller who has finished. Owned by the widget that draws the stage rather than
/// the controller: it is a fact about what is on screen, not about the call.
class VoiceCallMoodBuilder extends StatefulWidget {
  const VoiceCallMoodBuilder({
    required this.state,
    required this.builder,
    super.key,
  });

  final VoiceCallState state;
  final Widget Function(BuildContext context, VoiceCallMood mood) builder;

  static const quietAfter = Duration(milliseconds: 1200);

  @override
  State<VoiceCallMoodBuilder> createState() => _VoiceCallMoodBuilderState();
}

class _VoiceCallMoodBuilderState extends State<VoiceCallMoodBuilder> {
  String _callerLine = '';
  bool _quiet = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  @override
  void didUpdateWidget(covariant VoiceCallMoodBuilder oldWidget) {
    super.didUpdateWidget(oldWidget);
    _watch();
  }

  String _callerLineOf(VoiceCallState state) {
    for (final line in state.liveCaptions) {
      if (line.speaker == VoiceCallSpeaker.caller) {
        return line.text;
      }
    }
    return '';
  }

  /// Restarts the countdown whenever the caller's line changes, and clears it
  /// when there is no line to wait on.
  void _watch() {
    final line = _callerLineOf(widget.state);
    if (line == _callerLine) {
      return;
    }
    _callerLine = line;
    _timer?.cancel();
    _quiet = false;
    if (line.isNotEmpty) {
      _timer = Timer(VoiceCallMoodBuilder.quietAfter, () {
        if (mounted) {
          setState(() => _quiet = true);
        }
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.builder(
      context,
      callMoodOf(widget.state, callerQuiet: _quiet),
    );
  }
}

/// The mood, named, under the timer: an icon and a word, so the state reads
/// without watching the animation and reads to a screen reader at all.
class VoiceCallMoodPill extends StatelessWidget {
  const VoiceCallMoodPill({
    required this.mood,
    required this.characterName,
    super.key,
  });

  final VoiceCallMood mood;
  final String characterName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final (icon, label) = switch (mood) {
      VoiceCallMood.listening => (Icons.mic_none, 'Listening'),
      VoiceCallMood.thinking => (Icons.more_horiz, 'Thinking…'),
      VoiceCallMood.speaking => (
        Icons.graphic_eq,
        '$characterName is speaking',
      ),
      VoiceCallMood.muted => (Icons.mic_off, 'You are muted'),
      _ => (Icons.circle, ''),
    };
    if (label.isEmpty) {
      return const SizedBox.shrink();
    }
    final highlighted =
        mood == VoiceCallMood.speaking || mood == VoiceCallMood.thinking;
    return AnimatedContainer(
      duration: AppMotion.fast,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: highlighted
            ? colors.primaryContainer
            : colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            icon,
            size: 16,
            color: highlighted
                ? colors.onPrimaryContainer
                : colors.onSurfaceVariant,
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w700,
                color: highlighted
                    ? colors.onPrimaryContainer
                    : colors.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
