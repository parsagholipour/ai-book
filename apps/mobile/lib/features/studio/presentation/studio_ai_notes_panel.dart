import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/assist_models.dart';
import 'studio_ai_controller.dart';

/// Feedback and consistency notes, docked under the page like notes in a
/// margin: one note at a time, stepped through with the arrows. A note that
/// quotes the text finds that passage and selects it — in another chapter,
/// it opens that chapter first. Nothing in the text changes from here.
class StudioNotesPanel extends StatelessWidget {
  const StudioNotesPanel({
    required this.view,
    required this.chapterLabel,
    required this.onSelect,
    required this.onMove,
    required this.onClose,
    super.key,
  });

  final StudioNotesView view;

  /// "Chapter 3 · The Harbour" for a chapter id, or null.
  final String? Function(String? chapterId) chapterLabel;
  final ValueChanged<AssistNote> onSelect;
  final ValueChanged<int> onMove;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final notes = view.notes;
    final title = view.kind == LongAssistKind.consistency
        ? 'Consistency check'
        : 'Chapter feedback';
    return Material(
      key: const ValueKey('studio-notes-panel'),
      color: colors.surfaceContainerLow,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.md,
            AppSpacing.xxs,
            AppSpacing.xxs,
            AppSpacing.sm,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.rate_review_outlined,
                    size: 18,
                    color: colors.primary,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      notes.isEmpty
                          ? title
                          : '$title · ${view.index + 1} of ${notes.length}',
                      key: const ValueKey('studio-notes-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelLarge?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  if (notes.length > 1) ...[
                    IconButton(
                      tooltip: 'Previous note',
                      visualDensity: VisualDensity.compact,
                      onPressed: view.index > 0
                          ? () => onMove(view.index - 1)
                          : null,
                      icon: const Icon(Icons.chevron_left_rounded),
                    ),
                    IconButton(
                      key: const ValueKey('studio-notes-next'),
                      tooltip: 'Next note',
                      visualDensity: VisualDensity.compact,
                      onPressed: view.index < notes.length - 1
                          ? () => onMove(view.index + 1)
                          : null,
                      icon: const Icon(Icons.chevron_right_rounded),
                    ),
                  ],
                  IconButton(
                    key: const ValueKey('studio-notes-close'),
                    tooltip: 'Close notes',
                    visualDensity: VisualDensity.compact,
                    onPressed: onClose,
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsetsDirectional.only(end: AppSpacing.sm),
                child: notes.isEmpty
                    ? Text(
                        view.kind == LongAssistKind.consistency
                            ? 'No contradictions found — names, ages, places '
                                  'and dates agree across your chapters.'
                            : 'Nothing to flag in this chapter.',
                        style: theme.textTheme.bodyMedium,
                      )
                    : ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 150),
                        child: SingleChildScrollView(
                          child: _NoteCard(
                            key: ValueKey('studio-note-${view.index}'),
                            note: view.current,
                            chapter: view.kind == LongAssistKind.consistency
                                ? chapterLabel(view.current.chapterId)
                                : null,
                            onSelect: () => onSelect(view.current),
                          ),
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NoteCard extends StatelessWidget {
  const _NoteCard({
    required this.note,
    required this.chapter,
    required this.onSelect,
    super.key,
  });

  final AssistNote note;
  final String? chapter;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final semantic = AppSemanticColors.of(context);
    final issue = note.isIssue;
    final accent = issue ? semantic.warning : colors.primary;
    final quote = note.quote?.trim();
    final hasQuote = quote != null && quote.isNotEmpty;
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadii.compact),
      onTap: hasQuote ? onSelect : null,
      child: Container(
        padding: const EdgeInsetsDirectional.only(start: AppSpacing.sm),
        decoration: BoxDecoration(
          border: BorderDirectional(start: BorderSide(color: accent, width: 3)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: AppSpacing.xs,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: issue
                        ? semantic.warningContainer
                        : colors.primaryContainer.withValues(alpha: 0.7),
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.xs,
                      vertical: 2,
                    ),
                    child: Text(
                      issue ? 'Issue' : 'Suggestion',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: issue
                            ? semantic.onWarningContainer
                            : colors.onPrimaryContainer,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
                if (chapter != null)
                  Text(
                    chapter!,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
            if (hasQuote) ...[
              const SizedBox(height: AppSpacing.xxs),
              Text(
                '“$quote”',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontStyle: FontStyle.italic,
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.xxs),
            Text(note.note, style: theme.textTheme.bodyMedium),
            if (hasQuote)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xxs),
                child: Text(
                  'Tap to find it in your text',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: colors.primary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
