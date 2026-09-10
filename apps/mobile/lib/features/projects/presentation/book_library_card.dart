import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/book_library.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';

class BookLibraryCard extends StatelessWidget {
  const BookLibraryCard({
    required this.book,
    required this.onOpen,
    required this.onOptions,
    super.key,
  });

  final MobileProjectSummary book;
  final VoidCallback onOpen;
  final ValueChanged<Offset> onOptions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final category = BookLibraryFilter.forBook(book);
    final status = book.isLive
        ? '${book.statusLabel} · ${book.progressPercent.clamp(0, 100)}%'
        : category.label;
    final updated = MaterialLocalizations.of(
      context,
    ).formatMediumDate(book.updatedAt.toLocal());
    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExcludeSemantics(
                child: BookCover(
                  title: book.title,
                  seed: book.id,
                  image: book.coverImage,
                  authorName: book.authorName,
                  width: 64,
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      book.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (book.subtitle?.trim().isNotEmpty == true)
                      Text(
                        book.subtitle!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                    if (book.authorName?.trim().isNotEmpty == true)
                      Text(
                        book.authorName!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      status,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: category == BookLibraryFilter.needsAttention
                            ? theme.colorScheme.error
                            : theme.colorScheme.primary,
                      ),
                    ),
                    const SizedBox(height: AppSpacing.xxs),
                    Text(
                      '${book.bookTypeLabel} · ${book.pageCount} '
                      '${book.pageCount == 1 ? 'page' : 'pages'}',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    Text(
                      'Updated $updated',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              Builder(
                builder: (buttonContext) => IconButton(
                  tooltip: 'Options for ${book.title}',
                  icon: const Icon(Icons.more_vert),
                  onPressed: () {
                    final box = buttonContext.findRenderObject() as RenderBox;
                    onOptions(box.localToGlobal(Offset(0, box.size.height)));
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
