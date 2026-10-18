import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../data/creation_repository.dart';
import 'creation_chat_navigation.dart';

/// "Write the next book": a finished book's way into a new chat that
/// continues it — same characters, world and look, picking up where it
/// ended (`apps/api/src/mobile/creationSeries.ts`).
///
/// Nothing is sent from here and nothing is charged: the book's format is
/// fetched, a new chat opens with it applied and its first line started, and
/// the link rides the first message the reader sends, like a remix.
Future<void> startNextBook(
  BuildContext context,
  WidgetRef ref,
  String projectId,
) async {
  try {
    final start = await ref
        .read(creationRepositoryProvider)
        .loadNextBook(projectId);
    if (!context.mounted) return;
    context.go(newBookChatLocation(), extra: start);
  } catch (error) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
  }
}

/// The book page's offer of a sequel, under a finished book the reader's
/// own generation wrote.
class NextBookCard extends ConsumerStatefulWidget {
  const NextBookCard({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<NextBookCard> createState() => _NextBookCardState();
}

class _NextBookCardState extends ConsumerState<NextBookCard> {
  bool _opening = false;

  Future<void> _open() async {
    if (_opening) return;
    setState(() => _opening = true);
    await startNextBook(context, ref, widget.projectId);
    if (mounted) setState(() => _opening = false);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return AppCard(
      onTap: _opening ? null : () => _open(),
      semanticLabel: 'Write the next book',
      child: Row(
        children: [
          Icon(Icons.auto_stories_outlined, color: colors.primary),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Write the next book', style: theme.textTheme.titleSmall),
                const SizedBox(height: AppSpacing.xxs),
                Text(
                  'Continue this story with the same characters, world and look.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.xs),
          _opening
              ? const SizedBox.square(
                  dimension: AppSizes.buttonProgressIndicator,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Icon(Icons.chevron_right, color: colors.onSurfaceVariant),
        ],
      ),
    );
  }
}
