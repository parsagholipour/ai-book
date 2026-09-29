import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';

/// The library before anyone is in it: what it is for, the one thing to do, and
/// the three steps from a name to a character in a book.
class CharacterLibraryEmpty extends StatelessWidget {
  const CharacterLibraryEmpty({required this.onCreate, super.key});
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(AppSpacing.lg),
          decoration: BoxDecoration(
            color: colors.primaryContainer.withValues(alpha: 0.45),
            borderRadius: BorderRadius.circular(AppRadii.sheet),
          ),
          child: Column(
            children: [
              const SizedBox(height: AppSpacing.xs),
              // The same face on three different covers: the whole promise of
              // the library in one picture, and it needs no words to be read.
              const ExcludeSemantics(child: _SameFaceOnEveryCover()),
              const SizedBox(height: AppSpacing.lg),
              Semantics(
                header: true,
                child: Text(
                  'Keep a character looking the same across every book',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'Save a hero, a pet or someone you know once. Every book you '
                'make draws them the same way.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              AppButton.primary(
                key: const ValueKey('character-library-create'),
                label: 'Create your first character',
                leading: const Icon(Icons.add_rounded),
                expanded: true,
                onPressed: onCreate,
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        Semantics(
          header: true,
          child: Text(
            'How it works',
            style: theme.textTheme.titleSmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        const _LibraryStep(
          number: '1',
          title: 'Describe them',
          description: 'A name is enough. Add personality and details later.',
        ),
        const _LibraryStep(
          number: '2',
          title: 'Give them a face',
          description: 'Add a photo or a drawing, or have one drawn for you.',
        ),
        const _LibraryStep(
          number: '3',
          title: 'Put them in a book',
          description: 'Type @name in your book chat and they join the story.',
        ),
      ],
    );
  }
}

/// Three tilted covers, one face.
class _SameFaceOnEveryCover extends StatelessWidget {
  const _SameFaceOnEveryCover();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      height: 148,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _Cover(
            rotation: -0.12,
            color: colors.tertiaryContainer,
            foreground: colors.onTertiaryContainer,
          ),
          _Cover(
            rotation: 0.03,
            color: colors.primaryContainer,
            foreground: colors.onPrimaryContainer,
            raised: true,
          ),
          _Cover(
            rotation: 0.12,
            color: colors.secondaryContainer,
            foreground: colors.onSecondaryContainer,
          ),
        ],
      ),
    );
  }
}

class _Cover extends StatelessWidget {
  const _Cover({
    required this.rotation,
    required this.color,
    required this.foreground,
    this.raised = false,
  });
  final double rotation;
  final Color color;
  final Color foreground;
  final bool raised;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Flexible(
      child: Transform.rotate(
        angle: rotation,
        child: Container(
          width: 88,
          height: raised ? 138 : 114,
          padding: const EdgeInsets.all(AppSpacing.xs),
          decoration: BoxDecoration(
            color: colors.surfaceContainerLowest,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(color: colors.outlineVariant),
            boxShadow: [
              BoxShadow(
                color: colors.shadow.withValues(alpha: 0.06),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Column(
            children: [
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(AppRadii.compact),
                  ),
                  child: Center(
                    child: Icon(
                      Icons.face_rounded,
                      size: 38,
                      color: foreground,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
              Container(
                height: 5,
                width: 44,
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                ),
              ),
              const SizedBox(height: AppSpacing.xxs),
              Container(
                height: 5,
                width: 28,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.6),
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                ),
              ),
              const SizedBox(height: AppSpacing.xxs),
            ],
          ),
        ),
      ),
    );
  }
}

class _LibraryStep extends StatelessWidget {
  const _LibraryStep({
    required this.number,
    required this.title,
    required this.description,
  });
  final String number;
  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: theme.colorScheme.primaryContainer,
            foregroundColor: theme.colorScheme.onPrimaryContainer,
            child: Text(
              number,
              style: theme.textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: theme.textTheme.titleSmall),
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  description,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
