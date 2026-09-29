import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/motion.dart';
import '../domain/book_library.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';
import 'book_status.dart';

/// Hero tag a book's cover shares between the library and the screens it opens.
///
/// Both ends of a shared-element transition must build the same tag; the book
/// page and the reader wrap their own [BookCover] with this to opt in.
Object bookCoverHeroTag(String projectId) => 'book-cover-$projectId';

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
    final colors = theme.colorScheme;
    final category = BookLibraryFilter.forBook(book);
    // The filter calls a finished book ready even while its PDF is still being
    // compiled; the chip on the card has to agree with the chip above the list.
    final derived = bookStatusInfo(book);
    // The shelf may call a book with a finished export ready while an edit runs
    // on it; the library filters that same book under "in progress", so its card
    // keeps saying the work is running, as it always has.
    final runningOverReadyExport =
        book.isLive &&
        category == BookLibraryFilter.inProgress &&
        derived.kind == BookStatusKind.ready;
    final status = runningOverReadyExport
        ? BookStatusInfo(
            BookStatusKind.writing,
            '${book.progressPercent.clamp(0, 100)}% complete',
            progress: book.progressPercent.clamp(0, 100) / 100,
          )
        : category == BookLibraryFilter.ready &&
              derived.kind != BookStatusKind.ready
        ? const BookStatusInfo(BookStatusKind.ready, 'Ready')
        : derived;
    // The library speaks in the reader's words — the server's own label for a
    // running book, "Ready to read" for a finished one — where the drawer's
    // narrower shelf uses the short forms.
    final statusText = switch (status.kind) {
      BookStatusKind.writing =>
        '${book.statusLabel} · ${book.progressPercent.clamp(0, 100)}%',
      BookStatusKind.ready => 'Ready to read',
      _ => status.label,
    };
    final updated = MaterialLocalizations.of(
      context,
    ).formatMediumDate(book.updatedAt.toLocal());
    final pages = '${book.pageCount} ${book.pageCount == 1 ? 'page' : 'pages'}';
    final byline = [
      if (book.authorName?.trim().isNotEmpty == true) book.authorName!.trim(),
      if (book.subtitle?.trim().isNotEmpty == true) book.subtitle!.trim(),
    ].join(' · ');
    final failed = category == BookLibraryFilter.needsAttention;
    final progress = status.progress;

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            // The tap area is the book; the options button beside it is its own
            // target, so it is not folded into the book's description.
            child: InkWell(
              onTap: onOpen,
              child: Semantics(
                button: true,
                label: [
                  book.title,
                  statusText,
                  '${book.bookTypeLabel}, $pages',
                  'Updated $updated',
                ].join('. '),
                child: ExcludeSemantics(
                  child: Padding(
                    padding: const EdgeInsetsDirectional.fromSTEB(
                      AppSpacing.md,
                      AppSpacing.md,
                      0,
                      AppSpacing.md,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Hero(
                          tag: bookCoverHeroTag(book.id),
                          child: BookCover(
                            title: book.title,
                            seed: book.id,
                            image: book.coverImage,
                            authorName: book.authorName,
                            width: 72,
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
                                  height: 1.25,
                                ),
                              ),
                              if (byline.isNotEmpty) ...[
                                const SizedBox(height: 2),
                                Text(
                                  byline,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: colors.onSurfaceVariant,
                                  ),
                                ),
                              ],
                              const SizedBox(height: AppSpacing.xs),
                              BookStatusPill(
                                info: status,
                                labelOverride: statusText,
                              ),
                              if (progress != null) ...[
                                const SizedBox(height: AppSpacing.xs),
                                ClipRRect(
                                  borderRadius: BorderRadius.circular(
                                    AppRadii.pill,
                                  ),
                                  child: AppAnimatedProgressBar(
                                    value: progress,
                                    minHeight: 4,
                                  ),
                                ),
                              ],
                              if (failed) ...[
                                const SizedBox(height: AppSpacing.xs),
                                Text(
                                  'Open it to see what happened.',
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: colors.error,
                                  ),
                                ),
                              ],
                              const SizedBox(height: AppSpacing.xs),
                              Text(
                                '${book.bookTypeLabel} · $pages · '
                                'Updated $updated',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colors.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xxs),
            child: Builder(
              builder: (buttonContext) => IconButton(
                tooltip: 'Options for ${book.title}',
                icon: const Icon(Icons.more_vert),
                onPressed: () {
                  final box = buttonContext.findRenderObject() as RenderBox;
                  onOptions(box.localToGlobal(Offset(0, box.size.height)));
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}
