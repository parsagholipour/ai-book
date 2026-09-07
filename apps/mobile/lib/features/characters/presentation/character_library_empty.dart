import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';

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
              const SizedBox(height: AppSpacing.sm),
              ExcludeSemantics(
                child: SizedBox(
                  height: 148,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _CastPlaceholder(
                        icon: Icons.pets_outlined,
                        rotation: -0.12,
                        color: colors.tertiaryContainer,
                        foreground: colors.onTertiaryContainer,
                      ),
                      _CastPlaceholder(
                        icon: Icons.face_rounded,
                        rotation: 0.04,
                        color: colors.primaryContainer,
                        foreground: colors.onPrimaryContainer,
                        raised: true,
                      ),
                      _CastPlaceholder(
                        icon: Icons.auto_awesome_outlined,
                        rotation: 0.12,
                        color: colors.secondaryContainer,
                        foreground: colors.onSecondaryContainer,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                'Every story starts\nwith someone.',
                textAlign: TextAlign.center,
                style: theme.textTheme.headlineSmall,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'A fearless hero, a mischievous pet, or someone you know. Create them once and take them on any adventure.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              AppButton.primary(
                label: 'Create your first character',
                leading: const Icon(Icons.add_rounded),
                expanded: true,
                onPressed: onCreate,
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        const _LibraryStep(
          number: '1',
          title: 'Give them a story',
          description: 'Start with a name, then add personality and details.',
        ),
        const _LibraryStep(
          number: '2',
          title: 'Put a face to the name',
          description: 'Add your own picture or create an illustration.',
        ),
        const _LibraryStep(
          number: '3',
          title: 'Let the adventures begin',
          description: 'Mention @name in your book chat to include them.',
        ),
      ],
    );
  }
}

class _CastPlaceholder extends StatelessWidget {
  const _CastPlaceholder({
    required this.icon,
    required this.rotation,
    required this.color,
    required this.foreground,
    this.raised = false,
  });
  final IconData icon;
  final double rotation;
  final Color color;
  final Color foreground;
  final bool raised;

  @override
  Widget build(BuildContext context) {
    return Flexible(
      child: Transform.rotate(
        angle: rotation,
        child: Container(
          width: 88,
          height: raised ? 138 : 112,
          padding: const EdgeInsets.all(AppSpacing.xs),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerLowest,
            borderRadius: BorderRadius.circular(AppRadii.control),
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
          child: Column(
            children: [
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(AppRadii.compact),
                  ),
                  child: Center(child: Icon(icon, size: 36, color: foreground)),
                ),
              ),
              const SizedBox(height: AppSpacing.xs),
              Container(height: 5, width: 36, color: color),
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
            backgroundColor: theme.colorScheme.surfaceContainerHigh,
            child: Text(number, style: theme.textTheme.labelMedium),
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
