import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/character_models.dart';
import 'character_identity.dart';

/// A character's identity and illustration state remain separate: a saved
/// photograph is a face to browse, but is not yet artwork a book can use.
class CharacterLibraryCard extends StatelessWidget {
  const CharacterLibraryCard({
    required this.character,
    required this.onOpen,
    required this.onCall,
    required this.onEdit,
    required this.onDelete,
    super.key,
  });

  final LibraryCharacter character;
  final VoidCallback onOpen;
  final VoidCallback onCall;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final description = character.description.trim();
    final subtitle = description.isNotEmpty
        ? description
        : character.fields.isNotEmpty
        ? character.fields.map((field) => field.value).join(' · ')
        : 'Their story starts with you.';

    return Material(
      color: colors.surfaceContainerLowest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadii.card),
        side: BorderSide(color: colors.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  CharacterIdentityArt(character: character),
                  PositionedDirectional(
                    top: AppSpacing.xxs,
                    end: AppSpacing.xxs,
                    child: Material(
                      color: colors.surfaceContainerLowest.withValues(
                        alpha: 0.94,
                      ),
                      shape: const CircleBorder(),
                      child: PopupMenuButton<String>(
                        tooltip: 'Actions for ${character.name}',
                        icon: const Icon(Icons.more_horiz_rounded, size: 22),
                        onSelected: (action) {
                          switch (action) {
                            case 'call':
                              onCall();
                            case 'edit':
                              onEdit();
                            case 'delete':
                              onDelete();
                          }
                        },
                        // The tap opens the profile; the menu holds what the
                        // tap does not.
                        itemBuilder: (_) => [
                          const PopupMenuItem(
                            value: 'call',
                            child: Text('Call'),
                          ),
                          const PopupMenuItem(
                            value: 'edit',
                            child: Text('Edit details'),
                          ),
                          PopupMenuItem(
                            value: 'delete',
                            enabled: !character.portraitStatus.isBusy,
                            child: Text(
                              'Delete character',
                              style: TextStyle(color: colors.error),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    character.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.sm),
                  CharacterIllustrationStatus(character: character),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
