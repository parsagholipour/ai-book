import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../domain/reader_models.dart';

/// The head of one of the reader's sheets: what it is, one line about what is
/// in it, and whatever the reader can do to all of it.
///
/// Every sheet the reader opens — contents, bookmarks, markup, appearance —
/// used to lay out its own title, at its own offset, with its own idea of how
/// much room the drag handle needs. One header means they read as one family
/// and the title never sits a different distance from the top edge.
class ReaderSheetHeader extends StatelessWidget {
  const ReaderSheetHeader({
    required this.title,
    this.subtitle,
    this.actions = const [],
    super.key,
  });

  final String title;

  /// A quiet line under the title — a count, a position.
  final String? subtitle;

  /// Buttons at the far end, in reading order.
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle = this.subtitle;
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.lg - 4,
        AppSpacing.xxs,
        AppSpacing.sm,
        AppSpacing.xs,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    title,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
          ...actions,
        ],
      ),
    );
  }
}

/// How many pages are left after [page], in the numbers the footer prints.
///
/// Null when the book's length is not known yet. "Last page" rather than "0
/// pages left" at the end.
String? readerPagesLeftLabel(
  int page,
  int pageCount, {
  required bool hasCoverPage,
}) {
  if (pageCount < 1) return null;
  final total = printedPageCount(pageCount, hasCoverPage: hasCoverPage);
  final printed = printedPageForPdfPage(page, hasCoverPage: hasCoverPage) ?? 0;
  final left = total - printed;
  if (left <= 0) return 'Last page';
  return left == 1 ? '1 page left' : '$left pages left';
}
