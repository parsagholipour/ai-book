import 'package:flutter/material.dart';

import '../domain/reader_annotation.dart';
import 'reader_annotation_painter.dart';

/// Everything the reader has marked in a book, in page order.
///
/// Markup that is only ever visible on the page it sits on is markup nobody can
/// find again. This is the index: it turns a hundred highlights scattered
/// through a book back into a list you can read down, jump from, and send to
/// someone else.
class ReaderAnnotationsSheet extends StatelessWidget {
  const ReaderAnnotationsSheet({
    required this.annotations,
    required this.palette,
    required this.onSelect,
    required this.onRemove,
    required this.onShareAll,
    required this.canUndo,
    required this.onUndo,
    super.key,
  });

  final List<ReaderAnnotation> annotations;
  final List<ReaderMarkupColor> palette;
  final void Function(ReaderAnnotation annotation) onSelect;
  final void Function(ReaderAnnotation annotation) onRemove;
  final VoidCallback onShareAll;

  /// Undo lives in the sheet rather than in a snackbar: the sheet is modal, so
  /// anything shown behind it by the scaffold cannot be reached — and deleting
  /// the wrong note from a long list is exactly when undo matters.
  final bool canUndo;
  final VoidCallback onUndo;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final placed = annotations.where((entry) => !entry.orphaned).toList()
      ..sort(_byPage);
    final loose = annotations.where((entry) => entry.orphaned).toList()
      ..sort(_byPage);

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 12, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'My markup',
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                if (canUndo)
                  IconButton(
                    onPressed: onUndo,
                    icon: const Icon(Icons.undo),
                    tooltip: 'Undo',
                  ),
                if (annotations.isNotEmpty)
                  TextButton.icon(
                    onPressed: onShareAll,
                    icon: const Icon(Icons.ios_share_outlined, size: 18),
                    label: const Text('Share'),
                  ),
              ],
            ),
          ),
          if (annotations.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
              child: Text(
                'Select a passage to highlight it, or open the markup tools to '
                'draw and pin notes.',
                style: theme.textTheme.bodyMedium,
              ),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final annotation in placed)
                    _AnnotationTile(
                      annotation: annotation,
                      palette: palette,
                      onSelect: onSelect,
                      onRemove: onRemove,
                    ),
                  if (loose.isNotEmpty) ...[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 20, 20, 4),
                      child: Text(
                        'From an earlier version',
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                      child: Text(
                        'These passages were rewritten, so the markup no '
                        'longer has a place on the page.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    for (final annotation in loose)
                      _AnnotationTile(
                        annotation: annotation,
                        palette: palette,
                        onSelect: onSelect,
                        onRemove: onRemove,
                      ),
                  ],
                  const SizedBox(height: 12),
                ],
              ),
            ),
        ],
      ),
    );
  }

  static int _byPage(ReaderAnnotation a, ReaderAnnotation b) {
    final byPage = a.page.compareTo(b.page);
    return byPage != 0 ? byPage : a.createdAt.compareTo(b.createdAt);
  }
}

class _AnnotationTile extends StatelessWidget {
  const _AnnotationTile({
    required this.annotation,
    required this.palette,
    required this.onSelect,
    required this.onRemove,
  });

  final ReaderAnnotation annotation;
  final List<ReaderMarkupColor> palette;
  final void Function(ReaderAnnotation annotation) onSelect;
  final void Function(ReaderAnnotation annotation) onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = readerMarkupColor(palette, annotation.colorIndex).color;
    final body = annotation.body?.trim() ?? '';
    final quote = annotation.quote?.trim() ?? '';
    // The note is what the reader wrote, so it leads; the passage it was
    // written about is the supporting line.
    final subtitle = body.isNotEmpty && quote.isNotEmpty ? quote : null;

    return ListTile(
      leading: Container(
        width: 10,
        height: 34,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(5),
        ),
      ),
      title: Text(
        annotation.preview,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        subtitle == null
            ? 'Page ${annotation.page}'
            : 'Page ${annotation.page} · $subtitle',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      trailing: IconButton(
        icon: const Icon(Icons.close),
        tooltip: 'Delete',
        onPressed: () => onRemove(annotation),
      ),
      onTap: annotation.orphaned ? null : () => onSelect(annotation),
    );
  }
}

/// Composes the reader's markup as plain text, for sharing.
///
/// Grouped by page and quoted, so what arrives in a message reads like notes
/// someone took rather than a dump of a data structure. Ink is listed but has
/// nothing to say for itself — the point is that the page is not forgotten.
String readerMarkupShareText({
  required String bookTitle,
  required List<ReaderAnnotation> annotations,
}) {
  final sorted = [...annotations]..sort((a, b) {
    final byPage = a.page.compareTo(b.page);
    return byPage != 0 ? byPage : a.createdAt.compareTo(b.createdAt);
  });

  final buffer = StringBuffer()
    ..writeln(bookTitle.isEmpty ? 'My notes' : '$bookTitle — my notes');
  int? currentPage;

  for (final annotation in sorted) {
    if (annotation.page != currentPage) {
      currentPage = annotation.page;
      buffer
        ..writeln()
        ..writeln('Page $currentPage');
    }
    final quote = annotation.quote?.trim() ?? '';
    final body = annotation.body?.trim() ?? '';
    if (quote.isNotEmpty) {
      buffer.writeln('  "$quote"');
    }
    if (body.isNotEmpty) {
      buffer.writeln('  — $body');
    }
    if (quote.isEmpty && body.isEmpty) {
      buffer.writeln('  (${annotation.preview})');
    }
  }

  return buffer.toString().trimRight();
}
