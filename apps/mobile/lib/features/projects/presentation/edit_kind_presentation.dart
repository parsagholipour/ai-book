import 'package:flutter/material.dart';

import '../domain/project_models.dart';

/// How the book chat names and draws each kind of edit.
///
/// One table for every surface that talks about an edit — the proposal card, the
/// operation card, the change history and the diff screen — so "add pages" is
/// the same icon and the same words wherever the reader meets it.
@immutable
class EditKindStyle {
  const EditKindStyle({required this.icon, required this.label});

  final IconData icon;

  /// A short noun phrase: what sort of change this is, not what it says.
  final String label;
}

/// [structuralAction] is `insert`, `delete` or `move` for a page-structure edit
/// and null for every other kind; it decides which of the three that kind is.
EditKindStyle editKindStyle(String kind, {String? structuralAction}) {
  return switch (kind) {
    'page_rewrite' => const EditKindStyle(
      icon: Icons.auto_fix_high_outlined,
      label: 'Rewrite',
    ),
    'local_patch' => const EditKindStyle(
      icon: Icons.edit_note_outlined,
      label: 'Text fix',
    ),
    'chapter_regenerate' => const EditKindStyle(
      icon: Icons.auto_stories_outlined,
      label: 'Chapter rewrite',
    ),
    'back_matter' => const EditKindStyle(
      icon: Icons.library_books_outlined,
      label: 'Back matter',
    ),
    'chapter_heading' => const EditKindStyle(
      icon: Icons.title,
      label: 'Chapter headings',
    ),
    'page_design' => const EditKindStyle(
      icon: Icons.palette_outlined,
      label: 'Page design',
    ),
    'add_image' => const EditKindStyle(
      icon: Icons.add_photo_alternate_outlined,
      label: 'New picture',
    ),
    'move_image' => const EditKindStyle(
      icon: Icons.open_with,
      label: 'Move picture',
    ),
    'remove_image' => const EditKindStyle(
      icon: Icons.hide_image_outlined,
      label: 'Remove picture',
    ),
    'restructure_pages' => switch (structuralAction) {
      'delete' => const EditKindStyle(
        icon: Icons.playlist_remove,
        label: 'Remove pages',
      ),
      'move' => const EditKindStyle(icon: Icons.swap_vert, label: 'Move pages'),
      'insert' => const EditKindStyle(
        icon: Icons.note_add_outlined,
        label: 'Add pages',
      ),
      // An operation does not say which of the three it was, so it gets the
      // name that is true of all of them rather than the first one's.
      _ => const EditKindStyle(
        icon: Icons.difference_outlined,
        label: 'Page change',
      ),
    },
    'continue_book' => const EditKindStyle(
      icon: Icons.post_add,
      label: 'New chapters',
    ),
    'book_replan' => const EditKindStyle(
      icon: Icons.copy_all_outlined,
      label: 'New copy',
    ),
    'plan_revision' => const EditKindStyle(
      icon: Icons.account_tree_outlined,
      label: 'Plan change',
    ),
    'manual_edit' => const EditKindStyle(
      icon: Icons.edit_outlined,
      label: 'Your edits',
    ),
    _ => const EditKindStyle(icon: Icons.auto_fix_high_outlined, label: 'Edit'),
  };
}

EditKindStyle proposalKindStyle(MobileEditProposal proposal) =>
    editKindStyle(proposal.kind, structuralAction: proposal.structural?.action);

/// The pages an operation touched, as the reader would say them.
///
/// The printed numbers when the server measured them, the model indexes only
/// where there is no page map — the same rule the proposal's own page chip
/// follows, so a card and its result never name different sheets.
List<int> operationPageNumbers(MobileBookEditOperation operation) {
  final shown = operation.readerPageNumbers.isNotEmpty
      ? operation.readerPageNumbers
      : operation.affectedPageIndexes;
  return [...shown]..sort();
}

/// "Page 3", "Pages 3, 5", or "Pages 3, 5 +4 more" for a long list.
String pageChipLabel(List<int> pages, {int maxShown = 4}) {
  if (pages.isEmpty) return '';
  if (pages.length == 1) return 'Page ${pages.first}';
  final shown = pages.take(maxShown).join(', ');
  final rest = pages.length - maxShown;
  return rest > 0 ? 'Pages $shown +$rest more' : 'Pages $shown';
}

/// "Today, 3:42 PM", "Yesterday, 9:05 AM", or the date and time for anything
/// older — in the reader's own locale and clock style.
String describeEditWhen(BuildContext context, DateTime when) {
  final l10n = MaterialLocalizations.of(context);
  final local = when.toLocal();
  final time = l10n.formatTimeOfDay(TimeOfDay.fromDateTime(local));
  return switch (_daysAgo(local)) {
    0 => 'Today, $time',
    1 => 'Yesterday, $time',
    _ => '${l10n.formatMediumDate(local)}, $time',
  };
}

/// The heading a day of edits sits under: Today, Yesterday, or the date.
String describeEditDay(BuildContext context, DateTime when) {
  final local = when.toLocal();
  return switch (_daysAgo(local)) {
    0 => 'Today',
    1 => 'Yesterday',
    _ => MaterialLocalizations.of(context).formatMediumDate(local),
  };
}

int _daysAgo(DateTime local) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  return today.difference(DateTime(local.year, local.month, local.day)).inDays;
}
