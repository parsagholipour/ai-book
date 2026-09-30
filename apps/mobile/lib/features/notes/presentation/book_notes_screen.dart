import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../../shared/ui/haptics.dart';
import '../data/book_notes_repository.dart';
import '../domain/book_note.dart';
import 'book_note_card.dart';
import 'notes_common.dart';
import 'notes_location.dart';

/// From this many notes the list offers a search field.
const bookNotesSearchThreshold = 6;

/// A book's private notebook: every note, pinned ones first.
///
/// Nothing here is printed or sent to a model, and the empty page says so
/// once. Writing happens in the note itself; this page opens, pins and
/// deletes them.
class BookNotesScreen extends ConsumerStatefulWidget {
  const BookNotesScreen({required this.projectId, super.key});

  final String projectId;

  @override
  ConsumerState<BookNotesScreen> createState() => _BookNotesScreenState();
}

class _BookNotesScreenState extends ConsumerState<BookNotesScreen> {
  final _search = TextEditingController();

  String get _projectId => widget.projectId;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      ref.invalidate(bookNotesProvider(_projectId));
      await ref.read(bookNotesProvider(_projectId).future);
    } catch (error) {
      // The notes already on screen stay; only the refresh failed.
      messenger.showAppSnackBar(
        SnackBar(
          content: Text(
            'Could not refresh your notes. ${userFacingError(error)}',
          ),
        ),
      );
    }
  }

  void _open(BookNote note) {
    AppHaptics.tap();
    unawaited(context.push(bookNoteLocation(_projectId, note.id)));
  }

  void _newNote(List<BookNote> notes) {
    if (notes.length >= bookNotesPerBookLimit) {
      AppHaptics.warning();
      ScaffoldMessenger.of(context).showAppSnackBar(
        const SnackBar(
          content: Text(
            'This book has $bookNotesPerBookLimit notes, the most it can '
            'hold. Delete one to add another.',
          ),
        ),
      );
      return;
    }
    AppHaptics.tap();
    unawaited(context.push(newBookNoteLocation(_projectId)));
  }

  Future<void> _onAction(BookNote note, BookNoteMenuAction action) async {
    final actions = ref.read(bookNotesActionsProvider);
    final messenger = ScaffoldMessenger.of(context);
    switch (action) {
      case BookNoteMenuAction.pin:
        AppHaptics.selection();
        try {
          await actions.setPinned(_projectId, note, pinned: !note.pinned);
        } catch (error) {
          messenger.showAppSnackBar(
            SnackBar(
              content: Text(
                note.pinned
                    ? 'Could not unpin the note. ${userFacingError(error)}'
                    : 'Could not pin the note. ${userFacingError(error)}',
              ),
            ),
          );
        }
      case BookNoteMenuAction.delete:
        await deleteBookNoteWithUndo(
          messenger: messenger,
          actions: actions,
          projectId: _projectId,
          stored: note,
          restore: note.draft,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final value = ref.watch(bookNotesProvider(_projectId));
    final bookTitle = watchNotesBookTitle(ref, _projectId);
    final notes = value.value;

    return Scaffold(
      appBar: AppBar(
        toolbarHeight: bookTitle == null ? null : 64,
        title: NotesBarTitle(
          title: const Text('Notes'),
          subtitle: bookTitle == null
              ? null
              : Text(
                  bookTitle,
                  key: const ValueKey('book-notes-book-title'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
        ),
      ),
      // Only once there are notes: the empty page carries its own button,
      // and one that shows while loading only to vanish is a flicker.
      floatingActionButton: notes != null && notes.isNotEmpty
          ? FloatingActionButton.extended(
              key: const ValueKey('book-notes-new'),
              onPressed: () => _newNote(notes),
              backgroundColor: colors.primary,
              foregroundColor: colors.onPrimary,
              icon: const Icon(Icons.add_rounded),
              label: const Text('New note'),
            )
          : null,
      body: SafeArea(
        top: false,
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth.clamp(0.0, 720.0);
              final side = (constraints.maxWidth - width) / 2 + AppSpacing.md;
              if (notes == null && value.hasError) {
                return ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.only(top: AppSpacing.lg),
                  children: [
                    AppErrorState(
                      title: 'Could not load your notes',
                      message: userFacingError(value.error!),
                      onRetry: () =>
                          ref.invalidate(bookNotesProvider(_projectId)),
                    ),
                  ],
                );
              }
              if (notes == null) {
                return ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: EdgeInsets.fromLTRB(side, AppSpacing.sm, side, 0),
                  children: const [BookNotesSkeleton()],
                );
              }
              if (notes.isEmpty) {
                return CustomScrollView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  slivers: [
                    SliverFillRemaining(
                      hasScrollBody: false,
                      child: Center(
                        child: AppEmptyState(
                          key: const ValueKey('book-notes-empty'),
                          icon: bookNotesIcon,
                          title: 'Notes for this book',
                          message:
                              'Keep ideas, research, character details and '
                              'reminders here. Only you can see them. Nothing '
                              'here is printed in your book or sent to the AI.',
                          actionLabel: 'New note',
                          actionIcon: const Icon(Icons.add_rounded),
                          onAction: () => _newNote(notes),
                        ),
                      ),
                    ),
                  ],
                );
              }
              return _list(notes, side);
            },
          ),
        ),
      ),
    );
  }

  Widget _list(List<BookNote> notes, double side) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final query = _search.text.trim();
    final searching = query.isNotEmpty;
    final showSearch = notes.length >= bookNotesSearchThreshold || searching;
    final visible = searchBookNotes(notes, query);
    final groups = groupBookNotes(visible);
    final headed =
        !searching && groups.pinned.isNotEmpty && groups.others.isNotEmpty;
    final now = DateTime.now();

    Widget cards(List<BookNote> group) => SliverPadding(
      padding: EdgeInsets.symmetric(horizontal: side),
      sliver: SliverList.separated(
        itemCount: group.length,
        separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.sm),
        itemBuilder: (context, index) {
          final note = group[index];
          return BookNoteCard(
            key: ValueKey(note.id),
            note: note,
            now: now,
            onOpen: () => _open(note),
            onAction: (action) => unawaited(_onAction(note, action)),
          );
        },
      ),
    );

    Widget header(String label, IconData icon, {double top = AppSpacing.xs}) =>
        SliverPadding(
          padding: EdgeInsets.fromLTRB(side + 2, top, side, AppSpacing.xs),
          sliver: SliverToBoxAdapter(
            child: Semantics(
              header: true,
              child: Row(
                children: [
                  Icon(icon, size: 16, color: colors.onSurfaceVariant),
                  const SizedBox(width: AppSpacing.xs),
                  Text(
                    label,
                    style: theme.textTheme.labelLarge?.copyWith(
                      color: colors.onSurfaceVariant,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );

    return CustomScrollView(
      key: const PageStorageKey('book-notes-scroll'),
      physics: const AlwaysScrollableScrollPhysics(),
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      slivers: [
        if (showSearch)
          SliverPadding(
            padding: EdgeInsets.fromLTRB(side, AppSpacing.sm, side, 0),
            sliver: SliverToBoxAdapter(
              child: TextField(
                key: const ValueKey('book-notes-search'),
                controller: _search,
                onChanged: (_) => setState(() {}),
                textInputAction: TextInputAction.search,
                onSubmitted: (_) => FocusScope.of(context).unfocus(),
                decoration: InputDecoration(
                  hintText: 'Search notes',
                  prefixIcon: const Icon(Icons.search_rounded),
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear search',
                          onPressed: () => setState(_search.clear),
                          icon: const Icon(Icons.close_rounded),
                        ),
                ),
              ),
            ),
          ),
        if (searching)
          SliverPadding(
            padding: EdgeInsets.fromLTRB(side + 2, AppSpacing.sm, side, 0),
            sliver: SliverToBoxAdapter(
              child: Semantics(
                liveRegion: true,
                child: Text(
                  visible.length == 1
                      ? '1 of ${notes.length} notes'
                      : '${visible.length} of ${notes.length} notes',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: AppSpacing.sm)),
        if (visible.isEmpty)
          SliverToBoxAdapter(
            child: AppEmptyState(
              compact: true,
              icon: Icons.search_off_rounded,
              title: 'No matching notes',
              message: 'Try another word, or clear the search.',
              actionLabel: 'Clear search',
              onAction: () => setState(_search.clear),
            ),
          )
        else if (headed) ...[
          header('Pinned', Icons.push_pin_outlined),
          cards(groups.pinned),
          header('Others', bookNotesIcon, top: AppSpacing.lg),
          cards(groups.others),
        ] else
          cards(visible),
        // Room for the floating button over the last card, above the
        // system's own bar.
        SliverToBoxAdapter(
          child: SizedBox(height: 104 + MediaQuery.paddingOf(context).bottom),
        ),
      ],
    );
  }
}
