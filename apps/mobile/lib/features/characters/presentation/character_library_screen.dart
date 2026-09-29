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
import 'character_library_skeleton.dart';
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
  CharacterLibraryLayout _layout = CharacterLibraryLayout.grid;

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
    return callLibraryCharacter(
      context: context,
      ref: ref,
      character: character,
    );
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
    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('My characters')),
      // Only once the library is in and has someone in it: the empty state
      // carries its own single create action, and a button that appears while
      // loading only to vanish is a flicker. Floating rather than docked, so
      // the cast keeps the whole screen and scrolls under it.
      floatingActionButton: libraryValue.value?.characters.isNotEmpty == true
          ? FloatingActionButton.extended(
              key: const ValueKey('character-library-add'),
              onPressed: _newCharacter,
              // The primary fill outright, not the theme's container tint: this
              // is the one action on the page.
              backgroundColor: colors.primary,
              foregroundColor: colors.onPrimary,
              icon: const Icon(Icons.add_rounded),
              label: const Text('Add character'),
            )
          : null,
      body: SafeArea(
        top: false,
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final geometry = _LibraryGeometry.of(context, constraints);
              return libraryValue.when(
                loading: () => CharacterLibrarySkeleton(
                  columns: geometry.list ? 1 : geometry.columns,
                  cardExtent: geometry.cardExtent,
                ),
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
                data: (library) => _library(library, geometry),
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _library(CharacterLibrary library, _LibraryGeometry geometry) {
    final visible = _visibleCharacters(library);
    final sidePadding = geometry.sidePadding;
    final showControls =
        library.characters.length >= characterLibraryControlsThreshold;
    final list = geometry.list || _layout == CharacterLibraryLayout.list;

    Widget card(LibraryCharacter character) => list
        ? CharacterLibraryRow(
            key: ValueKey('character-card-${character.id}'),
            character: character,
            onOpen: () => _openProfile(character),
            onCall: () => _call(character),
            onEdit: () => _editDetails(character),
            onDelete: () => _confirmDelete(character),
          )
        : CharacterLibraryCard(
            key: ValueKey('character-card-${character.id}'),
            character: character,
            onOpen: () => _openProfile(character),
            onCall: () => _call(character),
            onEdit: () => _editDetails(character),
            onDelete: () => _confirmDelete(character),
          );

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
          if (showControls)
            SliverPadding(
              padding: EdgeInsets.fromLTRB(sidePadding, 8, sidePadding, 0),
              sliver: SliverToBoxAdapter(
                child: CharacterLibraryControls(
                  controller: _searchController,
                  characters: library.characters,
                  sort: _sort,
                  layout: list
                      ? CharacterLibraryLayout.list
                      : CharacterLibraryLayout.grid,
                  canChooseLayout: !geometry.list,
                  resultCount: visible.length,
                  onSearch: () => setState(() {}),
                  onSort: (value) => setState(() => _sort = value),
                  onLayout: (value) => setState(() => _layout = value),
                ),
              ),
            ),
          if (portraitWaitGaveUp && _anyDrawing)
            SliverPadding(
              padding: EdgeInsets.fromLTRB(sidePadding, 12, sidePadding, 0),
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
                message: 'Try another name or detail, or show your whole cast.',
                actionLabel: 'Reset search',
                onAction: _resetSearch,
              ),
            )
          else ...[
            SliverPadding(
              padding: EdgeInsets.fromLTRB(
                sidePadding,
                showControls ? AppSpacing.sm : AppSpacing.xs,
                sidePadding,
                AppSpacing.lg,
              ),
              sliver: list
                  ? SliverList.separated(
                      itemCount: visible.length,
                      separatorBuilder: (_, _) =>
                          const SizedBox(height: AppSpacing.sm),
                      itemBuilder: (context, index) => card(visible[index]),
                    )
                  : SliverGrid.builder(
                      itemCount: visible.length,
                      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: geometry.columns,
                        crossAxisSpacing: AppSpacing.sm,
                        mainAxisSpacing: AppSpacing.sm,
                        mainAxisExtent: geometry.cardExtent,
                      ),
                      itemBuilder: (context, index) => card(visible[index]),
                    ),
            ),
            // Room under the last card for the floating button, so nothing is
            // ever hidden behind it.
            SliverPadding(
              padding: EdgeInsets.fromLTRB(sidePadding, 0, sidePadding, 104),
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
  }
}

/// How the cast is laid out at this width and text size.
///
/// One place, because the loading skeleton has to be the size of what replaces
/// it: computing this only inside the data branch is what would make the page
/// jump when the cast arrives.
class _LibraryGeometry {
  const _LibraryGeometry({
    required this.columns,
    required this.cardExtent,
    required this.sidePadding,
    required this.list,
  });

  final int columns;
  final double cardExtent;
  final double sidePadding;

  /// Only rows fit: a narrow screen, or a text size where a card's name and
  /// status would be cut to make room for a picture.
  final bool list;

  factory _LibraryGeometry.of(
    BuildContext context,
    BoxConstraints constraints,
  ) {
    final width = constraints.maxWidth.clamp(0.0, 1120.0);
    final sidePadding = (constraints.maxWidth - width) / 2 + 18;
    final textScale = MediaQuery.textScalerOf(context).scale(14) / 14;
    final list = textScale > 1.35 || width < 360;
    final columns = width >= 1000
        ? 4
        : width >= 700
        ? 3
        : 2;
    final cell = (width - 36 - (columns - 1) * AppSpacing.sm) / columns;
    // The portrait takes most of the card; what is under it is a name that may
    // wrap to two lines and one line of who they are.
    final cardExtent = cell * 1.12 + 30 + 58 * textScale;
    return _LibraryGeometry(
      columns: columns,
      cardExtent: cardExtent,
      sidePadding: sidePadding,
      list: list,
    );
  }
}
