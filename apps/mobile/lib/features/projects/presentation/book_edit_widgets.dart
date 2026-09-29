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

/// The opening of a page's text, as a quotation the chat can find the page by.
///
/// Edit Mode numbers pages by the book's own index, while the chat's "page 3" is
/// the number printed on the sheet — the two differ in a book with a cover or
/// front matter. A quotation names the page without either number.
String bookEditExcerpt(String markdown, {int maxChars = 90}) {
  final plain = markdown
      .replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), ' ')
      .replaceAll(RegExp(r'[#*_>`~]+'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (plain.length <= maxChars) return plain;
  final cut = plain.substring(0, maxChars);
  final lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars ~/ 2 ? cut.substring(0, lastSpace) : cut).trim();
}

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
      button: true,
      selected: selected,
      label:
          'Page ${page.index}${title.isEmpty ? '' : ', $title'}'
          '${dirty ? ', unsaved changes' : ''}',
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
  const BookEditAskBar({required this.onPick, super.key});

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
                    for (final ask in BookEditAsk.values)
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
  shorter(Icons.compress, 'Shorten it'),
  picture(Icons.add_photo_alternate_outlined, 'Add a picture');

  const BookEditAsk(this.icon, this.label);

  final IconData icon;
  final String label;

  /// The composer text for this request about [excerpt] of the open page.
  String draft(String excerpt) {
    if (excerpt.isEmpty) {
      return switch (this) {
        BookEditAsk.warmer => 'Make this page warmer.',
        BookEditAsk.shorter => 'Shorten this page.',
        BookEditAsk.picture => 'Add a picture to this page.',
      };
    }
    return switch (this) {
      BookEditAsk.warmer => 'Rewrite this passage: "$excerpt". Make it warmer.',
      BookEditAsk.shorter => 'Rewrite this passage: "$excerpt". Shorten it.',
      BookEditAsk.picture => 'Add a picture for this passage: "$excerpt".',
    };
  }
}
