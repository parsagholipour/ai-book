import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/config/app_config.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/data/projects_repository.dart';
import '../domain/voice_models.dart';

/// The character's face, with a ring that breathes while they are talking.
///
/// A voice call has no other visual feedback, so the ring is doing real work:
/// it is how you tell "they are thinking" from "the line is dead". It stops
/// entirely when the platform asks for reduced motion, where a static ring plus
/// the caption feed carries the same information.
class VoiceCallAvatar extends StatefulWidget {
  const VoiceCallAvatar({
    required this.character,
    required this.speaking,
    required this.connected,
    this.diameter = 168,
    super.key,
  });

  final VoiceCharacter character;
  final bool speaking;
  final bool connected;
  final double diameter;

  @override
  State<VoiceCallAvatar> createState() => _VoiceCallAvatarState();
}

class _VoiceCallAvatarState extends State<VoiceCallAvatar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncAnimation();
  }

  @override
  void didUpdateWidget(VoiceCallAvatar oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncAnimation();
  }

  void _syncAnimation() {
    final shouldAnimate = widget.speaking && !AppMotion.reducedMotion(context);
    if (shouldAnimate && !_pulse.isAnimating) {
      _pulse.repeat(reverse: true);
    } else if (!shouldAnimate && _pulse.isAnimating) {
      _pulse.stop();
      _pulse.animateTo(0, duration: AppMotion.fast);
    }
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: _pulse,
      builder: (context, child) {
        final spread = 6 + _pulse.value * 14;
        return Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: widget.connected
                  ? colors.primary.withValues(alpha: 0.35 + _pulse.value * 0.5)
                  : colors.outlineVariant,
              width: 2,
            ),
            boxShadow: widget.speaking
                ? [
                    BoxShadow(
                      color: colors.primary.withValues(alpha: 0.18),
                      blurRadius: spread * 2,
                      spreadRadius: spread / 3,
                    ),
                  ]
                : null,
          ),
          padding: const EdgeInsets.all(6),
          child: child,
        );
      },
      child: _AvatarFace(character: widget.character, diameter: widget.diameter),
    );
  }
}

/// Character portraits are served behind the mobile bearer token, so they load
/// with explicit auth headers rather than as a plain network image.
class _AvatarFace extends ConsumerWidget {
  const _AvatarFace({required this.character, required this.diameter});

  final VoiceCharacter character;
  final double diameter;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final image = character.image;
    final initials = _Initials(name: character.name);

    Widget face = initials;
    if (image != null) {
      final headers = ref.watch(projectAssetHeadersProvider).value;
      if (headers != null) {
        final uri = ref.watch(appConfigProvider).apiBaseUrl.resolve(image.url).toString();
        face = Image.network(
          uri,
          headers: headers,
          fit: BoxFit.cover,
          errorBuilder: (context, error, stackTrace) => initials,
          frameBuilder: (context, child, frame, wasSynchronouslyLoaded) =>
              wasSynchronouslyLoaded || frame != null ? child : initials,
        );
      }
    }

    return ClipOval(child: SizedBox.square(dimension: diameter, child: face));
  }
}

class _Initials extends StatelessWidget {
  const _Initials({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ColoredBox(
      color: theme.colorScheme.surfaceContainerHighest,
      child: Center(
        child: Text(
          initialsForName(name),
          style: theme.textTheme.displaySmall?.copyWith(
            fontWeight: FontWeight.w700,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

String initialsForName(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((part) => part.isNotEmpty);
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.characters.first.toUpperCase();
  return '${parts.first.characters.first}${parts.last.characters.first}'.toUpperCase();
}
