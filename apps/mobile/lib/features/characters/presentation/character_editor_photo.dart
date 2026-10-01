import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/character_models.dart';

/// The first thing in the form for a new character: their face.
///
/// A photo is chosen and cropped here but only sent once the character exists —
/// there is no id to attach it to before then — so this holds the frame the
/// reader approved and shows it back. Editing an existing character has no such
/// section: their pictures live on their own page, where a redraw and every
/// earlier version are.
class CharacterEditorPhoto extends StatelessWidget {
  const CharacterEditorPhoto({
    required this.nameController,
    required this.photo,
    required this.busy,
    required this.onChoose,
    required this.onRemove,
    super.key,
  });

  /// Read for the initials on the empty face, so it starts to look like them
  /// while their name is typed.
  final TextEditingController nameController;

  /// The cropped frame the reader approved, or null while there is none.
  final Uint8List? photo;

  final bool busy;
  final VoidCallback onChoose;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final hasPhoto = photo != null;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surfaceContainerLow,
        borderRadius: BorderRadius.circular(AppRadii.card),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Semantics(
              container: true,
              button: true,
              enabled: !busy,
              label: hasPhoto ? 'Change photo' : 'Add a photo',
              onTap: busy ? null : onChoose,
              child: ExcludeSemantics(
                child: GestureDetector(
                  key: const ValueKey('character-editor-photo'),
                  behavior: HitTestBehavior.opaque,
                  onTap: busy ? null : onChoose,
                  child: SizedBox.square(
                    dimension: 88,
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Positioned.fill(
                          child: ClipOval(
                            child: hasPhoto
                                ? Image.memory(
                                    photo!,
                                    fit: BoxFit.cover,
                                    width: double.infinity,
                                    height: double.infinity,
                                  )
                                : _InitialsFace(controller: nameController),
                          ),
                        ),
                        PositionedDirectional(
                          bottom: -2,
                          end: -2,
                          child: DecoratedBox(
                            decoration: BoxDecoration(
                              color: colors.primary,
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: colors.surfaceContainerLow,
                                width: 3,
                              ),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(6),
                              child: Icon(
                                hasPhoto
                                    ? Icons.edit_outlined
                                    : Icons.photo_camera_outlined,
                                size: 16,
                                color: colors.onPrimary,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    hasPhoto ? 'Photo ready' : 'Photo · optional',
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    hasPhoto
                        ? 'It is added when you create them.'
                        : 'A clear picture of their face helps every book '
                              'draw them the same way.',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Wrap(
                    spacing: AppSpacing.xs,
                    children: [
                      AppButton.outlined(
                        key: const ValueKey('character-editor-choose-photo'),
                        label: hasPhoto ? 'Change' : 'Choose a photo',
                        leading: Icon(
                          hasPhoto
                              ? Icons.swap_horiz_rounded
                              : Icons.add_photo_alternate_outlined,
                        ),
                        onPressed: busy ? null : onChoose,
                      ),
                      if (hasPhoto)
                        AppButton.text(
                          key: const ValueKey('character-editor-remove-photo'),
                          label: 'Remove',
                          onPressed: busy ? null : onRemove,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Their initials, following the name as it is typed.
class _InitialsFace extends StatelessWidget {
  const _InitialsFace({required this.controller});

  final TextEditingController controller;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ColoredBox(
      color: colors.primaryContainer,
      child: Center(
        child: ValueListenableBuilder<TextEditingValue>(
          valueListenable: controller,
          builder: (context, value, _) {
            final typed = value.text.trim().isNotEmpty;
            // The initials rule lives on the model; a throwaway character is
            // the way to ask it about text that is not one yet.
            final initials = LibraryCharacter(
              id: 'new',
              name: value.text,
              createdAt: DateTime.fromMillisecondsSinceEpoch(0),
              updatedAt: DateTime.fromMillisecondsSinceEpoch(0),
            ).initials;
            return typed
                ? Text(
                    initials,
                    textScaler: TextScaler.noScaling,
                    style: TextStyle(
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -1,
                      color: colors.onPrimaryContainer,
                    ),
                  )
                : Icon(
                    Icons.person_outline_rounded,
                    size: 40,
                    color: colors.onPrimaryContainer.withValues(alpha: 0.7),
                  );
          },
        ),
      ),
    );
  }
}
