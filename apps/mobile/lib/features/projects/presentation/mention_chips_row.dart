import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/ui/app_components.dart';
import '../../characters/data/characters_repository.dart';
import '../../characters/domain/character_models.dart';
import '../../characters/presentation/character_avatar.dart';
import '../domain/creation_message_models.dart';

/// Who the message in the composer will be sent with.
///
/// The @-mention affordance had no state anyone could see: a mention that
/// registered, one that never registered, and one that silently de-registered
/// all rendered byte-identically, because the suggestion strip only exists
/// while an `@token` is at the caret. The reader found out which had happened
/// by reading the finished book — and a book whose character was silently
/// dropped invents its own, wearing the same name.
///
/// Display-only on purpose. A mention *is* the `@Name` in the text, so the way
/// to take one off is to delete it; a chip that removed the id but left the
/// text would put the two back out of step, which is the whole bug.
class MentionChipsRow extends ConsumerWidget {
  const MentionChipsRow({required this.mentions, super.key});

  /// The characters currently attached, in the order the text names them.
  final List<MobileCreationCharacterRef> mentions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (mentions.isEmpty) return const SizedBox.shrink();
    final colors = Theme.of(context).colorScheme;
    // Read rather than watched for the picture alone: the mentions themselves
    // were resolved against this list upstream, so a row is never waiting on
    // it — a chip whose character has not arrived yet simply wears an icon.
    final library =
        ref.watch(charactersProvider).asData?.value.characters ??
        const <LibraryCharacter>[];
    return Semantics(
      container: true,
      label: mentions.length == 1
          ? '${mentions.first.name} is in this message'
          : '${mentions.length} of your characters are in this message',
      child: ExcludeSemantics(
        child: Material(
          color: colors.surface,
          child: SizedBox(
            height: 42,
            child: ListView.separated(
              key: const ValueKey('attached-mentions-row'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(12, 5, 12, 5),
              itemCount: mentions.length,
              separatorBuilder: (_, _) => const SizedBox(width: 6),
              itemBuilder: (context, index) => _MentionChip(
                mention: mentions[index],
                character: _characterById(library, mentions[index].id),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

LibraryCharacter? _characterById(List<LibraryCharacter> characters, String id) {
  for (final character in characters) {
    if (character.id == id) return character;
  }
  return null;
}

class _MentionChip extends StatelessWidget {
  const _MentionChip({required this.mention, this.character});

  final MobileCreationCharacterRef mention;
  final LibraryCharacter? character;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final saved = character;
    return Container(
      padding: const EdgeInsets.fromLTRB(6, 4, 10, 4),
      decoration: BoxDecoration(
        // A surface tone, never the primary fill: this reports state next to
        // the composer, it is not a control and not a chat bubble.
        color: colors.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(AppRadii.control),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (saved != null)
            CharacterAvatar(character: saved, radius: 11)
          else
            Icon(
              Icons.person_outline,
              size: 18,
              color: colors.onSurfaceVariant,
            ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 140),
            child: Text(
              mention.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
