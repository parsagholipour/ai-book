import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/character_models.dart';

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

class CharacterLibraryControls extends StatelessWidget {
  const CharacterLibraryControls({
    required this.controller,
    required this.characters,
    required this.sort,
    required this.resultCount,
    required this.onSearch,
    required this.onSort,
    super.key,
  });

  final TextEditingController controller;
  final List<LibraryCharacter> characters;
  final CharacterLibrarySort sort;
  final int resultCount;
  final VoidCallback onSearch;
  final ValueChanged<CharacterLibrarySort> onSort;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final searching = controller.text.trim().isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('character-search'),
          controller: controller,
          onChanged: (_) => onSearch(),
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => FocusScope.of(context).unfocus(),
          decoration: InputDecoration(
            hintText: 'Search names, stories, details…',
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
        const SizedBox(height: AppSpacing.xxs),
        Row(
          children: [
            Expanded(
              child: Semantics(
                liveRegion: true,
                child: Text(
                  searching
                      ? '$resultCount of ${characters.length} characters'
                      : '${characters.length} ${characters.length == 1 ? 'character' : 'characters'}',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
            Flexible(
              child: PopupMenuButton<CharacterLibrarySort>(
                tooltip: 'Sort characters',
                initialValue: sort,
                onSelected: onSort,
                itemBuilder: (_) => [
                  for (final option in CharacterLibrarySort.values)
                    CheckedPopupMenuItem(
                      value: option,
                      checked: sort == option,
                      child: Text(option.label),
                    ),
                ],
                child: Container(
                  constraints: const BoxConstraints(
                    minHeight: AppSizes.minimumTouchTarget,
                  ),
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          sort.label,
                          style: theme.textTheme.labelMedium,
                        ),
                      ),
                      const SizedBox(width: AppSpacing.xxs),
                      const Icon(Icons.keyboard_arrow_down_rounded, size: 20),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
