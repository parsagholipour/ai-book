import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/character_models.dart';
import 'character_identity.dart';
import 'character_portrait_drawing.dart';

/// One line about who a character is: their description, else their details,
/// else a plain note that there is nothing yet.
String characterSubtitle(LibraryCharacter character) {
  final description = character.description.trim();
  if (description.isNotEmpty) return description;
  if (character.fields.isNotEmpty) {
    return character.fields.map((field) => field.value).join(' · ');
  }
  return 'No description yet';
}

/// The spoken form of a card: name, who they are, and where their picture
/// stands — the words the visual status pill and check badge carry.
String characterSemanticsLabel(LibraryCharacter character) {
  final status = switch (characterPictureStatus(character)) {
    CharacterPictureStatus.drawing => 'Drawing their illustration',
    CharacterPictureStatus.failed => 'Illustration failed, open to retry',
    CharacterPictureStatus.ready => 'Illustration ready',
    CharacterPictureStatus.photoOnly => 'Photo only, not illustrated yet',
    CharacterPictureStatus.none => 'No picture yet',
  };
  return '${character.name}. ${characterSubtitle(character)}. $status.';
}

/// The overflow menu on a card or row. The tap opens the profile; the menu
/// holds what the tap does not.
class CharacterActionsMenu extends StatelessWidget {
  const CharacterActionsMenu({
    required this.character,
    required this.onCall,
    required this.onEdit,
    required this.onDelete,
    super.key,
  });

  final LibraryCharacter character;
  final VoidCallback onCall;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return PopupMenuButton<String>(
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
      itemBuilder: (_) => [
        const PopupMenuItem(
          value: 'call',
          child: _MenuRow(icon: Icons.call_outlined, label: 'Call'),
        ),
        const PopupMenuItem(
          value: 'edit',
          child: _MenuRow(icon: Icons.edit_outlined, label: 'Edit details'),
        ),
        PopupMenuItem(
          value: 'delete',
          enabled: !character.portraitStatus.isBusy,
          child: _MenuRow(
            icon: Icons.delete_outline,
            label: 'Delete character',
            color: colors.error,
          ),
        ),
      ],
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, this.color});

  final IconData icon;
  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(width: AppSpacing.sm),
        Flexible(
          child: Text(label, style: TextStyle(color: color)),
        ),
      ],
    );
  }
}

/// A character's picture with everything that can be laid over it: the drawing
/// veil, the ready check, the status pill and the menu.
///
/// One composition for the grid card and the list row, so a character reads the
/// same at both sizes. A saved photograph is a face to browse, but is not yet
/// artwork a book can use, and the pill is what says so.
class CharacterCardArt extends StatelessWidget {
  const CharacterCardArt({
    required this.character,
    required this.onCall,
    required this.onEdit,
    required this.onDelete,
    this.compact = false,
    super.key,
  });

  final LibraryCharacter character;
  final VoidCallback onCall;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  /// The list row's thumbnail: no menu (the row has its own) and no pill.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final status = characterPictureStatus(character);
    return Stack(
      fit: StackFit.expand,
      children: [
        CharacterIdentityArt(character: character),
        // The card's own label says all of this aloud; the veil's live region
        // would otherwise announce every tick of a list nobody is looking at.
        if (status == CharacterPictureStatus.drawing)
          Positioned.fill(
            child: ExcludeSemantics(
              child: CharacterDrawingOverlay(
                name: character.name,
                compact: true,
              ),
            ),
          ),
        if (status == CharacterPictureStatus.ready)
          const PositionedDirectional(
            top: AppSpacing.xs,
            start: AppSpacing.xs,
            child: ExcludeSemantics(child: CharacterReadyBadge()),
          ),
        if (!compact) ...[
          PositionedDirectional(
            top: AppSpacing.xxs,
            end: AppSpacing.xxs,
            child: Material(
              color: colors.surface.withValues(alpha: 0.94),
              shape: const CircleBorder(),
              child: CharacterActionsMenu(
                character: character,
                onCall: onCall,
                onEdit: onEdit,
                onDelete: onDelete,
              ),
            ),
          ),
          if (status != CharacterPictureStatus.ready)
            PositionedDirectional(
              bottom: AppSpacing.xs,
              start: AppSpacing.xs,
              end: AppSpacing.xs,
              child: Align(
                alignment: AlignmentDirectional.centerStart,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: AlignmentDirectional.centerStart,
                  child: ExcludeSemantics(
                    child: CharacterStatusPill(character: character),
                  ),
                ),
              ),
            ),
        ],
      ],
    );
  }
}

/// A character as a grid card: a big portrait, the name, one line about them.
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

    return Semantics(
      container: true,
      label: characterSemanticsLabel(character),
      button: true,
      onTap: onOpen,
      child: Material(
        color: colors.surfaceContainerLowest,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.card),
          side: BorderSide(color: colors.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onOpen,
          // The wrapping Semantics already names and activates the card; the
          // InkWell's own tap node would sit beside it, focusable and unnamed.
          excludeFromSemantics: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: CharacterCardArt(
                  character: character,
                  onCall: onCall,
                  onEdit: onEdit,
                  onDelete: onDelete,
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.sm,
                  AppSpacing.sm,
                  AppSpacing.sm,
                  AppSpacing.sm,
                ),
                child: ExcludeSemantics(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        character.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.xxs),
                      Text(
                        characterSubtitle(character),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A character as a list row: for a longer description, a large text size, or a
/// reader who would rather scan names than browse faces.
class CharacterLibraryRow extends StatelessWidget {
  const CharacterLibraryRow({
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
    final status = characterPictureStatus(character);

    return Semantics(
      container: true,
      label: characterSemanticsLabel(character),
      button: true,
      onTap: onOpen,
      child: Material(
        color: colors.surfaceContainerLowest,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.card),
          side: BorderSide(color: colors.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onOpen,
          // The wrapping Semantics already names and activates the card; the
          // InkWell's own tap node would sit beside it, focusable and unnamed.
          excludeFromSemantics: true,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.sm),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 84,
                  height: 104,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadii.control),
                    child: CharacterCardArt(
                      character: character,
                      compact: true,
                      onCall: onCall,
                      onEdit: onEdit,
                      onDelete: onDelete,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: ExcludeSemantics(
                    child: Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.xxs),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            character.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(height: AppSpacing.xxs),
                          Text(
                            characterSubtitle(character),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
                          ),
                          if (status != CharacterPictureStatus.ready) ...[
                            const SizedBox(height: AppSpacing.xs),
                            CharacterStatusPill(character: character),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
                CharacterActionsMenu(
                  character: character,
                  onCall: onCall,
                  onEdit: onEdit,
                  onDelete: onDelete,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
