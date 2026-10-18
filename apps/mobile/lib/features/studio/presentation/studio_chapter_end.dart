import 'dart:async';

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/manuscript_models.dart';
import 'studio_session.dart';

/// Where a chapter ends in the editor, and the way on from it.
///
/// On the last chapter it is "Add chapter 4": the moment an author finishes
/// the newest chapter is the moment they want the next one, and the end of
/// the page is where they are already looking. Any other chapter already has
/// a next one, so the way on is that chapter, by name; a new chapter right
/// after this one stays beneath it, smaller. A picture book shows none — its
/// pages have their own "Add page" at their foot, and a second add beside it
/// would read as a twin.
class StudioChapterEnd extends StatelessWidget {
  const StudioChapterEnd({required this.session, super.key});

  final StudioSession session;

  @override
  Widget build(BuildContext context) {
    final document = session.document;
    if (document == null || document.isPictureLayout) {
      return const SizedBox.shrink();
    }
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final position = session.chapterPosition;
    final next = session.nextChapter;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Divider(color: colors.outlineVariant)),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                child: Text(
                  'End of chapter $position',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
              Expanded(child: Divider(color: colors.outlineVariant)),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          if (next == null)
            AppButton.tonal(
              key: const ValueKey('studio-chapter-end-add'),
              label: session.addChapterLabel,
              leading: const Icon(Icons.add_rounded),
              loading: session.addingChapter,
              expanded: true,
              onPressed: () => unawaited(session.addChapter()),
            )
          else ...[
            _NextChapterCard(
              chapter: next,
              position: position + 1,
              onTap: session.addingChapter
                  ? null
                  : () => unawaited(session.switchChapter(next.id)),
            ),
            const SizedBox(height: AppSpacing.xs),
            Center(
              child: AppButton.text(
                key: const ValueKey('studio-chapter-end-add'),
                label: 'Add a chapter after this one',
                leading: const Icon(Icons.playlist_add_rounded),
                loading: session.addingChapter,
                onPressed: () => unawaited(
                  session.addChapter(afterChapterId: session.chapterId),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The chapter after this one, named the way its own page heads it: the
/// number over the title, or the number alone while the title is still
/// "Chapter 3".
class _NextChapterCard extends StatelessWidget {
  const _NextChapterCard({
    required this.chapter,
    required this.position,
    required this.onTap,
  });

  final ManuscriptChapterSummary chapter;
  final int position;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final named = !isPlaceholderChapterTitle(chapter.title, position);
    final kicker = named ? 'Next · Chapter $position' : 'Next';
    final title = named ? chapter.displayTitle : 'Chapter $position';
    return AppCard(
      key: const ValueKey('studio-chapter-end-next'),
      onTap: onTap,
      semanticLabel: 'Next chapter: $title',
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  kicker.toUpperCase(),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.primary,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.4,
                  ),
                ),
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          // Mirrors itself in a right-to-left book.
          Icon(Icons.arrow_forward_rounded, color: colors.primary),
        ],
      ),
    );
  }
}
