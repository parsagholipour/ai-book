import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/characters_repository.dart';
import '../domain/character_models.dart';
import 'character_call.dart';
import 'character_editor_sheet.dart';
import 'character_library_card.dart';
import 'character_library_controls.dart';
import 'character_library_empty.dart';
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
  final _searchController = TextEditingController();
  CharacterLibrarySort _sort = CharacterLibrarySort.updated;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _resetSearch() {
    _searchController.clear();
    setState(() {});
  }

  List<LibraryCharacter> _visibleCharacters(CharacterLibrary library) {
    final words = _searchController.text.trim().toLowerCase().split(
      RegExp(r'\s+'),
    );
    return library.characters.where((character) {
      final searchable = [
        character.name,
        character.description,
        for (final field in character.fields) '${field.key} ${field.value}',
      ].join(' ').toLowerCase();
      return words.every(searchable.contains);
    }).toList()..sort(_sort.compare);
  }

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

  Future<void> _call(LibraryCharacter character) {
    AppHaptics.tap();
    return callLibraryCharacter(context: context, ref: ref, character: character);
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
      // Only once the library is in and has someone in it: the empty state
      // carries its own single create action, and a button that appears while
      // loading only to vanish is a flicker.
      bottomNavigationBar: libraryValue.value?.characters.isNotEmpty == true
          ? SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(18, 12, 18, 12),
                child: Center(
                  heightFactor: 1,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 560),
                    child: AppButton.primary(
                      label: 'New character',
                      leading: const Icon(Icons.add_rounded),
                      expanded: true,
                      onPressed: _newCharacter,
                    ),
                  ),
                ),
              ),
            )
          : null,
      body: SafeArea(
        top: false,
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: libraryValue.when(
            loading: () =>
                const AppLoadingState(message: 'Loading your characters'),
            error: (error, stackTrace) => ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(top: 24),
              children: [
                AppErrorState(
                  title: 'Could not load your characters',
                  message: userFacingError(error),
                  onRetry: () => ref.invalidate(charactersProvider),
                ),
              ],
            ),
            data: _library,
          ),
        ),
      ),
    );
  }

  Widget _library(CharacterLibrary library) {
    final visible = _visibleCharacters(library);
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth.clamp(0.0, 1120.0);
        final sidePadding = (constraints.maxWidth - width) / 2 + 18;
        final textScale = MediaQuery.textScalerOf(context).scale(14) / 14;
        // Make room for complete controls and readable names at larger type.
        final columns = textScale > 1.35 || width < 360
            ? 1
            : width >= 1000
            ? 4
            : width >= 700
            ? 3
            : 2;
        return CustomScrollView(
          key: const PageStorageKey('character-library-scroll'),
          physics: const AlwaysScrollableScrollPhysics(),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          // The app bar already says whose page this is, so the list leads
          // with the search rather than a second heading.
          slivers: [
            if (library.characters.isEmpty)
              SliverPadding(
                padding: EdgeInsets.fromLTRB(sidePadding, 12, sidePadding, 32),
                sliver: SliverToBoxAdapter(
                  child: CharacterLibraryEmpty(onCreate: _newCharacter),
                ),
              )
            else ...[
              SliverPadding(
                padding: EdgeInsets.fromLTRB(sidePadding, 8, sidePadding, 0),
                sliver: SliverToBoxAdapter(
                  child: CharacterLibraryControls(
                    controller: _searchController,
                    characters: library.characters,
                    sort: _sort,
                    resultCount: visible.length,
                    onSearch: () => setState(() {}),
                    onSort: (value) => setState(() => _sort = value),
                  ),
                ),
              ),
              if (portraitWaitGaveUp && _anyDrawing)
                SliverPadding(
                  padding: EdgeInsets.fromLTRB(sidePadding, 0, sidePadding, 12),
                  sliver: SliverToBoxAdapter(
                    child: AppInlineNotice(
                      title: 'Still waiting on an illustration',
                      message:
                          'Your characters are saved. Check for the finished picture again.',
                      actionLabel: 'Check again',
                      onAction: resumePortraitPolling,
                    ),
                  ),
                ),
              if (visible.isEmpty)
                SliverToBoxAdapter(
                  child: AppEmptyState(
                    icon: Icons.search_off_rounded,
                    title: 'No characters here',
                    message:
                        'Try another name or detail, or show your whole cast.',
                    actionLabel: 'Reset search',
                    onAction: _resetSearch,
                  ),
                )
              else ...[
                SliverPadding(
                  padding: EdgeInsets.fromLTRB(sidePadding, 8, sidePadding, 24),
                  sliver: SliverGrid.builder(
                    itemCount: visible.length,
                    gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: columns,
                      crossAxisSpacing: AppSpacing.sm,
                      mainAxisSpacing: AppSpacing.md,
                      mainAxisExtent: 170 + 154 * textScale,
                    ),
                    itemBuilder: (context, index) {
                      final character = visible[index];
                      return CharacterLibraryCard(
                        key: ValueKey('character-card-${character.id}'),
                        character: character,
                        onOpen: () => _openProfile(character),
                        onCall: () => _call(character),
                        onEdit: () => _editDetails(character),
                        onDelete: () => _confirmDelete(character),
                      );
                    },
                  ),
                ),
                SliverPadding(
                  padding: EdgeInsets.fromLTRB(sidePadding, 0, sidePadding, 24),
                  sliver: SliverToBoxAdapter(
                    child: Text(
                      'Bring them into a story with @name in your book chat.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ],
        );
      },
    );
  }
}
