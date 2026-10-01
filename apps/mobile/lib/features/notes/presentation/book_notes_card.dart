import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/chat_history_time.dart';
import '../data/book_notes_repository.dart';
import '../domain/book_note.dart';
import 'notes_common.dart';
import 'notes_location.dart';

/// The book page's door to its notes: how many there are and the last one or
/// two written in, or — before the first — one line saying what they are for.
///
/// It sits under whatever the book is doing and stays quiet about it: no
/// filled button, nothing that competes with Read or Continue writing.
class BookNotesCard extends ConsumerWidget {
  const BookNotesCard({required this.projectId, super.key});

  final String projectId;

  void _openList(BuildContext context) {
    AppHaptics.tap();
    unawaited(context.push(bookNotesLocation(projectId)));
  }

  void _openNote(BuildContext context, BookNote note) {
    AppHaptics.tap();
    unawaited(context.push(bookNoteLocation(projectId, note.id)));
  }

  void _newNote(BuildContext context) {
    AppHaptics.tap();
    unawaited(context.push(newBookNoteLocation(projectId)));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(bookNotesProvider(projectId));
    final notes = value.value;
    final Widget content;
    if (notes != null && notes.isEmpty) {
      content = _Invitation(onAdd: () => _newNote(context));
    } else {
      // Still loading, or failed: the heading alone, which opens the list
      // (and its Try again). No shimmer — a quiet card that settles as soon
      // as the notes land is less than a placeholder asking to be watched.
      final recent = notes == null
          ? const <BookNote>[]
          : recentBookNotes(notes);
      content = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Header(
            count: notes?.length,
            onOpen: () => _openList(context),
            onAdd: notes == null ? null : () => _newNote(context),
          ),
          for (final note in recent)
            _RecentNote(note: note, onTap: () => _openNote(context, note)),
          if (recent.isNotEmpty) const SizedBox(height: AppSpacing.xxs),
        ],
      );
    }
    return AppCard(
      key: const ValueKey('book-notes-card'),
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.xs,
        AppSpacing.xxs,
        AppSpacing.xxs,
        AppSpacing.xxs,
      ),
      child: AppSwitcher(child: content),
    );
  }
}

/// "Notes · 3", which opens the list, and a quiet way to add one.
class _Header extends StatelessWidget {
  const _Header({required this.count, required this.onOpen, this.onAdd});

  /// Null while the notes are loading or could not be loaded.
  final int? count;
  final VoidCallback onOpen;
  final VoidCallback? onAdd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final count = this.count;
    final label = count == null
        ? 'Notes. Open your notes'
        : 'Notes, $count ${count == 1 ? 'note' : 'notes'}. Open your notes';
    return Row(
      children: [
        Expanded(
          child: Semantics(
            container: true,
            button: true,
            label: label,
            onTap: onOpen,
            child: ExcludeSemantics(
              child: InkWell(
                key: const ValueKey('book-notes-open'),
                onTap: onOpen,
                borderRadius: BorderRadius.circular(AppRadii.compact),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    minHeight: AppSizes.minimumTouchTarget,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.xs,
                    ),
                    child: Row(
                      children: [
                        Icon(bookNotesIcon, size: 20, color: colors.primary),
                        const SizedBox(width: AppSpacing.sm),
                        Flexible(
                          child: Text.rich(
                            TextSpan(
                              text: 'Notes',
                              children: [
                                if (count != null)
                                  TextSpan(
                                    text: ' · $count',
                                    style: TextStyle(
                                      color: colors.onSurfaceVariant,
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                              ],
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.xxs),
                        Icon(
                          Icons.chevron_right,
                          size: 20,
                          color: colors.onSurfaceVariant,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (onAdd != null)
          IconButton(
            key: const ValueKey('book-notes-add'),
            tooltip: 'New note',
            onPressed: onAdd,
            color: colors.onSurfaceVariant,
            icon: const Icon(Icons.add_rounded),
          ),
      ],
    );
  }
}

/// One of the last notes written in: its title and when.
class _RecentNote extends StatelessWidget {
  const _RecentNote({required this.note, required this.onTap});

  final BookNote note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final title = note.displayTitle;
    final edited = relativeChatTime(
      note.editedAt,
      now: DateTime.now(),
      localizations: MaterialLocalizations.of(context),
    );
    return Semantics(
      container: true,
      button: true,
      label: noteSemanticsLabel([title, 'Edited $edited']),
      onTap: onTap,
      child: ExcludeSemantics(
        child: InkWell(
          key: ValueKey('book-notes-recent-${note.id}'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.compact),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: AppSizes.minimumTouchTarget,
            ),
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.xs + 20 + AppSpacing.sm,
                AppSpacing.xxs,
                AppSpacing.sm,
                AppSpacing.xxs,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textDirection: noteTextDirection(title),
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Text(
                    edited,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: colors.onSurfaceVariant,
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

/// No notes yet: what they are for, and one quiet way to start.
///
/// The action sits in the header row, where the list's "Notes · 3" will be,
/// so the card keeps its shape when the first note arrives and the sentence
/// beneath gets the whole width.
class _Invitation extends StatelessWidget {
  const _Invitation({required this.onAdd});

  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: AppSizes.minimumTouchTarget,
          ),
          child: Row(
            children: [
              const SizedBox(width: AppSpacing.xs),
              Icon(bookNotesIcon, size: 20, color: colors.primary),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    'Notes',
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
              AppButton.text(
                key: const ValueKey('book-notes-invite'),
                label: 'Add a note',
                leading: const Icon(Icons.add_rounded),
                onPressed: onAdd,
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(
            AppSpacing.xs + 20 + AppSpacing.sm,
            0,
            AppSpacing.sm,
            AppSpacing.sm,
          ),
          child: Text(
            'Ideas, research, reminders — just for you.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
              height: 1.35,
            ),
          ),
        ),
      ],
    );
  }
}
