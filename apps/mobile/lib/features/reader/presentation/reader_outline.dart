import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:pdfrx/pdfrx.dart';

import '../../../shared/ui/app_components.dart';
import '../../../shared/ui/feedback/app_feedback.dart';
import '../domain/reader_models.dart';
import 'reader_sheet_parts.dart';

/// Builds the reader's table of contents from a document's PDF bookmarks.
///
/// Books compiled before outline generation was switched on have no bookmark
/// tree. For those, [readerOutlineFromLinks] recovers the same information from
/// the Contents page, whose entries the renderer turns into internal links.
Future<List<ReaderOutlineEntry>> readerOutlineFromDocument(
  PdfDocument document,
) async {
  final nodes = await document.loadOutline();
  final entries = <ReaderOutlineEntry>[];
  void walk(List<PdfOutlineNode> nodes, int depth) {
    for (final node in nodes) {
      final title = node.title.trim();
      if (title.isNotEmpty) {
        entries.add(
          ReaderOutlineEntry(
            title: title,
            depth: depth,
            pageNumber: node.dest?.pageNumber,
          ),
        );
      }
      walk(node.children, depth + 1);
    }
  }

  walk(nodes, 0);
  return entries;
}

/// Names the recovered destinations using the book's own chapter titles.
///
/// The link fallback can find where each chapter starts but not what it is
/// called, which leaves a table of contents reading "Page 3, Page 5". The plan
/// lists the chapters in the same order the Contents page does, so pairing them
/// restores the titles. A count mismatch means the two lists are not the same
/// sequence, and the page numbers are left to speak for themselves.
List<ReaderOutlineEntry> namedReaderOutline(
  List<ReaderOutlineEntry> entries,
  List<String> chapterTitles,
) {
  if (entries.isEmpty || entries.length != chapterTitles.length) {
    return entries;
  }
  return [
    for (var index = 0; index < entries.length; index++)
      ReaderOutlineEntry(
        title: chapterTitles[index],
        depth: entries[index].depth,
        pageNumber: entries[index].pageNumber,
      ),
  ];
}

/// The chapter heading at or before [page], or null when the outline cannot say.
///
/// Only depth-0 entries count. The compiler turns chapter *and* page headings
/// into bookmarks, so a flat scan would report the last sub-heading crossed
/// rather than the chapter the reader is in.
ReaderOutlineEntry? outlineEntryForPage(
  List<ReaderOutlineEntry> entries,
  int page,
) {
  ReaderOutlineEntry? current;
  for (final entry in entries) {
    final entryPage = entry.pageNumber;
    if (entry.depth != 0 || entryPage == null || entryPage > page) {
      continue;
    }
    // The outline is authored in reading order, but a recovered one is only
    // sorted by page — take the latest heading rather than the last listed.
    if (current == null || entryPage >= current.pageNumber!) {
      current = entry;
    }
  }
  return current;
}

/// Recovers a table of contents from the compiled Contents page.
///
/// The Contents section links each chapter to its anchor, and those become PDF
/// link annotations with a page destination. Scanning the first few pages finds
/// them without needing to know which page the Contents landed on.
Future<List<ReaderOutlineEntry>> readerOutlineFromLinks(
  PdfDocument document, {
  int scanPages = 4,
}) async {
  final limit = document.pages.length < scanPages
      ? document.pages.length
      : scanPages;
  for (var index = 0; index < limit; index++) {
    final links = await document.pages[index].loadLinks();
    final destinations = links
        .where((link) => link.dest != null)
        .map((link) => link.dest!.pageNumber)
        .toSet();
    // One or two stray links are a cover credit or a footnote; a real Contents
    // page points at many different places in the book.
    if (destinations.length < 2) {
      continue;
    }
    final entries = <ReaderOutlineEntry>[];
    final seen = <int>{};
    for (final link in links) {
      final page = link.dest?.pageNumber;
      if (page == null || !seen.add(page)) {
        continue;
      }
      entries.add(
        ReaderOutlineEntry(
          // Physical `Page $page` — displayedTitle converts at display time.
          title: 'Page $page',
          depth: 0,
          pageNumber: page,
        ),
      );
    }
    entries.sort((a, b) => (a.pageNumber ?? 0).compareTo(b.pageNumber ?? 0));
    return entries;
  }
  return const [];
}

/// The table of contents sheet.
///
/// Opens on the chapter the reader is in — highlighted, and scrolled to — rather
/// than at the top of a list that may be forty entries long. A book with no
/// outline still gets a sheet worth opening: a way to go to a page by its
/// number, which is the one thing every book has.
class ReaderOutlineSheet extends StatefulWidget {
  const ReaderOutlineSheet({
    required this.entries,
    required this.currentPage,
    required this.onSelect,
    this.hasCoverPage = false,
    this.pageCount = 0,
    super.key,
  });

  final List<ReaderOutlineEntry> entries;
  final int currentPage;
  final void Function(int pageNumber) onSelect;

  /// Whether PDF sheet 1 is an unnumbered cover. Trailing numbers skip it;
  /// [onSelect] still receives the physical destination.
  final bool hasCoverPage;

  /// How many physical pages the open file has, or 0 before that is known. The
  /// page jump and the "pages left" line are only offered once it is.
  final int pageCount;

  @override
  State<ReaderOutlineSheet> createState() => _ReaderOutlineSheetState();
}

class _ReaderOutlineSheetState extends State<ReaderOutlineSheet> {
  final _currentKey = GlobalKey();
  late final ScrollController _scroll;
  late final int _currentIndex = readerOutlineCurrentIndex(
    widget.entries,
    widget.currentPage,
  );

  /// Roughly how tall a row is, for landing near the current one before the
  /// rows above it have been measured. `ensureVisible` does the exact part.
  static double _estimatedExtent(ReaderOutlineEntry entry) =>
      entry.depth == 0 ? 56 : 44;

  @override
  void initState() {
    super.initState();
    var offset = 0.0;
    for (var i = 0; i < _currentIndex; i++) {
      offset += _estimatedExtent(widget.entries[i]);
    }
    _scroll = ScrollController(
      initialScrollOffset: (offset - 96).clamp(0, offset),
    );
    if (_currentIndex >= 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final context = _currentKey.currentContext;
        if (context == null || !mounted) return;
        Scrollable.ensureVisible(context, alignment: 0.3);
      });
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  String? get _subtitle {
    if (widget.pageCount < 1) return null;
    final position = printedPagePositionLabel(
      widget.currentPage.clamp(1, widget.pageCount),
      widget.pageCount,
      hasCoverPage: widget.hasCoverPage,
    );
    final left = readerPagesLeftLabel(
      widget.currentPage.clamp(1, widget.pageCount),
      widget.pageCount,
      hasCoverPage: widget.hasCoverPage,
    );
    return left == null ? position : '$position · $left';
  }

  @override
  Widget build(BuildContext context) {
    final entries = widget.entries;
    // The sheet lifts with the keyboard so the page field stays in view.
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ReaderSheetHeader(title: 'Contents', subtitle: _subtitle),
            if (widget.pageCount > 0)
              _GoToPage(
                pageCount: widget.pageCount,
                hasCoverPage: widget.hasCoverPage,
                onGo: widget.onSelect,
              ),
            if (entries.isEmpty)
              const AppEmptyState(
                icon: Icons.toc,
                title: 'No chapter list yet',
                message:
                    'This book does not have chapters to jump between. You '
                    'can still go to a page by its number above, or drag the '
                    'handle on the right edge of the page.',
              )
            else
              Flexible(
                child: ListView.builder(
                  controller: _scroll,
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  itemCount: entries.length,
                  itemBuilder: (context, index) => _row(context, index),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _row(BuildContext context, int index) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final entry = widget.entries[index];
    final page = entry.pageNumber;
    final isCurrent = index == _currentIndex;
    final trailing = entry.displayedPageText(hasCoverPage: widget.hasCoverPage);
    final title = entry.displayedTitle(hasCoverPage: widget.hasCoverPage);
    final topLevel = entry.depth == 0;

    return Semantics(
      button: page != null,
      selected: isCurrent,
      enabled: page != null,
      hint: isCurrent ? 'You are here' : null,
      child: InkWell(
        key: isCurrent ? _currentKey : null,
        onTap: page == null ? null : () => widget.onSelect(page),
        child: Container(
          constraints: const BoxConstraints(
            minHeight: AppSizes.minimumTouchTarget,
          ),
          decoration: BoxDecoration(
            color: isCurrent
                ? colors.primaryContainer.withValues(alpha: 0.55)
                : null,
            border: BorderDirectional(
              start: BorderSide(
                color: isCurrent ? colors.primary : Colors.transparent,
                width: 4,
              ),
            ),
          ),
          padding: EdgeInsetsDirectional.only(
            start: AppSpacing.md + entry.depth * AppSpacing.md,
            end: AppSpacing.md,
            top: topLevel ? AppSpacing.xs : 2,
            bottom: topLevel ? AppSpacing.xs : 2,
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style:
                      (topLevel
                              ? theme.textTheme.bodyLarge
                              : theme.textTheme.bodyMedium)
                          ?.copyWith(
                            fontWeight: isCurrent
                                ? FontWeight.w800
                                : topLevel
                                ? FontWeight.w600
                                : FontWeight.w400,
                            color: page == null
                                ? colors.onSurface.withValues(alpha: 0.38)
                                : topLevel || isCurrent
                                ? colors.onSurface
                                : colors.onSurfaceVariant,
                          ),
                ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: AppSpacing.sm),
                Text(
                  trailing,
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: isCurrent ? colors.primary : colors.onSurfaceVariant,
                    fontWeight: isCurrent ? FontWeight.w800 : null,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The entry the reader is inside: the last one that starts on or before
/// [page], or -1 when none does.
///
/// Every depth counts, not only chapters. A recovered outline is sorted by page
/// and a compiled one is in reading order, so the last match is the closest
/// heading above the reader.
int readerOutlineCurrentIndex(List<ReaderOutlineEntry> entries, int page) {
  var current = -1;
  for (var i = 0; i < entries.length; i++) {
    final entryPage = entries[i].pageNumber;
    if (entryPage != null && entryPage <= page) current = i;
  }
  return current;
}

/// A field for going to a page by its number.
///
/// The number is the one the footer prints, so a book with a cover does not
/// make the reader add one to it. What the sheet hands back is the physical
/// sheet, like every other way of getting somewhere in the book.
class _GoToPage extends StatefulWidget {
  const _GoToPage({
    required this.pageCount,
    required this.hasCoverPage,
    required this.onGo,
  });

  final int pageCount;
  final bool hasCoverPage;
  final void Function(int pageNumber) onGo;

  @override
  State<_GoToPage> createState() => _GoToPageState();
}

class _GoToPageState extends State<_GoToPage> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  int get _printedCount =>
      printedPageCount(widget.pageCount, hasCoverPage: widget.hasCoverPage);

  void _go() {
    final typed = int.tryParse(_controller.text.trim());
    if (typed == null || _printedCount < 1) return;
    final printed = typed.clamp(1, _printedCount);
    widget.onGo(widget.hasCoverPage ? printed + 1 : printed);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(
        AppSpacing.lg - 4,
        AppSpacing.xxs,
        AppSpacing.md,
        AppSpacing.xs,
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              keyboardType: TextInputType.number,
              textInputAction: TextInputAction.go,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: InputDecoration(
                labelText: 'Go to page',
                hintText: '1–$_printedCount',
                isDense: true,
              ),
              onSubmitted: (_) => _go(),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          AppButton.outlined(label: 'Go', onPressed: _go),
        ],
      ),
    );
  }
}
