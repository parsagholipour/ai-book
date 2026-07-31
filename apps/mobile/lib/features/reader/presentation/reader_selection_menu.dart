import 'package:flutter/material.dart';

import '../domain/reader_models.dart';
import 'reader_selection_actions.dart';

/// The bar shown over a selected passage.
///
/// Only the book actions. Asking a book to explain or rewrite a passage is the
/// reason this app exists, so those four sit right where the passage is, in
/// equal columns with their names on, never behind another tap.
///
/// Marking up used to share this bar and now lives in `ReaderMarkupBar` at the
/// top of the screen. That is what lets this stay four actions tall instead of
/// nine controls tall — a bar that covers the paragraph it is about to rewrite
/// is a bar the reader has to move before they can read what they selected.
///
/// Nothing scrolls and nothing is behind an edge. Two earlier arrangements
/// failed exactly there: seven icons in a 320-pixel horizontal scroller
/// silently hid Replace, Edit page and Share past the right-hand side, and
/// folding those behind a single "Ask or edit" row put the app's whole purpose
/// one tap further away than the highlighter.
///
/// The book page a passage resolved to is deliberately not shown. It is our
/// bookkeeping, not the reader's: they are looking at a rendered PDF page and
/// `Page.index` is a different number for the same place, so displaying it
/// invites a correction to something that was almost certainly already right.
/// The message an edit sends carries the quoted excerpt as well as the page, so
/// the server can find the passage even when the page is off — which is what
/// makes trusting the match the honest default rather than the hopeful one.
class ReaderSelectionMenu extends StatelessWidget {
  const ReaderSelectionMenu({
    required this.selection,
    required this.editingEnabled,
    required this.onAction,
    super.key,
  });

  final ReaderSelection selection;

  /// False while the book is generating or has an open edit operation, which
  /// the server would reject anyway.
  final bool editingEnabled;

  final void Function(ReaderSelectionAction action) onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      elevation: 4,
      borderRadius: BorderRadius.circular(14),
      clipBehavior: Clip.antiAlias,
      color: theme.colorScheme.surfaceContainerHigh,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _bookActions(context),
          // The only thing worth a second row: three of the four actions have
          // just greyed out and nothing else on screen says why.
          if (!editingEnabled) _busyNotice(context),
        ],
      ),
    );
  }

  /// The four things that reach the book. Equal columns, so none of them is
  /// the afterthought.
  Widget _bookActions(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _BookAction(
            icon: Icons.chat_bubble_outline,
            label: 'Ask',
            onTap: () => onAction(ReaderSelectionAction.ask),
          ),
        ),
        Expanded(
          child: _BookAction(
            icon: Icons.auto_fix_high_outlined,
            label: 'Rewrite',
            enabled: editingEnabled,
            onTap: () => onAction(ReaderSelectionAction.rewrite),
          ),
        ),
        Expanded(
          child: _BookAction(
            icon: Icons.find_replace_outlined,
            label: 'Replace',
            enabled: editingEnabled,
            onTap: () => onAction(ReaderSelectionAction.replace),
          ),
        ),
        Expanded(
          child: _BookAction(
            icon: Icons.edit_outlined,
            label: 'Edit page',
            enabled: editingEnabled,
            onTap: () => onAction(ReaderSelectionAction.editPage),
          ),
        ),
      ],
    );
  }

  Widget _busyNotice(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      child: Text(
        'The book is busy — editing paused',
        textAlign: TextAlign.center,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _BookAction extends StatelessWidget {
  const _BookAction({
    required this.icon,
    required this.label,
    required this.onTap,
    this.enabled = true,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = enabled
        ? theme.colorScheme.onSurface
        : theme.colorScheme.onSurface.withValues(alpha: 0.38);
    return Semantics(
      button: true,
      enabled: enabled,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 9),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 21, color: color),
              const SizedBox(height: 3),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: theme.textTheme.labelSmall?.copyWith(color: color),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
