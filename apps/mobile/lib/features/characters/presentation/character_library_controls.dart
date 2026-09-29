import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/character_models.dart';

/// How many characters it takes before the library offers to search and sort.
///
/// Below this the whole cast fits on one screen, and a search box above three
/// faces is furniture. It is the length of a screenful of cards, not a taste.
const int characterLibraryControlsThreshold = 5;

enum CharacterLibrarySort {
  updated('Recently updated'),
  name('Name A–Z'),
  newest('Newest first');

  const CharacterLibrarySort(this.label);
  final String label;

  int compare(LibraryCharacter a, LibraryCharacter b) {
    final result = switch (this) {
      updated => b.updatedAt.compareTo(a.updatedAt),
      name => a.name.toLowerCase().compareTo(b.name.toLowerCase()),
      newest => b.createdAt.compareTo(a.createdAt),
    };
    return result == 0 ? a.id.compareTo(b.id) : result;
  }
}

/// Faces to browse, or names to scan.
enum CharacterLibraryLayout { grid, list }

/// Search, sort and layout, in one row above the cast.
///
/// The count sits under it and carries the current sort, so the words that used
/// to take a row of their own — "Recently updated" beside a chevron — now share
/// the line the count was already on.
class CharacterLibraryControls extends StatelessWidget {
  const CharacterLibraryControls({
    required this.controller,
    required this.characters,
    required this.sort,
    required this.layout,
    required this.resultCount,
    required this.onSearch,
    required this.onSort,
    required this.onLayout,
    this.canChooseLayout = true,
    super.key,
  });

  final TextEditingController controller;
  final List<LibraryCharacter> characters;
  final CharacterLibrarySort sort;
  final CharacterLibraryLayout layout;
  final int resultCount;
  final VoidCallback onSearch;
  final ValueChanged<CharacterLibrarySort> onSort;
  final ValueChanged<CharacterLibraryLayout> onLayout;

  /// False at a text size where only rows fit; the choice would do nothing.
  final bool canChooseLayout;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final searching = controller.text.trim().isNotEmpty;
    final count = searching
        ? '$resultCount of ${characters.length} characters'
        : '${characters.length} ${characters.length == 1 ? 'character' : 'characters'}';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('character-search'),
                controller: controller,
                onChanged: (_) => onSearch(),
                textInputAction: TextInputAction.search,
                onSubmitted: (_) => FocusScope.of(context).unfocus(),
                decoration: InputDecoration(
                  hintText: 'Search your characters',
                  prefixIcon: const Icon(Icons.search_rounded),
                  suffixIcon: controller.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear search',
                          onPressed: () {
                            controller.clear();
                            onSearch();
                          },
                          icon: const Icon(Icons.close_rounded),
                        ),
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.xxs),
            PopupMenuButton<CharacterLibrarySort>(
              tooltip: 'Sort characters',
              // No `initialValue`: it paints a highlight box around the chosen
              // row, over a `ListTile` that wants to paint its own, and the tick
              // beside the row already says which one is chosen.
              onSelected: (value) {
                AppHaptics.selection();
                onSort(value);
              },
              itemBuilder: (_) => [
                for (final option in CharacterLibrarySort.values)
                  CheckedPopupMenuItem(
                    value: option,
                    checked: sort == option,
                    child: Text(option.label),
                  ),
              ],
              icon: const Icon(Icons.swap_vert_rounded),
            ),
            if (canChooseLayout)
              IconButton(
                key: const ValueKey('character-layout-toggle'),
                tooltip: layout == CharacterLibraryLayout.grid
                    ? 'Show as list'
                    : 'Show as grid',
                onPressed: () {
                  AppHaptics.selection();
                  onLayout(
                    layout == CharacterLibraryLayout.grid
                        ? CharacterLibraryLayout.list
                        : CharacterLibraryLayout.grid,
                  );
                },
                icon: Icon(
                  layout == CharacterLibraryLayout.grid
                      ? Icons.view_agenda_outlined
                      : Icons.grid_view_rounded,
                ),
              ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: AppSpacing.xxs),
          child: Semantics(
            liveRegion: true,
            child: Text(
              '$count · ${sort.label}',
              style: theme.textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
