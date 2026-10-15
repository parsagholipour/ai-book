import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/polling_state_mixin.dart';
import '../../auth/presentation/verify_email_banner.dart';
import '../../billing/data/billing_repository.dart';
import '../../studio/presentation/start_writing_sheet.dart';
import '../data/offline_library_store.dart';
import '../data/projects_repository.dart';
import '../domain/book_library.dart';
import '../domain/project_models.dart';
import 'book_actions_menu.dart';
import 'book_library_card.dart';
import 'book_library_controls.dart';
import 'book_library_skeleton.dart';
import 'creation_chat_navigation.dart';

class BookLibraryScreen extends ConsumerStatefulWidget {
  const BookLibraryScreen({super.key});

  @override
  ConsumerState<BookLibraryScreen> createState() => _BookLibraryScreenState();
}

class _BookLibraryScreenState extends ConsumerState<BookLibraryScreen>
    with PollingStateMixin<BookLibraryScreen> {
  final _searchController = TextEditingController();
  BookLibraryFilter _filter = BookLibraryFilter.all;
  BookLibrarySort _sort = BookLibrarySort.updated;

  /// The interval the running poll was started with, so a change of reason
  /// (a live book, or reconnecting) can restart it at its own pace.
  Duration? _pollInterval;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && !ref.read(projectsProvider).isLoading) {
        ref.invalidate(projectsProvider);
      }
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _refresh() => ref.refresh(projectsProvider.future);

  void _resetSearch() {
    _searchController.clear();
    setState(() => _filter = BookLibraryFilter.all);
  }

  Future<void> _openBook(MobileProjectSummary book) async {
    AppHaptics.tap();
    await context.push(
      book.exports.pdf.available
          ? '/projects/${book.id}/read'
          : '/projects/${book.id}',
    );
    if (mounted) ref.invalidate(projectsProvider);
  }

  void _pollEvery(Duration? interval) {
    if (interval == _pollInterval) return;
    stopPolling();
    _pollInterval = interval;
    if (interval == null) return;
    startPolling(interval, () {
      if (ModalRoute.of(context)?.isCurrent != true ||
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.paused ||
          ref.read(projectsProvider).isLoading) {
        return;
      }
      ref.invalidate(projectsProvider);
    });
  }

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(projectsProvider);
    final billing = ref.watch(billingProvider).asData?.value;
    // Set by `projectsProvider` with the answer being shown: the phone's copy
    // of the library, read because the server could not be reached.
    final offlineSince = projects.hasValue && !projects.hasError
        ? ref.read(offlineLibraryMarkerProvider).savedAt
        : null;
    // Offline, a running book's progress is a memory, not news: the list asks
    // again now and then to reconnect, never at a live book's pace.
    _pollEvery(
      offlineSince != null
          ? const Duration(seconds: 30)
          : !projects.hasError &&
                (projects.value?.any((book) => book.isLive) ?? false)
          ? const Duration(seconds: 6)
          : null,
    );

    return Scaffold(
      appBar: AppBar(title: const Text('Your books')),
      body: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: projects.when(
            loading: () => const BookLibrarySkeleton(),
            error: (error, _) => ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: [
                AppErrorState(
                  title: 'Could not load your books',
                  message: userFacingError(error),
                  onRetry: () => ref.invalidate(projectsProvider),
                ),
              ],
            ),
            data: (projects) {
              final books = libraryBooks(projects);
              final visible = searchLibraryBooks(
                books,
                query: _searchController.text,
                filter: _filter,
                sort: _sort,
              );
              final counts = {
                BookLibraryFilter.all: books.length,
                for (final option in BookLibraryFilter.values)
                  if (option != BookLibraryFilter.all)
                    option: books
                        .where(
                          (book) => BookLibraryFilter.forBook(book) == option,
                        )
                        .length,
              };
              return LayoutBuilder(
                builder: (context, constraints) {
                  final width = constraints.maxWidth.clamp(0.0, 880.0);
                  final side = (constraints.maxWidth - width) / 2 + 18;
                  return CustomScrollView(
                    key: const PageStorageKey('book-library-scroll'),
                    physics: const AlwaysScrollableScrollPhysics(),
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    slivers: [
                      // The welcome credits waiting on the reader's email.
                      SliverToBoxAdapter(
                        child: VerifyEmailBanner(
                          padding: EdgeInsets.fromLTRB(side, 12, side, 0),
                        ),
                      ),
                      if (offlineSince != null)
                        SliverToBoxAdapter(
                          child: Padding(
                            padding: EdgeInsets.fromLTRB(side, 12, side, 0),
                            child: OfflineLibraryNotice(
                              savedAt: offlineSince,
                              onRetry: () => ref.invalidate(projectsProvider),
                            ),
                          ),
                        ),
                      if (books.isEmpty)
                        SliverFillRemaining(
                          hasScrollBody: false,
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              AppEmptyState(
                                title: 'No books yet',
                                message:
                                    'Your books will appear here once writing begins. '
                                    'Ideas and plans are saved in your chats.',
                                actionLabel: 'New book',
                                onAction: () =>
                                    context.push(newBookChatLocation()),
                              ),
                              // The other way a book arrives: one the reader
                              // writes, or has already written.
                              AppButton.text(
                                key: const ValueKey(
                                  'library-write-it-yourself',
                                ),
                                label: 'Write it yourself',
                                leading: const Icon(Icons.edit_note_outlined),
                                onPressed: () => showStartWritingSheet(context),
                              ),
                            ],
                          ),
                        )
                      else ...[
                        // Reappears the moment the reader scrolls back up, so a
                        // long list never has to be scrolled to its top to
                        // search it.
                        SliverFloatingHeader(
                          child: Material(
                            color: Theme.of(context).scaffoldBackgroundColor,
                            child: Padding(
                              padding: EdgeInsets.fromLTRB(side, 12, side, 0),
                              child: BookLibraryControls(
                                controller: _searchController,
                                filter: _filter,
                                sort: _sort,
                                totalCount: books.length,
                                resultCount: visible.length,
                                filterCounts: counts,
                                onSearch: () => setState(() {}),
                                onFilter: (value) =>
                                    setState(() => _filter = value),
                                onSort: (value) =>
                                    setState(() => _sort = value),
                              ),
                            ),
                          ),
                        ),
                        if (visible.isEmpty)
                          SliverToBoxAdapter(
                            child: AppEmptyState(
                              icon: Icons.search_off_rounded,
                              title: 'No matching books',
                              message:
                                  'Try another title, author, or topic, '
                                  'or clear your filters.',
                              actionLabel: 'Reset search and filters',
                              onAction: _resetSearch,
                            ),
                          )
                        else
                          SliverPadding(
                            padding: EdgeInsets.fromLTRB(side, 8, side, 24),
                            sliver: SliverList.separated(
                              itemCount: visible.length,
                              separatorBuilder: (_, _) =>
                                  const SizedBox(height: AppSpacing.sm),
                              itemBuilder: (context, index) {
                                final book = visible[index];
                                return BookLibraryCard(
                                  key: ValueKey(book.id),
                                  book: book,
                                  offline: offlineSince != null,
                                  onOpen: () => _openBook(book),
                                  onOptions: (position) => showBookActionsMenu(
                                    context: context,
                                    ref: ref,
                                    position: position,
                                    project: book,
                                    billing: billing,
                                    onRefresh: () =>
                                        ref.invalidate(projectsProvider),
                                  ),
                                );
                              },
                            ),
                          ),
                      ],
                    ],
                  );
                },
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Says the library on screen is the phone's copy: from when, what still
/// works, and a way to ask the server again. Calm rather than an error —
/// nothing is wrong with the books, only with the connection.
class OfflineLibraryNotice extends StatelessWidget {
  const OfflineLibraryNotice({
    required this.savedAt,
    required this.onRetry,
    super.key,
  });

  final DateTime savedAt;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final local = MaterialLocalizations.of(context);
    final at = savedAt.toLocal();
    final when =
        '${local.formatMediumDate(at)}, '
        '${local.formatTimeOfDay(TimeOfDay.fromDateTime(at))}';
    return AppInlineNotice(
      key: const ValueKey('offline-library-notice'),
      icon: Icons.cloud_off_outlined,
      title: "You're offline",
      message:
          'Showing your books as of $when. Books and audiobooks downloaded '
          'to this phone still open; the rest waits for a connection.',
      actionLabel: 'Try again',
      onAction: onRetry,
    );
  }
}
