import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../billing/data/billing_repository.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'book_actions_menu.dart';
import 'book_cover.dart';
import 'message_hold_feedback.dart';

/// Horizontal shelf of the books the user has actually made.
///
/// Chats are how books get made, but the books themselves are the thing people
/// come back for. Without this the only route to a finished book is remembering
/// which conversation produced it, so the shelf sits above the chat list and
/// puts every book one tap away.
class BookShelf extends ConsumerWidget {
  const BookShelf({super.key});

  static const double _coverWidth = 84;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final projects = ref.watch(projectsProvider);
    // Watched, not read on demand: the hold menu needs the balance the moment
    // it opens to decide between unlocking and the paywall.
    final credits = ref.watch(billingProvider).asData?.value.credits.available;

    return projects.when(
      // A shelf that has never loaded should take no space rather than show a
      // spinner: the chat list below is the more important content.
      loading: () => const SizedBox.shrink(),
      error: (error, stackTrace) => const SizedBox.shrink(),
      data: (items) {
        final books = _shelfBooks(items);
        if (books.isEmpty) {
          return const SizedBox.shrink();
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Your books',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.5,
                      ),
                    ),
                  ),
                  Text(
                    '${books.length}',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            SizedBox(
              // Cover + the two label lines beneath it.
              height: _coverWidth / kBookCoverAspectRatio + 46,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: books.length,
                separatorBuilder: (context, index) => const SizedBox(width: 12),
                itemBuilder: (context, index) => AppEntrance(
                  index: index,
                  offset: 0,
                  child: _ShelfBook(
                    project: books[index],
                    width: _coverWidth,
                    credits: credits,
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            const Divider(height: 1),
          ],
        );
      },
    );
  }
}

/// Books worth shelving: anything past the idea stage.
///
/// Drafts with no plan are still conversations rather than books, and showing
/// them as covers would promise more than exists.
List<MobileProjectSummary> _shelfBooks(List<MobileProjectSummary> projects) {
  final books = projects
      .where((project) => project.hasPlan || project.pageCount > 0)
      .toList();
  books.sort((a, b) {
    // Finished books first — they are what people come back to open.
    final aDone = a.hasReadyExport ? 0 : 1;
    final bDone = b.hasReadyExport ? 0 : 1;
    if (aDone != bDone) {
      return aDone.compareTo(bDone);
    }
    return b.updatedAt.compareTo(a.updatedAt);
  });
  return books;
}

class _ShelfBook extends ConsumerWidget {
  const _ShelfBook({
    required this.project,
    required this.width,
    required this.credits,
  });

  final MobileProjectSummary project;
  final double width;
  final int? credits;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final status = _shelfStatus(project);

    return SizedBox(
      width: width,
      child: Semantics(
        button: true,
        label: '${project.title}. ${status.label}',
        // Long press exposes the export actions that are otherwise several
        // screens deep, so a finished book can be opened or shared without
        // leaving the drawer.
        onLongPressHint: 'Show open and share options',
        child: ExcludeSemantics(
          child: MessageHoldFeedback(
            onLongPressStart: (details) {
              AppHaptics.longPress();
              return showBookActionsMenu(
                context: context,
                ref: ref,
                position: details.globalPosition,
                project: project,
                credits: credits,
              );
            },
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () {
                AppHaptics.tap();
                Navigator.of(context).pop();
                context.push('/projects/${project.id}');
              },
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Stack(
                    children: [
                      BookCover(
                        title: project.title,
                        seed: project.id,
                        image: project.coverImage,
                        authorName: project.authorName,
                        width: width,
                      ),
                      if (status.showDot)
                        Positioned(
                          top: 6,
                          right: 6,
                          child: Container(
                            width: 10,
                            height: 10,
                            decoration: BoxDecoration(
                              color: status.dotColor(colors),
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: Colors.white.withValues(alpha: 0.9),
                                width: 1.5,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    project.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    status.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: status.emphasize
                          ? colors.primary
                          : colors.onSurfaceVariant,
                      fontWeight: status.emphasize ? FontWeight.w700 : null,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ShelfStatus {
  const _ShelfStatus({
    required this.label,
    this.emphasize = false,
    this.showDot = false,
    this.isError = false,
  });

  final String label;
  final bool emphasize;
  final bool showDot;
  final bool isError;

  Color dotColor(ColorScheme colors) => isError ? colors.error : colors.primary;
}

_ShelfStatus _shelfStatus(MobileProjectSummary project) {
  if (project.status.toLowerCase() == 'failed') {
    return const _ShelfStatus(
      label: 'Needs attention',
      showDot: true,
      isError: true,
    );
  }
  if (project.hasReadyExport) {
    return const _ShelfStatus(label: 'Ready', emphasize: true, showDot: true);
  }
  if (project.status.toLowerCase() == 'generating') {
    return _ShelfStatus(label: '${project.progressPercent}% written');
  }
  if (project.status.toLowerCase() == 'plan_ready') {
    return const _ShelfStatus(
      label: 'Plan to review',
      emphasize: true,
      showDot: true,
    );
  }
  return const _ShelfStatus(label: 'In progress');
}
