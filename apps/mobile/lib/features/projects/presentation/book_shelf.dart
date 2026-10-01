import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
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

/// The cover width the shelf aims for. The width it actually uses comes from
/// [_shelfTileWidth]: three covers and a slice of the fourth in the drawer.
///
/// It was 110 (two and a half covers), which made the shelf take more of the
/// drawer's height than the chat list below it could spare.
const double _targetCoverWidth = 76;

const double _shelfPadding = 20;
const double _shelfGap = 10;

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
    // Only empty before the first fetch of the app's lifetime, or when there is
    // nothing to shelve. A shelf that has never loaded should take no space
    // rather than show a spinner: the chat list below is the more important
    // content.
    final shelf = books.isEmpty
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final tileWidth = _shelfTileWidth(
                  available: constraints.maxWidth,
                  textScale: MediaQuery.textScalerOf(context).scale(1),
                );
                // Sized by its tallest tile, not by a number: a two-line title
                // grows with the reader's text size, and a fixed height is
                // what overflowed here at 1.6x.
                return SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(
                    horizontal: _shelfPadding,
                  ),
                  // No entrance animation: these are books the drawer already
                  // knows about, and staggering them in on top of the drawer's
                  // own slide is what made them look like they were still
                  // loading.
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final (index, project)
                          in books.take(_shelfLimit).indexed) ...[
                        if (index > 0) const SizedBox(width: _shelfGap),
                        _ShelfBook(
                          key: ValueKey(project.id),
                          project: project,
                          width: tileWidth,
                          billing: billing,
                        ),
                      ],
                      if (books.length > _shelfLimit) ...[
                        const SizedBox(width: _shelfGap),
                        _ShelfMore(
                          width: tileWidth,
                          count: books.length,
                          onTap: _openLibrary,
                        ),
                      ],
                    ],
                  ),
                );
              },
            ),
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

/// How wide one book on the shelf is: as many whole covers as fit near
/// [_targetCoverWidth], plus a slice of the next one.
///
/// The strip scrolls sideways, and the slice of the next cover is what says so.
/// A strip that ends exactly at the edge reads as all there is, and one that
/// clips the next cover by a sliver reads as a layout bug — three fixed 88dp
/// covers overshot the 304dp drawer by 4dp and did exactly that.
///
/// The target grows with the reader's text size (up to half again), so at
/// large text the shelf drops to two covers and a slice before a title's
/// words stop fitting on a line and break mid-word.
double _shelfTileWidth({required double available, required double textScale}) {
  final target = _targetCoverWidth * textScale.clamp(1.0, 1.5);
  if (!available.isFinite) return target;
  final room = available - _shelfPadding;
  final whole = ((room + _shelfGap) / (target + _shelfGap)).floor().clamp(1, 6);
  const peek = 0.4;
  return (room - whole * _shelfGap) / (whole + peek);
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
                                minHeight: 3,
                                color: Colors.white,
                                backgroundColor: Colors.black.withValues(
                                  alpha: 0.35,
                                ),
                              ),
                            ),
                          ),
                        ),
                      // A finished book wears nothing: most of the shelf is
                      // finished books, and a badge on every one of them is
                      // noise that hides the one book that needs the reader.
                      if (status.kind != BookStatusKind.ready)
                        PositionedDirectional(
                          top: 5,
                          start: 5,
                          end: 5,
                          child: Align(
                            alignment: AlignmentDirectional.topStart,
                            child: _CoverBadge(info: status),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  // Past 1.5x a word as long as "Headlines" no longer fits a
                  // cover's width and breaks mid-letter; the full title is a
                  // tap away and in the screen reader's label.
                  MediaQuery.withClampedTextScaling(
                    maxScaleFactor: 1.5,
                    child: Text(
                      currentProject.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                        height: 1.25,
                      ),
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

/// Where an unfinished book stands, on the top-left corner of its cover.
///
/// On the cover rather than under the title, so every tile is a cover and a
/// title and the strip stays one height; a status line under each title cost
/// the shelf a row. A dark scrim keeps the words legible on any cover art, and
/// only a failure gets a colour of its own.
///
/// The words are the short forms a ~75dp cover has room for. They never wrap —
/// a wrapped word breaks mid-letter in a badge this narrow — and scale down
/// instead at a text size where they do not fit.
class _CoverBadge extends StatelessWidget {
  const _CoverBadge({required this.info});

  final BookStatusInfo info;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final failed = info.kind == BookStatusKind.needsAttention;
    final background = failed
        ? colors.error
        : Colors.black.withValues(alpha: 0.62);
    final foreground = failed ? colors.onError : Colors.white;
    final progress = info.progress;
    final icon = info.icon;
    final label = switch (info.kind) {
      BookStatusKind.writing => '${((progress ?? 0) * 100).round()}%',
      BookStatusKind.needsAttention => 'Failed',
      BookStatusKind.planReady => 'Review',
      BookStatusKind.inProgress || BookStatusKind.ready => info.label,
    };
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.2,
      child: FittedBox(
        fit: BoxFit.scaleDown,
        alignment: AlignmentDirectional.topStart,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(AppRadii.pill),
          ),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(5, 2, 7, 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (progress != null)
                  SizedBox.square(
                    dimension: 9,
                    child: CircularProgressIndicator(
                      value: progress,
                      strokeWidth: 1.6,
                      color: foreground,
                      backgroundColor: foreground.withValues(alpha: 0.3),
                    ),
                  )
                else if (icon != null)
                  Icon(icon, size: 11, color: foreground),
                if (progress != null || icon != null) const SizedBox(width: 3),
                Text(
                  label,
                  maxLines: 1,
                  softWrap: false,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: foreground,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    height: 1.3,
                    letterSpacing: 0.1,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
