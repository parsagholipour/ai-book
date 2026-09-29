/// A chapter's markdown as the Studio editor lays it out: runs of text, and
/// the atomic things that sit between them — a picture, a chart, and (in the
/// picture-book layout) the break between two pages.
///
/// Markdown stays the one format. The editor never owns a document model of
/// its own: it parses a chapter into blocks when it opens, and serializes the
/// blocks back to markdown for every save. That is only safe if the two are
/// exact inverses, so [serializeManuscriptBlocks] of [parseManuscriptBlocks]
/// returns normalized markdown (LF line endings, no trailing spaces, at most
/// one blank line between blocks, trimmed) byte for byte.
///
/// The rule that makes it exact: **an atomic block is a paragraph of its
/// own** — a line with a blank line (or the start or end of the chapter) on
/// both sides. An image line with text directly above or below it is part of
/// that paragraph in markdown (an inline image), and stays inside the text
/// block here too. Separating it would add the blank lines the serializer
/// joins blocks with, and change the chapter.
///
/// Fences are tracked the way the server's `normalizeManuscriptMarkdown` and
/// the paginator track them (a line opening with ``` or ~~~ toggles, closed by
/// the same marker), so an image-looking line or a page separator inside a
/// code fence is text, never a block. A ```figure fence is a chart and becomes
/// a [FigureBlock]; every other fence stays inside its text block.
library;

/// The picture-book layout's page boundary: a line on its own.
///
/// The twin of `MANUSCRIPT_PAGE_SEPARATOR` in
/// `packages/core/src/authoring/manuscriptText.ts`.
const manuscriptPageSeparator = '<!-- page -->';

sealed class ManuscriptBlock {
  const ManuscriptBlock();

  /// The block's markdown, exactly as the serializer writes it.
  String get markdown;
}

/// A run of prose (and anything else that is not atomic: headings, lists,
/// quotes, ordinary code fences, inline images).
final class TextBlock extends ManuscriptBlock {
  const TextBlock(this.text);

  final String text;

  /// Serialized form: leading and trailing blank lines removed. Indentation
  /// on the first line is kept, because it can mean something (indented code).
  @override
  String get markdown => trimBlankLines(text);

  bool get isBlank => markdown.isEmpty;

  @override
  bool operator ==(Object other) => other is TextBlock && other.text == text;

  @override
  int get hashCode => Object.hash(TextBlock, text);

  @override
  String toString() => 'TextBlock(${_preview(text)})';
}

/// A picture that is a paragraph of its own: `![alt](url)` or
/// `![alt](url "title")`.
final class ImageBlock extends ManuscriptBlock {
  const ImageBlock({required this.alt, required this.url, this.title});

  /// The caption the author sees and edits. Markdown calls it alt text.
  final String alt;
  final String url;
  final String? title;

  ImageBlock copyWith({String? alt, String? url}) =>
      ImageBlock(alt: alt ?? this.alt, url: url ?? this.url, title: title);

  @override
  String get markdown {
    final safeAlt = sanitizeImageAlt(alt);
    final suffix = title == null ? '' : ' "${title!.replaceAll('"', "'")}"';
    return '![$safeAlt]($url$suffix)';
  }

  @override
  bool operator ==(Object other) =>
      other is ImageBlock &&
      other.alt == alt &&
      other.url == url &&
      other.title == title;

  @override
  int get hashCode => Object.hash(ImageBlock, alt, url, title);

  @override
  String toString() => 'ImageBlock($markdown)';
}

/// The break between two pages of a picture book.
final class PageBreakBlock extends ManuscriptBlock {
  const PageBreakBlock();

  @override
  String get markdown => manuscriptPageSeparator;

  @override
  bool operator ==(Object other) => other is PageBreakBlock;

  @override
  int get hashCode => (PageBreakBlock).hashCode;

  @override
  String toString() => 'PageBreakBlock()';
}

/// A chart: a whole ```figure fence, kept verbatim. The Studio shows it as a
/// read-only card and never edits it.
final class FigureBlock extends ManuscriptBlock {
  const FigureBlock(this.raw);

  final String raw;

  @override
  String get markdown => raw;

  @override
  bool operator ==(Object other) => other is FigureBlock && other.raw == raw;

  @override
  int get hashCode => Object.hash(FigureBlock, raw);

  @override
  String toString() => 'FigureBlock(${_preview(raw)})';
}

final _fenceLine = RegExp(r'^\s{0,3}(```|~~~)');
final _figureOpener = RegExp(r'^[ \t]{0,3}```figure(?![\p{L}])', unicode: true);
final _figureCloser = RegExp(r'^[ \t]{0,3}```[ \t]*$');
final _imageLine = RegExp(r'^!\[([^\[\]\n]*)\]\(([^)\s]+)(?: "([^"\n]*)")?\)$');

/// Splits one chapter's markdown into blocks. Never returns an empty
/// [TextBlock]; consecutive atomic blocks have nothing between them.
List<ManuscriptBlock> parseManuscriptBlocks(String markdown) {
  final lines = markdown
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n');
  final blocks = <ManuscriptBlock>[];
  final pending = <String>[];

  void flushText() {
    final text = trimBlankLines(pending.join('\n'));
    pending.clear();
    if (text.isNotEmpty) blocks.add(TextBlock(text));
  }

  bool blankAt(int index) =>
      index < 0 || index >= lines.length || lines[index].trim().isEmpty;

  bool isolated(int start, int end) => blankAt(start - 1) && blankAt(end + 1);

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];
    final fence = _fenceLine.firstMatch(line);
    if (fence != null) {
      final marker = fence.group(1)!;
      final close = _fenceCloseIndex(lines, i + 1, marker);
      if (close != null &&
          _figureOpener.hasMatch(line) &&
          _figureCloser.hasMatch(lines[close]) &&
          isolated(i, close)) {
        flushText();
        blocks.add(FigureBlock(lines.sublist(i, close + 1).join('\n')));
        i = close + 1;
        continue;
      }
      // An ordinary fence (or an unclosed one, which runs to the end of the
      // chapter) is text, copied through whole so nothing inside it is read
      // as a block.
      final end = close ?? lines.length - 1;
      pending.addAll(lines.sublist(i, end + 1));
      i = end + 1;
      continue;
    }
    if (isolated(i, i)) {
      final image = parseImageLine(line);
      if (image != null) {
        flushText();
        blocks.add(image);
        i++;
        continue;
      }
      if (line == manuscriptPageSeparator) {
        flushText();
        blocks.add(const PageBreakBlock());
        i++;
        continue;
      }
    }
    pending.add(line);
    i++;
  }
  flushText();
  return blocks;
}

/// Joins blocks back into a chapter: each block's markdown, separated by one
/// blank line. Blank text blocks (the editor keeps empty ones between two
/// pictures so there is somewhere to type) are dropped.
String serializeManuscriptBlocks(Iterable<ManuscriptBlock> blocks) {
  final parts = <String>[];
  for (final block in blocks) {
    final markdown = block.markdown;
    if (block is TextBlock && markdown.isEmpty) continue;
    parts.add(markdown);
  }
  return parts.join('\n\n');
}

/// Reads a line that is only a picture, in the canonical spelling the
/// serializer writes. Anything else (leading spaces, two spaces before the
/// title) is left as text so the round trip stays exact.
ImageBlock? parseImageLine(String line) {
  final match = _imageLine.firstMatch(line);
  if (match == null) return null;
  return ImageBlock(
    alt: match.group(1)!,
    url: match.group(2)!,
    title: match.group(3),
  );
}

/// A caption made safe for `![...]`: one line, no square brackets.
String sanitizeImageAlt(String alt) => alt
    .replaceAll(RegExp(r'\s*\n\s*'), ' ')
    .replaceAll('[', '(')
    .replaceAll(']', ')');

/// Removes whole blank lines from both ends, keeping the first line's
/// indentation and the last line's content exactly.
String trimBlankLines(String text) {
  final lines = text.split('\n');
  var start = 0;
  var end = lines.length;
  while (start < end && lines[start].trim().isEmpty) {
    start++;
  }
  while (end > start && lines[end - 1].trim().isEmpty) {
    end--;
  }
  if (start == 0 && end == lines.length) return text;
  return lines.sublist(start, end).join('\n');
}

/// Splits text into its blank-line-separated paragraphs, never inside a fence.
/// Joining the result with a blank line gives back [trimBlankLines] of the
/// input when it was normalized.
List<String> splitManuscriptParagraphs(String text) {
  final lines = text.split('\n');
  final paragraphs = <String>[];
  final current = <String>[];
  String? fence;
  void flush() {
    if (current.isEmpty) return;
    paragraphs.add(current.join('\n'));
    current.clear();
  }

  for (final line in lines) {
    final match = _fenceLine.firstMatch(line);
    if (fence != null) {
      current.add(line);
      if (match != null && match.group(1) == fence) fence = null;
      continue;
    }
    if (match != null) fence = match.group(1);
    if (line.trim().isEmpty && fence == null) {
      flush();
      continue;
    }
    current.add(line);
  }
  flush();
  return paragraphs;
}

/// The page groups of a picture-book chapter: the blocks between its page
/// breaks. Always at least one (possibly empty) page.
List<List<ManuscriptBlock>> manuscriptPages(List<ManuscriptBlock> blocks) {
  final pages = <List<ManuscriptBlock>>[[]];
  for (final block in blocks) {
    if (block is PageBreakBlock) {
      pages.add([]);
    } else {
      pages.last.add(block);
    }
  }
  return pages;
}

int? _fenceCloseIndex(List<String> lines, int from, String marker) {
  for (var j = from; j < lines.length; j++) {
    final match = _fenceLine.firstMatch(lines[j]);
    if (match != null && match.group(1) == marker) return j;
  }
  return null;
}

String _preview(String text) =>
    text.length <= 40 ? text : '${text.substring(0, 40)}…';
