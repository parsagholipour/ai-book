import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/project_models.dart';
import 'book_cover.dart';

/// The app bar's title: which book this conversation is about.
///
/// A small cover and the title, with a second line that says what the chat is
/// doing — so a reader who arrives from the reader or the shelf knows at once
/// whose pages they are about to change. Before the project loads (or if it
/// cannot) it is the plain fallback title, with nothing invented.
class ProjectChatBookIdentity extends StatelessWidget {
  const ProjectChatBookIdentity({
    required this.project,
    required this.live,
    super.key,
  });

  final MobileProjectDetail? project;
  final bool live;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final book = project;
    if (book == null) {
      return const Text('Book chat');
    }
    return Row(
      children: [
        BookCover(
          title: book.title,
          seed: book.id,
          image: book.coverImage,
          width: 28,
          borderRadius: 4,
          elevated: false,
        ),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                book.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              Text(
                live ? 'Working on your book…' : 'Book chat',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: live ? colors.primary : colors.onSurfaceVariant,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
