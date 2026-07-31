import 'package:flutter/material.dart';
import 'package:pdfrx/pdfrx.dart';

import '../domain/reader_models.dart';

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
        ReaderOutlineEntry(title: 'Page $page', depth: 0, pageNumber: page),
      );
    }
    entries.sort((a, b) => (a.pageNumber ?? 0).compareTo(b.pageNumber ?? 0));
    return entries;
  }
  return const [];
}

/// The table of contents sheet.
class ReaderOutlineSheet extends StatelessWidget {
  const ReaderOutlineSheet({
    required this.entries,
    required this.currentPage,
    required this.onSelect,
    super.key,
  });

  final List<ReaderOutlineEntry> entries;
  final int currentPage;
  final void Function(int pageNumber) onSelect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (entries.isEmpty) {
      return _sheet(
        context,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 32),
          child: Center(
            child: Text(
              'This book has no chapter list yet. It gets one the next time '
              'the book is compiled.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ),
      );
    }

    return _sheet(
      context,
      child: ListView.builder(
        shrinkWrap: true,
        itemCount: entries.length,
        itemBuilder: (context, index) {
          final entry = entries[index];
          final page = entry.pageNumber;
          final isCurrent = page != null && page == currentPage;
          return ListTile(
            dense: entry.depth > 0,
            contentPadding: EdgeInsets.only(
              left: 16.0 + entry.depth * 16.0,
              right: 16,
            ),
            title: Text(
              entry.title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: entry.depth == 0
                  ? theme.textTheme.bodyLarge?.copyWith(
                      fontWeight: FontWeight.w600,
                    )
                  : theme.textTheme.bodyMedium,
            ),
            trailing: page == null
                ? null
                : Text(
                    '$page',
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
            selected: isCurrent,
            enabled: page != null,
            onTap: page == null ? null : () => onSelect(page),
          );
        },
      ),
    );
  }

  Widget _sheet(BuildContext context, {required Widget child}) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
            child: Text(
              'Contents',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          Flexible(child: child),
        ],
      ),
    );
  }
}
