import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/book_library.dart';

class BookLibraryControls extends StatelessWidget {
  const BookLibraryControls({
    required this.controller,
    required this.filter,
    required this.sort,
    required this.totalCount,
    required this.resultCount,
    required this.onSearch,
    required this.onFilter,
    required this.onSort,
    super.key,
  });

  final TextEditingController controller;
  final BookLibraryFilter filter;
  final BookLibrarySort sort;
  final int totalCount;
  final int resultCount;
  final VoidCallback onSearch;
  final ValueChanged<BookLibraryFilter> onFilter;
  final ValueChanged<BookLibrarySort> onSort;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final filtering =
        controller.text.trim().isNotEmpty || filter != BookLibraryFilter.all;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('book-library-search'),
          controller: controller,
          onChanged: (_) => onSearch(),
          textInputAction: TextInputAction.search,
          onSubmitted: (_) => FocusScope.of(context).unfocus(),
          decoration: InputDecoration(
            labelText: 'Search books',
            hintText: 'Title, author, or topic',
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
        const SizedBox(height: AppSpacing.sm),
        Wrap(
          spacing: AppSpacing.xs,
          runSpacing: AppSpacing.xxs,
          children: [
            for (final option in BookLibraryFilter.values)
              ChoiceChip(
                label: Text(option.label),
                selected: filter == option,
                onSelected: (_) => onFilter(option),
              ),
          ],
        ),
        Row(
          children: [
            Expanded(
              child: Semantics(
                liveRegion: true,
                child: Text(
                  filtering
                      ? '$resultCount of $totalCount books'
                      : '$totalCount ${totalCount == 1 ? 'book' : 'books'}',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
            Flexible(
              child: PopupMenuButton<BookLibrarySort>(
                tooltip: 'Sort books',
                initialValue: sort,
                onSelected: onSort,
                itemBuilder: (_) => [
                  for (final option in BookLibrarySort.values)
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
