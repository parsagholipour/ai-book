import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/characters_repository.dart';
import '../domain/character_models.dart';
import 'character_avatar.dart';
import 'character_editor_sheet.dart';
import 'character_portrait_polling.dart';
import 'character_profile_screen.dart';

/// The account-wide character library: the people (and creatures) a reader
/// wants their books to keep coming back to.
class CharacterLibraryScreen extends ConsumerStatefulWidget {
  const CharacterLibraryScreen({super.key});

  @override
  ConsumerState<CharacterLibraryScreen> createState() =>
      _CharacterLibraryScreenState();
}

class _CharacterLibraryScreenState extends ConsumerState<CharacterLibraryScreen>
    with CharacterPortraitPolling {
  bool _anyDrawing = false;

  @override
  bool get isDrawing => _anyDrawing;

  Future<void> _refresh() => ref.refresh(charactersProvider.future);

  Future<void> _openProfile(LibraryCharacter character) async {
    AppHaptics.tap();
    await Navigator.of(context).push(characterProfileRoute(character.id));
    if (!mounted) return;
    ref.invalidate(charactersProvider);
  }

  Future<void> _newCharacter() async {
    final created = await showCharacterEditorSheet(context);
    if (!mounted) return;
    ref.invalidate(charactersProvider);
    // Straight to their page: that is where a picture gets added, and the form
    // has nothing left to say once it has been saved.
    if (created != null) await _openProfile(created);
  }

  Future<void> _editDetails(LibraryCharacter character) async {
    await showCharacterEditorSheet(context, character: character);
    if (!mounted) return;
    ref.invalidate(charactersProvider);
  }

  Future<void> _confirmDelete(LibraryCharacter character) async {
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showAppConfirmationDialog(
      context,
      title: 'Delete ${character.name}?',
      message:
          'Books already made with ${character.name} keep their pages — this '
          'only removes the character from your library.',
      confirmLabel: 'Delete',
      destructive: true,
    );
    if (!confirmed || !mounted) return;
    try {
      await ref.read(charactersRepositoryProvider).delete(character.id);
      if (!mounted) return;
      ref.invalidate(charactersProvider);
    } catch (error) {
      // A 409 PORTRAIT_IN_PROGRESS arrives with its own explanation and lands
      // here like any other failure.
      messenger.showAppSnackBar(
        SnackBar(content: Text(userFacingError(error))),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final libraryValue = ref.watch(charactersProvider);
    _anyDrawing = libraryValue.value?.hasBusyPortrait ?? false;
    syncPortraitPolling();

    return Scaffold(
      appBar: AppBar(title: const Text('My characters')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newCharacter,
        icon: const Icon(Icons.person_add_alt_1_outlined),
        label: const Text('New character'),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: libraryValue.when(
          loading: () =>
              const AppLoadingState(message: 'Loading your characters'),
          error: (error, stackTrace) => ListView(
            padding: const EdgeInsets.only(top: 24),
            children: [
              AppErrorState(
                title: 'Could not load your characters',
                message: userFacingError(error),
                onRetry: () => ref.invalidate(charactersProvider),
              ),
            ],
          ),
          data: (library) => library.characters.isEmpty
              ? ListView(
                  padding: const EdgeInsets.only(top: 24),
                  children: [
                    AppEmptyState(
                      icon: Icons.people_alt_outlined,
                      title: 'No characters yet',
                      message:
                          'Create the people your stories keep coming back '
                          'to — a hero, a sidekick, even you — and reuse them '
                          'across books.',
                      actionLabel: 'New character',
                      onAction: _newCharacter,
                    ),
                  ],
                )
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(8, 8, 8, 96),
                  itemCount: library.characters.length,
                  itemBuilder: (context, index) {
                    final character = library.characters[index];
                    return _CharacterTile(
                      character: character,
                      onOpen: () => _openProfile(character),
                      onEdit: () => _editDetails(character),
                      onDelete: () => _confirmDelete(character),
                    );
                  },
                ),
        ),
      ),
    );
  }
}

class _CharacterTile extends StatelessWidget {
  const _CharacterTile({
    required this.character,
    required this.onOpen,
    required this.onEdit,
    required this.onDelete,
  });

  final LibraryCharacter character;
  final VoidCallback onOpen;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  String get _subtitle {
    if (character.portraitStatus == CharacterPortraitStatus.failed) {
      return 'Illustration failed — open to retry';
    }
    // Ranked above the description because it is the one thing the tile would
    // otherwise get wrong: the avatar shows their face, and the book will not.
    if (character.needsCartoonReference) {
      return 'Photo saved — open to make a version your books can draw';
    }
    if (character.description.isNotEmpty) return character.description;
    if (character.fields.isNotEmpty) {
      return character.fields.map((field) => field.value).join(' · ');
    }
    return 'No description yet';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final failed = character.portraitStatus == CharacterPortraitStatus.failed;
    return ListTile(
      onTap: onOpen,
      onLongPress: onDelete,
      leading: CharacterAvatar(character: character),
      title: Text(
        character.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        _subtitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: failed ? TextStyle(color: colors.error) : null,
      ),
      trailing: PopupMenuButton<String>(
        tooltip: 'Character actions',
        onSelected: (action) {
          switch (action) {
            case 'open':
              onOpen();
            case 'edit':
              onEdit();
            case 'delete':
              onDelete();
          }
        },
        // "Open" and "Edit details" are two different places now: the tap opens
        // their page, and the form is one more tap in.
        itemBuilder: (context) => const [
          PopupMenuItem(value: 'open', child: Text('Open')),
          PopupMenuItem(value: 'edit', child: Text('Edit details')),
          PopupMenuItem(value: 'delete', child: Text('Delete')),
        ],
      ),
    );
  }
}
