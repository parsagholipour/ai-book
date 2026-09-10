import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/polling_state_mixin.dart';
import '../../billing/data/billing_repository.dart';
import '../data/projects_repository.dart';
import '../domain/book_library.dart';
import '../domain/project_models.dart';
import 'book_actions_menu.dart';
import 'book_library_card.dart';
import 'book_library_controls.dart';
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

  @override
  Widget build(BuildContext context) {
    final projects = ref.watch(projectsProvider);
    final billing = ref.watch(billingProvider).asData?.value;
    if (!projects.hasError &&
        (projects.value?.any((book) => book.isLive) ?? false)) {
      startPolling(const Duration(seconds: 6), () {
        if (ModalRoute.of(context)?.isCurrent != true ||
            WidgetsBinding.instance.lifecycleState ==
                AppLifecycleState.paused ||
            ref.read(projectsProvider).isLoading) {
          return;
        }
        ref.invalidate(projectsProvider);
      });
    } else {
      stopPolling();
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Your books')),
      body: SafeArea(
        top: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: projects.when(
            loading: () => const AppLoadingState(message: 'Loading your books'),
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
                      if (books.isEmpty)
                        SliverToBoxAdapter(
                          child: AppEmptyState(
                            title: 'No books yet',
                            message:
                                'Your books will appear here once writing begins. '
                                'Ideas and plans are saved in your chats.',
                            actionLabel: 'New book',
                            onAction: () => context.push(newBookChatLocation()),
                          ),
                        )
                      else ...[
                        SliverPadding(
                          padding: EdgeInsets.fromLTRB(side, 12, side, 0),
                          sliver: SliverToBoxAdapter(
                            child: BookLibraryControls(
                              controller: _searchController,
                              filter: _filter,
                              sort: _sort,
                              totalCount: books.length,
                              resultCount: visible.length,
                              onSearch: () => setState(() {}),
                              onFilter: (value) =>
                                  setState(() => _filter = value),
                              onSort: (value) => setState(() => _sort = value),
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
