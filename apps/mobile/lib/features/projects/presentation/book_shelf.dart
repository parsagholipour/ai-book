import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../data/projects_repository.dart';
import '../domain/project_models.dart';
import 'book_actions_menu.dart';
import 'book_cover.dart';
import 'message_hold_feedback.dart';

const double _coverWidth = 84;

/// Horizontal shelf of the books the user has actually made.
///
/// Chats are how books get made, but the books themselves are the thing people
/// come back for. Without this the only route to a finished book is remembering
/// which conversation produced it, so the shelf sits above the chat list and
/// puts every book one tap away.
class BookShelf extends ConsumerStatefulWidget {
  const BookShelf({super.key});

  @override
  ConsumerState<BookShelf> createState() => _BookShelfState();
}

class _BookShelfState extends ConsumerState<BookShelf> {
  @override
  void initState() {
    super.initState();
    // Stale-while-revalidate. [projectsProvider] is cached, so the build below
    // paints the books we already have the moment the drawer opens; this asks
    // for a fresh list behind them. Invalidating keeps the cached value on the
    // loading state, so nothing blanks out while the request runs.
    //
    // After the first frame, not from here: invalidating marks the enclosing
    // ProviderScope dirty, which the framework forbids mid-build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // A request is already in flight (the first build of the app's lifetime
      // started one); there is nothing stale to replace yet.
      if (ref.read(projectsProvider).isLoading) return;
      ref.invalidate(projectsProvider);
    });
  }

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(projectsProvider);
    // Watched, not read on demand: the hold menu needs the balance the moment
    // it opens to decide between unlocking and the paywall.
    final credits = ref.watch(billingProvider).asData?.value.credits.available;

    return projects.when(
      // Only reached before the first fetch of the app's lifetime. A shelf that
      // has never loaded should take no space rather than show a spinner: the
      // chat list below is the more important content.
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
                // No entrance animation: these are books the drawer already
                // knows about, and staggering them in on top of the drawer's
                // own slide is what made them look like they were still
                // loading.
                itemBuilder: (context, index) {
                  final project = books[index];
                  return _ShelfBook(
                    key: ValueKey(project.id),
                    project: project,
                    width: _coverWidth,
                    credits: credits,
                  );
                },
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

/// Books worth shelving: projects with generated manuscript pages.
///
/// Ideas and plans remain available in chat, but they are not books yet and
/// should not appear under "Your books" until writing has actually started.
List<MobileProjectSummary> _shelfBooks(List<MobileProjectSummary> projects) {
  final books = projects.where((project) => project.pageCount > 0).toList();
  // Most recently touched first, whatever state it is in. Ranking finished
  // books above the rest buried the book being written right now — the one the
  // user is most likely to be waiting on — behind every book they already read.
  books.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return books;
}

class _ShelfBook extends ConsumerStatefulWidget {
  const _ShelfBook({
    super.key,
    required this.project,
    required this.width,
    required this.credits,
  });

  final MobileProjectSummary project;
  final double width;
  final int? credits;

  @override
  ConsumerState<_ShelfBook> createState() => _ShelfBookState();
}

class _ShelfBookState extends ConsumerState<_ShelfBook> {
  bool _requestedSettledRefresh = false;

  @override
  void didUpdateWidget(covariant _ShelfBook oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.project.id != widget.project.id ||
        (!oldWidget.project.isLive && widget.project.isLive)) {
      _requestedSettledRefresh = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final project = widget.project;
    final liveStatus = project.isLive
        ? ref.watch(projectStatusProvider(project.id)).asData?.value
        : null;

    // The status stream contains enough data to make the card current while
    // the drawer stays open. Once it settles, refresh the full list once as
    // well so fields the status payload does not carry (notably cover art) are
    // brought into the long-lived shelf cache.
    if (liveStatus != null && !liveStatus.isLive && !_requestedSettledRefresh) {
      _requestedSettledRefresh = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        ref.invalidate(projectsProvider);
      });
    }

    final currentProject = liveStatus == null
        ? project
        : _projectWithStatus(project, liveStatus);
    final colors = Theme.of(context).colorScheme;
    final status = _shelfStatus(currentProject);

    return SizedBox(
      width: widget.width,
      child: Semantics(
        button: true,
        label: '${currentProject.title}. ${status.label}',
        // Long press exposes chat and export actions that are otherwise several
        // screens deep.
        onLongPressHint: 'Show book options',
        child: ExcludeSemantics(
          child: MessageHoldFeedback(
            onLongPressStart: (details) {
              AppHaptics.longPress();
              return showBookActionsMenu(
                context: context,
                ref: ref,
                position: details.globalPosition,
                project: currentProject,
                credits: widget.credits,
              );
            },
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () {
                AppHaptics.tap();
                Navigator.of(context).pop();
                // A finished book opens in the reader; one still being made
                // opens on its own page, which shows whichever of plan,
                // progress and exports is true right now.
                context.push(
                  currentProject.exports.pdf.available
                      ? '/projects/${currentProject.id}/read'
                      : '/projects/${currentProject.id}',
                );
              },
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Stack(
                    children: [
                      BookCover(
                        title: currentProject.title,
                        seed: currentProject.id,
                        image: currentProject.coverImage,
                        authorName: currentProject.authorName,
                        width: widget.width,
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
                    currentProject.title,
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

/// Applies the streamed fields to the cached summary used by the shelf card.
///
/// Keeping this merge local avoids making the whole project list refetch on
/// every one-second status event, while menus and navigation still see the
/// newly available exports as soon as generation finishes.
MobileProjectSummary _projectWithStatus(
  MobileProjectSummary project,
  MobileProjectStatus status,
) {
  return MobileProjectSummary(
    id: project.id,
    title: project.title,
    subtitle: project.subtitle,
    authorName: project.authorName,
    source: project.source,
    coverImage: project.coverImage,
    bookType: project.bookType,
    lengthPreset: project.lengthPreset,
    qualityPreset: project.qualityPreset,
    coverEnabled: status.imageSettingsReported
        ? status.coverEnabled
        : project.coverEnabled,
    illustrationsEnabled: status.imageSettingsReported
        ? status.illustrationsEnabled
        : project.illustrationsEnabled,
    status: status.status,
    statusLabel: status.statusLabel,
    progressPercent: status.progressPercent,
    currentAction: status.currentAction,
    promptPreview: project.promptPreview,
    targetPages: status.pageProgress.target,
    pageCount: status.pageProgress.completed,
    imageCount: status.imageCount,
    hasPlan: project.hasPlan,
    exports: status.exports,
    createdAt: project.createdAt,
    updatedAt: status.updatedAt,
  );
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
  if (project.isLive) {
    return _ShelfStatus(label: '${project.progressPercent}% complete');
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
