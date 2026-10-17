import 'package:flutter/material.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/haptics.dart';
import '../domain/project_models.dart';

// The pieces of Edit Mode around the text fields: the strip that picks a page,
// and the bar that offers to hand the page to the chat instead.

/// The width one page takes in the strip, gap included. Fixed so the strip can
/// open scrolled to the page being edited without building the ones before it.
const double bookEditStripItemExtent = 124;

/// Where the strip should start so that page [index] is in view.
double bookEditStripOffsetFor(int index) =>
    (index * bookEditStripItemExtent - bookEditStripItemExtent).clamp(
      0,
      double.infinity,
    );

/// A page's words, for the count under the editor.
int bookEditWordCount(String text) =>
    text.trim().isEmpty ? 0 : text.trim().split(RegExp(r'\s+')).length;

/// A horizontally scrolling strip of the book's pages: number, title and a dot
/// on any page with unsaved edits.
class BookEditPageStrip extends StatelessWidget {
  const BookEditPageStrip({
    required this.pages,
    required this.selectedId,
    required this.dirtyIds,
    required this.controller,
    required this.onSelect,
    super.key,
  });

  final List<MobileEditableBookPage> pages;
  final String selectedId;
  final Set<String> dirtyIds;
  final ScrollController controller;
  final ValueChanged<MobileEditableBookPage> onSelect;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 72,
      child: ListView.builder(
        controller: controller,
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.sm,
          vertical: AppSpacing.xs,
        ),
        itemExtent: bookEditStripItemExtent,
        itemCount: pages.length,
        itemBuilder: (context, index) {
          final page = pages[index];
          return Padding(
            padding: const EdgeInsetsDirectional.only(end: AppSpacing.xs),
            child: _StripItem(
              page: page,
              selected: page.id == selectedId,
              dirty: dirtyIds.contains(page.id),
              onTap: () {
                AppHaptics.selection();
                onSelect(page);
              },
            ),
          );
        },
      ),
    );
  }
}

class _StripItem extends StatelessWidget {
  const _StripItem({
    required this.page,
    required this.selected,
    required this.dirty,
    required this.onTap,
  });

  final MobileEditableBookPage page;
  final bool selected;
  final bool dirty;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final title = page.title.trim();
    return Semantics(
      container: true,
      button: true,
      selected: selected,
      label:
          'Page ${page.index}${title.isEmpty ? '' : ', $title'}'
          '${dirty ? ', unsaved changes' : ''}',
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: selected
              ? colors.primaryContainer
              : colors.surfaceContainerLow,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadii.control),
            side: BorderSide(
              color: selected
                  ? colors.primary.withValues(alpha: 0.6)
                  : colors.outlineVariant,
              width: selected ? 1.4 : 1,
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.sm,
                vertical: AppSpacing.xs,
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Page ${page.index}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelLarge?.copyWith(
                            fontWeight: FontWeight.w800,
                            color: selected
                                ? colors.onPrimaryContainer
                                : colors.onSurface,
                          ),
                        ),
                      ),
                      if (dirty)
                        Icon(Icons.circle, size: 9, color: colors.primary),
                    ],
                  ),
                  if (title.isNotEmpty)
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: selected
                            ? colors.onPrimaryContainer
                            : colors.onSurfaceVariant,
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

/// What the chat can do with the page that is open, as chips that fill the chat
/// composer. Nothing is sent: the reader reviews the message there, and any
/// edit it leads to shows its price and waits for Apply like every other.
class BookEditAskBar extends StatelessWidget {
  const BookEditAskBar({
    required this.project,
    required this.onPick,
    super.key,
  });

  final MobileProjectSummary? project;

  /// Called with the kind of request picked.
  final ValueChanged<BookEditAsk> onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    return Material(
      color: colors.surface,
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.outlineVariant)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.md,
              AppSpacing.xs,
              AppSpacing.md,
              AppSpacing.xs,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Or ask Tomeza to change this page',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: AppSpacing.xxs),
                Wrap(
                  spacing: AppSpacing.xs,
                  children: [
                    for (final ask in BookEditAsk.forBook(project))
                      ActionChip(
                        avatar: Icon(ask.icon, size: 18),
                        label: Text(ask.label),
                        onPressed: () => onPick(ask),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The requests Edit Mode offers to pass to the chat.
enum BookEditAsk {
  warmer(Icons.favorite_border, 'Make it warmer'),
  simpler(Icons.lightbulb_outline, 'Simplify it'),
  shorter(Icons.compress, 'Shorten it'),
  picture(Icons.add_photo_alternate_outlined, 'Add a picture');

  const BookEditAsk(this.icon, this.label);

  final IconData icon;
  final String label;

  /// Use the category generation chose, including for Auto books. Only a
  /// known story gets a tone suggestion; missing metadata stays generic.
  static List<BookEditAsk> forBook(MobileProjectSummary? project) {
    final story = switch (project?.bookShape) {
      'story' || 'children_story' => true,
      'book' =>
        project?.bookType == 'short_story' ||
            project?.bookTypeChoice == 'children_story',
      _ => false,
    };
    return [story ? warmer : simpler, shorter, picture];
  }

  /// Quotes the whole page, or only the highlighted text when [isSelection].
  /// Edit Mode and the chat number pages differently when there is front
  /// matter, so the quotation identifies the page without a page number.
  String draft(String text, {bool isSelection = false}) {
    if (text.isEmpty) {
      return switch (this) {
        BookEditAsk.warmer => 'Make this page warmer.',
        BookEditAsk.simpler => 'Simplify this page while keeping the meaning.',
        BookEditAsk.shorter => 'Shorten this page.',
        BookEditAsk.picture => 'Add a picture to this page.',
      };
    }
    final scope = isSelection ? 'passage' : 'page';
    return switch (this) {
      BookEditAsk.warmer => 'Rewrite this $scope: "$text". Make it warmer.',
      BookEditAsk.simpler =>
        'Rewrite this $scope: "$text". Simplify it while keeping the meaning.',
      BookEditAsk.shorter => 'Rewrite this $scope: "$text". Shorten it.',
      BookEditAsk.picture => 'Add a picture for this $scope: "$text".',
    };
  }
}

/// The quality notes behind a "Review" that sent the reader here.
///
/// The book page lists the review notes and opens Edit Mode at the first
/// flagged page, and Edit Mode used to show that page with nothing about why
/// it was opened. The page's own notes show open; notes about the whole book
/// (no page named) show folded, and only on a page with none of its own.
class BookEditReviewNotes extends StatefulWidget {
  const BookEditReviewNotes({
    required this.pageNotes,
    required this.bookNotes,
    super.key,
  });

  final List<MobileProjectQualityIssue> pageNotes;
  final List<MobileProjectQualityIssue> bookNotes;

  /// The notes for [pageIndex] out of [quality], split by scope.
  static ({
    List<MobileProjectQualityIssue> page,
    List<MobileProjectQualityIssue> book,
  })
  notesFor(MobileProjectQuality? quality, int pageIndex) {
    if (quality == null || !(quality.recommendsReview || quality.isBlocked)) {
      return (page: const [], book: const []);
    }
    return (
      page: [
        for (final issue in quality.issues)
          if (issue.affectedPageIndexes.contains(pageIndex)) issue,
      ],
      book: [
        for (final issue in quality.issues)
          if (issue.affectedPageIndexes.isEmpty) issue,
      ],
    );
  }

  @override
  State<BookEditReviewNotes> createState() => _BookEditReviewNotesState();
}

class _BookEditReviewNotesState extends State<BookEditReviewNotes> {
  late bool _open = widget.pageNotes.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final onPage = widget.pageNotes.isNotEmpty;
    final notes = onPage ? widget.pageNotes : widget.bookNotes;
    if (notes.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final count = notes.length == 1
        ? '1 review note'
        : '${notes.length} review notes';
    final title = onPage ? '$count on this page' : '$count on the whole book';
    void toggle() {
      AppHaptics.selection();
      setState(() => _open = !_open);
    }

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            container: true,
            button: true,
            expanded: _open,
            label: title,
            onTap: toggle,
            child: ExcludeSemantics(
              child: InkWell(
                onTap: toggle,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(
                    minHeight: AppSizes.minimumTouchTarget,
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.sm,
                    ),
                    child: Row(
                      children: [
                        Icon(
                          Icons.rate_review_outlined,
                          size: 20,
                          color: colors.onSurfaceVariant,
                        ),
                        const SizedBox(width: AppSpacing.xs),
                        Expanded(
                          child: Text(
                            title,
                            style: theme.textTheme.labelLarge?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                        Icon(
                          _open ? Icons.expand_less : Icons.expand_more,
                          color: colors.onSurfaceVariant,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (_open)
            // Bounded: the page text below is what the reader came to edit.
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 168),
              child: ListView.separated(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.sm,
                  0,
                  AppSpacing.sm,
                  AppSpacing.sm,
                ),
                itemCount: notes.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.xs),
                itemBuilder: (context, index) {
                  final note = notes[index];
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(note.message, style: theme.textTheme.bodyMedium),
                      if (note.guidance.trim().isNotEmpty)
                        Text(
                          note.guidance,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
