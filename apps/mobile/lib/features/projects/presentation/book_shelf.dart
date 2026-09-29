import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/haptics.dart';
import '../../billing/data/billing_repository.dart';
import '../../billing/domain/billing_models.dart';
import '../data/projects_repository.dart';
import '../domain/book_library.dart';
import '../domain/project_models.dart';
import 'book_actions_menu.dart';
import 'book_cover.dart';
import 'book_status.dart';
import 'chat_drawer_chrome.dart';
import 'message_hold_feedback.dart';

const double _coverWidth = 88;

/// How many books the shelf lays out before it hands over to "See all".
///
/// A reader with 200 books does not scroll a strip 200 covers long; the most
/// recent dozen are the ones they came for, and the library — with search,
/// filters and sorting — is the place for the rest.
const int _shelfLimit = 12;

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

  void _openLibrary() {
    AppHaptics.tap();
    Navigator.of(context).pop();
    context.push('/books');
  }

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(projectsProvider);
    // Watched, not read on demand: the hold menu needs the balance and the plan
    // the moment it opens to decide between unlocking and the paywall.
    final billing = ref.watch(billingProvider).asData?.value;
    final books = projects.value == null
        ? const <MobileProjectSummary>[]
        : libraryBooks(projects.value!);
    // Tiles grow with the reader's text size (up to half again): the status
    // chip and two-line title are text, and squeezing them into a fixed 88dp
    // is what broke "attention" across three lines.
    final tileWidth =
        _coverWidth * MediaQuery.textScalerOf(context).scale(1).clamp(1.0, 1.5);

    // Only empty before the first fetch of the app's lifetime, or when there is
    // nothing to shelve. A shelf that has never loaded should take no space
    // rather than show a spinner: the chat list below is the more important
    // content.
    final shelf = books.isEmpty
        ? const SizedBox.shrink()
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Sized by its tallest tile, not by a number: two-line titles and
              // a status chip grow with the reader's text size, and a fixed
              // height is what overflowed here at 1.6x.
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 20),
                // No entrance animation: these are books the drawer already
                // knows about, and staggering them in on top of the drawer's
                // own slide is what made them look like they were still
                // loading.
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final project in books.take(_shelfLimit)) ...[
                      _ShelfBook(
                        key: ValueKey(project.id),
                        project: project,
                        width: tileWidth,
                        billing: billing,
                      ),
                      const SizedBox(width: 12),
                    ],
                    if (books.length > _shelfLimit)
                      _ShelfMore(
                        width: tileWidth,
                        count: books.length,
                        onTap: _openLibrary,
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],
          );
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DrawerNavRow(
          key: const ValueKey('drawer-books-row'),
          icon: Icons.menu_book_outlined,
          title: 'Your books',
          count: projects.value == null ? null : books.length,
          onTap: _openLibrary,
        ),
        shelf,
        const Divider(height: 1),
      ],
    );
  }
}

/// The shelf's last tile once there are more books than it lays out: a
/// destination shaped like a cover, so the strip ends in "there is more, and it
/// is this way" instead of simply running out.
class _ShelfMore extends StatelessWidget {
  const _ShelfMore({
    required this.width,
    required this.count,
    required this.onTap,
  });

  final double width;
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return SizedBox(
      width: width,
      child: Semantics(
        button: true,
        label: 'See all $count books',
        child: ExcludeSemantics(
          child: AspectRatio(
            aspectRatio: kBookCoverAspectRatio,
            child: Material(
              color: colors.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(10),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: onTap,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          '$count',
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        Text(
                          'See all',
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Icon(
                          Icons.arrow_forward_rounded,
                          size: 20,
                          color: colors.primary,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ShelfBook extends ConsumerStatefulWidget {
  const _ShelfBook({
    super.key,
    required this.project,
    required this.width,
    required this.billing,
  });

  final MobileProjectSummary project;
  final double width;
  final MobileBilling? billing;

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
        : projectWithLiveStatus(project, liveStatus);
    final status = bookStatusInfo(currentProject);
    final progress = status.progress;

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
                billing: widget.billing,
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
                      // A book being written shows how far along it is on the
                      // cover itself; a settled one holds still.
                      if (progress != null)
                        Positioned.fill(
                          child: Align(
                            alignment: Alignment.bottomCenter,
                            child: ClipRRect(
                              borderRadius: const BorderRadius.vertical(
                                bottom: Radius.circular(10),
                              ),
                              child: LinearProgressIndicator(
                                value: progress,
                                minHeight: 4,
                                color: Colors.white,
                                backgroundColor: Colors.black.withValues(
                                  alpha: 0.35,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    currentProject.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                      height: 1.25,
                    ),
                  ),
                  const SizedBox(height: 4),
                  BookStatusPill(info: status),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
