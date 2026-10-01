import 'dart:async';

import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import 'studio_session.dart';

/// Where a chapter ends in the editor, and the way on from it.
///
/// On the last chapter it is "Add chapter 4": the moment an author finishes
/// the newest chapter is the moment they want the next one, and the end of
/// the page is where they are already looking. Any other chapter offers a new
/// one right after it. A picture book shows none — its pages have their own
/// "Add page" at their foot, and a second add beside it would read as a twin.
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
    final last = position >= session.chapterCount;
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
          if (last)
            AppButton.tonal(
              key: const ValueKey('studio-chapter-end-add'),
              label: session.addChapterLabel,
              leading: const Icon(Icons.add_rounded),
              loading: session.addingChapter,
              expanded: true,
              onPressed: () => unawaited(session.addChapter()),
            )
          else
            AppButton.outlined(
              key: const ValueKey('studio-chapter-end-add'),
              label: 'Add a chapter after this one',
              leading: const Icon(Icons.playlist_add_rounded),
              loading: session.addingChapter,
              expanded: true,
              onPressed: () => unawaited(
                session.addChapter(afterChapterId: session.chapterId),
              ),
            ),
        ],
      ),
    );
  }
}
