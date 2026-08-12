import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/character_models.dart';

/// Who the character is: the description a book writes them from, the details
/// beside it, and the description the server read off their photo while it is
/// still on offer.
class CharacterProfileDetails extends StatelessWidget {
  const CharacterProfileDetails({
    required this.character,
    required this.busy,
    required this.onEdit,
    required this.onUseSuggestion,
    required this.onDismissSuggestion,
    super.key,
  });

  final LibraryCharacter character;
  final bool busy;
  final VoidCallback onEdit;
  final void Function(String suggestion) onUseSuggestion;
  final VoidCallback onDismissSuggestion;

  String? get _suggestion {
    final suggestion = character.suggestedDescription?.trim();
    if (suggestion == null || suggestion.isEmpty) return null;
    // Already what they have; offering it back would be noise.
    return suggestion == character.description.trim() ? null : suggestion;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final suggestion = _suggestion;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppSectionHeader(
          title: 'About',
          action: IconButton(
            key: const ValueKey('character-edit-details'),
            tooltip: 'Edit details',
            onPressed: busy ? null : onEdit,
            icon: const Icon(Icons.edit_outlined),
          ),
        ),
        const SizedBox(height: AppSpacing.xs),
        if (character.description.trim().isEmpty)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: 'Write a description',
              leading: const Icon(Icons.notes_outlined),
              onPressed: busy ? null : onEdit,
            ),
          )
        else
          Text(character.description, style: theme.textTheme.bodyMedium),
        if (suggestion != null) ...[
          const SizedBox(height: AppSpacing.sm),
          AppCard(
            tone: AppTone.info,
            density: AppCardDensity.compact,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'From your picture',
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: AppSpacing.xxs),
                Text(suggestion, style: theme.textTheme.bodySmall),
                const SizedBox(height: AppSpacing.xs),
                // Offered, never applied: only the reader tapping this puts it
                // in their description.
                AppActionGroup(
                  primary: AppButton.tonal(
                    key: const ValueKey('character-use-suggestion'),
                    label: 'Use this',
                    onPressed: busy ? null : () => onUseSuggestion(suggestion),
                  ),
                  secondary: [
                    AppButton.text(
                      label: 'No thanks',
                      onPressed: busy ? null : onDismissSuggestion,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
        if (character.fields.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.md),
          Wrap(
            spacing: AppSpacing.xs,
            runSpacing: AppSpacing.xs,
            children: [
              for (final field in character.fields)
                AppMetricChip(label: field.key, value: field.value),
            ],
          ),
        ] else ...[
          const SizedBox(height: AppSpacing.xs),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppButton.text(
              label: 'Add details',
              leading: const Icon(Icons.add),
              onPressed: busy ? null : onEdit,
            ),
          ),
        ],
        if (character.usedInBooks) ...[
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Icon(Icons.menu_book_outlined, size: 16, color: colors.onSurfaceVariant),
              const SizedBox(width: AppSpacing.xxs),
              Expanded(
                child: Text(
                  'Mention @${character.name} in a chat to put them in a book.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
