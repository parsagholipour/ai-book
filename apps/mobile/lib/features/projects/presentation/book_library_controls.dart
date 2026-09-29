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
    this.filterCounts = const {},
    super.key,
  });

  final TextEditingController controller;
  final BookLibraryFilter filter;
  final BookLibrarySort sort;
  final int totalCount;
  final int resultCount;

  /// How many books each status filter would show. Empty until known; the chips
  /// then carry no number.
  final Map<BookLibraryFilter, int> filterCounts;
  final VoidCallback onSearch;
  final ValueChanged<BookLibraryFilter> onFilter;
  final ValueChanged<BookLibrarySort> onSort;

  /// The filters worth offering: a status nobody's book is in is a chip that
  /// can only show an empty list, and when every book is in one status the
  /// filters say nothing "All books" does not. The selected one always stays,
  /// so the reader can see what they are looking at and clear it.
  List<BookLibraryFilter> get _offered {
    if (filterCounts.isEmpty) return BookLibraryFilter.values;
    final populated = [
      for (final option in BookLibraryFilter.values)
        if (option != BookLibraryFilter.all && (filterCounts[option] ?? 0) > 0)
          option,
    ];
    if (populated.length < 2 && filter == BookLibraryFilter.all) {
      return const [BookLibraryFilter.all];
    }
    return [
      BookLibraryFilter.all,
      for (final option in BookLibraryFilter.values)
        if (option != BookLibraryFilter.all &&
            ((filterCounts[option] ?? 0) > 0 || option == filter))
          option,
    ];
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final filtering =
        controller.text.trim().isNotEmpty || filter != BookLibraryFilter.all;
    final offered = _offered;
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
            hintText: 'Search by title, author or topic',
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
        if (offered.length > 1) ...[
          const SizedBox(height: AppSpacing.sm),
          // One row that scrolls sideways: four wrapped chips took two lines of
          // a screen that is mostly there to show books.
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final option in offered) ...[
                  ChoiceChip(
                    label: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(option.label),
                        if (filterCounts[option] != null) ...[
                          const SizedBox(width: 6),
                          Text(
                            '${filterCounts[option]}',
                            style: TextStyle(
                              color: colors.onSurfaceVariant,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ],
                    ),
                    selected: filter == option,
                    onSelected: (_) => onFilter(option),
                  ),
                  const SizedBox(width: AppSpacing.xs),
                ],
              ],
            ),
          ),
        ],
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
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ),
            Flexible(
              child: PopupMenuButton<BookLibrarySort>(
                tooltip: 'Sort books',
                // No `initialValue`: the check mark already says which is
                // selected, and a highlighted row is a ColoredBox around the
                // ListTile, which the themed tile asserts against.
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
                      Icon(
                        Icons.sort_rounded,
                        size: 18,
                        color: colors.onSurfaceVariant,
                      ),
                      const SizedBox(width: AppSpacing.xxs),
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
