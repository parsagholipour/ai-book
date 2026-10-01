import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../../../shared/ui/motion.dart';
import '../../projects/presentation/chat_history_time.dart';
import '../domain/book_note.dart';
import 'notes_common.dart';

/// What a note's menu offers.
enum BookNoteMenuAction { pin, delete }

/// Opens a note's menu at [position] (global): Pin or Unpin, and Delete.
Future<BookNoteMenuAction?> showBookNoteMenu(
  BuildContext context, {
  required BookNote note,
  required Offset position,
}) {
  final overlay = Overlay.of(context).context.findRenderObject()! as RenderBox;
  return showMenu<BookNoteMenuAction>(
    context: context,
    position: RelativeRect.fromRect(
      Rect.fromPoints(position, position),
      Offset.zero & overlay.size,
    ),
    items: [
      PopupMenuItem(
        value: BookNoteMenuAction.pin,
        child: NotesMenuRow(
          icon: note.pinned ? Icons.push_pin : Icons.push_pin_outlined,
          label: note.pinned ? 'Unpin' : 'Pin to top',
        ),
      ),
      const PopupMenuItem(
        value: BookNoteMenuAction.delete,
        child: NotesMenuRow(
          icon: Icons.delete_outline,
          label: 'Delete',
          destructive: true,
        ),
      ),
    ],
  );
}

/// One note in a book's list: its title (or first line), a few lines of the
/// rest, when it was last changed, and whether it is pinned.
///
/// The card opens the note; holding it, or its menu button, offers Pin and
/// Delete — which a screen reader also finds as the card's own actions.
class BookNoteCard extends StatefulWidget {
  const BookNoteCard({
    required this.note,
    required this.now,
    required this.onOpen,
    required this.onAction,
    super.key,
  });

  final BookNote note;
  final DateTime now;
  final VoidCallback onOpen;

  /// A menu choice, or the same action from a screen reader.
  final ValueChanged<BookNoteMenuAction> onAction;

  @override
  State<BookNoteCard> createState() => _BookNoteCardState();
}

class _BookNoteCardState extends State<BookNoteCard> {
  Offset? _pressedAt;

  Future<void> _openMenu(Offset position) async {
    final action = await showBookNoteMenu(
      context,
      note: widget.note,
      position: position,
    );
    if (action != null) widget.onAction(action);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final note = widget.note;
    final title = note.displayTitle;
    final untitled = title == untitledBookNote;
    final preview = note.preview;
    final edited = relativeChatTime(
      note.editedAt,
      now: widget.now,
      localizations: MaterialLocalizations.of(context),
    );
    final label = noteSemanticsLabel([
      if (note.pinned) 'Pinned',
      title,
      if (preview.isNotEmpty) preview,
      'Edited $edited',
    ]);

    void openMenu() {
      AppHaptics.longPress();
      final box = context.findRenderObject()! as RenderBox;
      _openMenu(_pressedAt ?? box.localToGlobal(box.size.center(Offset.zero)));
    }

    final content = Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.md,
        AppSpacing.md - 2,
        0,
        AppSpacing.md - 2,
      ),
      // The words run the way the note is written — a Persian note reads
      // from the right in an English app — and the card's own chrome (the
      // padding, the menu) stays the app's.
      child: Directionality(
        textDirection:
            noteTextDirection('${note.title}\n${note.body}') ??
            Directionality.of(context),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w700,
                height: 1.25,
                color: untitled ? colors.onSurfaceVariant : null,
              ),
            ),
            if (preview.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.xxs),
              Text(
                preview,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                  height: 1.4,
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.xs),
            Row(
              children: [
                if (note.pinned) ...[
                  Icon(Icons.push_pin, size: 14, color: colors.primary),
                  const SizedBox(width: AppSpacing.xxs),
                ],
                Flexible(
                  child: Text(
                    edited,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: colors.onSurfaceVariant,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );

    return AppPressScale(
      child: Card(
        margin: EdgeInsets.zero,
        clipBehavior: Clip.antiAlias,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              // The card opens the note; the menu button beside it is its own
              // target, so it is not folded into the note's description.
              child: Semantics(
                container: true,
                button: true,
                label: label,
                onTap: widget.onOpen,
                onLongPress: openMenu,
                customSemanticsActions: {
                  CustomSemanticsAction(
                    label: note.pinned ? 'Unpin' : 'Pin to top',
                  ): () =>
                      widget.onAction(BookNoteMenuAction.pin),
                  const CustomSemanticsAction(label: 'Delete'): () =>
                      widget.onAction(BookNoteMenuAction.delete),
                },
                child: ExcludeSemantics(
                  child: InkWell(
                    key: ValueKey('book-note-${note.id}'),
                    onTap: widget.onOpen,
                    onTapDown: (details) => _pressedAt = details.globalPosition,
                    onLongPress: openMenu,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        minHeight: AppSizes.minimumTouchTarget + 24,
                      ),
                      child: content,
                    ),
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xxs),
              child: Builder(
                builder: (buttonContext) => IconButton(
                  key: ValueKey('book-note-menu-${note.id}'),
                  tooltip: 'Options for $title',
                  icon: const Icon(Icons.more_vert),
                  color: colors.onSurfaceVariant,
                  onPressed: () {
                    final box = buttonContext.findRenderObject()! as RenderBox;
                    _openMenu(box.localToGlobal(Offset(0, box.size.height)));
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The list's placeholder: note-shaped cards under one shimmer.
class BookNotesSkeleton extends StatelessWidget {
  const BookNotesSkeleton({this.count = 4, super.key});

  final int count;

  @override
  Widget build(BuildContext context) {
    return AppSkeletonGroup(
      label: 'Loading notes',
      child: Column(
        children: [
          for (var i = 0; i < count; i++) ...[
            if (i > 0) const SizedBox(height: AppSpacing.sm),
            Card(
              margin: EdgeInsets.zero,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.md),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppSkeleton.line(
                      widthFactor: const [0.55, 0.4, 0.62, 0.48][i % 4],
                      height: 16,
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    const AppSkeleton.line(widthFactor: 0.92),
                    const SizedBox(height: AppSpacing.xs),
                    AppSkeleton.line(
                      widthFactor: const [0.7, 0.5, 0.78, 0.6][i % 4],
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    const AppSkeleton.line(width: 56, height: 10),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
