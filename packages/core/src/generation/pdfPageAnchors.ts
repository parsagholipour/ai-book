import { CONTENTS_DEST_NAME, SOURCES_DEST_NAME, type BookPageAnchor } from "./pdfPageMap.js";
import { chapterAnchorMarkup, type CompiledBookMarkdown, type PageAnchorPlan } from "./markdown.js";

/**
 * Plants the markers the PDF page map is measured from.
 *
 * This runs only on the renderer's own copy of the compiled markdown — never on
 * `book.md`, whose bytes are the provenance sha, the EPUB input and the reader
 * chapter fingerprint. Layout neutrality is the design constraint everything
 * here serves: adjacent model pages share single-newline joins (often one
 * paragraph), so a marker must never open or close a block that the plain
 * document did not have. Three shapes cover the contexts:
 *
 * - Plain content (prose, an image line, anything marked treats as a paragraph
 *   line): an empty inline `<span id>` glued to the first content character.
 *   Inline HTML neither interrupts a paragraph nor starts a block in marked@4,
 *   and an empty unstyled span has no box of its own — collapsible whitespace
 *   collapses straight through it.
 * - Block syntax (`## `, a list, a fence, a blockquote, raw block HTML…): an
 *   HTML comment on its own line before it. marked emits the comment verbatim,
 *   it renders nothing, and the HTML pass swaps it for an id on the following
 *   block element. Measured against marked@4.3.0: a comment line between a
 *   paragraph and *any construct that would have interrupted that paragraph
 *   anyway* leaves the rendered blocks byte-identical.
 *
 * The one classification that matters is therefore "would this line have
 * interrupted the paragraph?": a line that would *not* (a `1969.` list marker,
 * a lone `|pipe|`, inline HTML) must take the span shape, or the comment would
 * split a paragraph the plain document kept whole — which moves every page
 * break after it.
 */
export function injectBookPageAnchorMarkers(
  markdown: string,
  compiled: Pick<CompiledBookMarkdown, "pageAnchors" | "sourcesOffset">
): string {
  const insertions: Array<{ offset: number; destName: string }> = [];
  for (const anchor of compiled.pageAnchors) {
    if (anchor.markdownOffset !== undefined) {
      insertions.push({ offset: anchor.markdownOffset, destName: anchor.destName });
    }
  }
  if (compiled.sourcesOffset !== undefined) {
    insertions.push({ offset: compiled.sourcesOffset, destName: SOURCES_DEST_NAME });
  }

  let result = neutralizeReservedIds(markdown, compiled.pageAnchors);
  // Descending, so earlier offsets stay valid as later ones are edited.
  for (const { offset, destName } of insertions.sort((a, b) => b.offset - a.offset)) {
    if (offset < 0 || offset > result.length) {
      continue;
    }
    const marker = markerFor(result, offset, destName);
    if (marker !== undefined) {
      result = result.slice(0, marker.at) + marker.text + result.slice(marker.at);
    }
  }
  return result;
}

/**
 * A manuscript is user text and raw HTML passes through it, so a page could
 * carry its own `id="bp-3"` — and Chrome resolves a link against the FIRST
 * element wearing an id, so a manuscript id on an earlier page would point that
 * page's destination at wherever the manuscript put it. Renamed with the same
 * byte length, because the anchor offsets were computed against the unmodified
 * compile. The Contents heading's own id needs no such guard: the compiled
 * Contents precedes every page, so first-id-wins already resolves to it.
 *
 * `chapter-*` cannot be renamed that bluntly, because the compiled markdown
 * writes those ids itself — one per printed chapter, and they are what the
 * Contents links navigate by. Only the *other* copies of the name are renamed,
 * and the compile's own offsets are what tells them apart; marked's heading
 * slugs, which exist on neither side of this string, are handled after the
 * render by {@link neutralizeRenderedReservedIds}.
 */
function neutralizeReservedIds(markdown: string, anchors: readonly PageAnchorPlan[]): string {
  const withoutBp = markdown.replace(
    /(id\s*=\s*["'])(bp-)/gi,
    (_full, prefix: string, reserved: string) => `${prefix}${neutralizeId(reserved)}`
  );
  return neutralizeForeignChapterIds(withoutBp, anchors);
}

/**
 * Every `chapter-N` id in the markdown except the ones the compile wrote.
 *
 * A manuscript reaches this shape without meaning any harm: markdown has no
 * attribute syntax, so an empty `<a id>` before a heading is *the* convention
 * for naming a chapter, and `chapter-2` is the name anyone would pick — which is
 * why the compiler picked it too. Nothing about the bytes distinguishes the two,
 * so the compile records where it wrote each of its own and they are confirmed
 * against the bytes at those offsets here; if a single one is not where it says
 * it is, nothing is renamed at all, because a chapter that lost its id would
 * take its Contents link with it. Renames keep the byte length, so the marker
 * offsets applied next still hold.
 *
 * Only an id inside a tag is a candidate, and never one inside a fenced block:
 * marked prints those as code rather than rendering them, so they are no id at
 * all, and renaming one would print `xhapter-2` in a book that is teaching HTML.
 */
function neutralizeForeignChapterIds(markdown: string, anchors: readonly PageAnchorPlan[]): string {
  const compiled = compiledChapterIdOffsets(markdown, anchors);
  if (compiled === undefined || compiled.size === 0) {
    return markdown;
  }
  // The attribute name is case-insensitive to HTML and the id *value* is not,
  // so `ID="chapter-2"` is the same destination and `id="Chapter-2"` is not.
  return markdown.replace(
    /(<[a-zA-Z][^<>]*?\s[iI][dD]\s*=\s*(["']))(chapter-\d+)\2/g,
    (full: string, opening: string, quote: string, name: string, at: number) =>
      compiled.has(at) || insideOpenFence(markdown, at) ? full : `${opening}${neutralizeId(name)}${quote}`
  );
}

/**
 * The tag offsets the compile says its own chapter anchors start at, kept only
 * when the markdown really holds that anchor there. `undefined` means one did
 * not, and nothing may be renamed on a map of the document this stale.
 */
function compiledChapterIdOffsets(markdown: string, anchors: readonly PageAnchorPlan[]): Set<number> | undefined {
  const offsets = new Set<number>();
  for (const anchor of anchors) {
    if (anchor.existingIdOffset === undefined) {
      continue;
    }
    if (!markdown.startsWith(chapterAnchorMarkup(anchor.destName), anchor.existingIdOffset)) {
      return undefined;
    }
    offsets.add(anchor.existingIdOffset);
  }
  return offsets;
}

/**
 * The reserved prefixes, and the same-byte-length ones a competitor for a
 * destination is renamed to. Equal length is what lets the markdown side rename
 * without moving an anchor offset.
 */
const NEUTRALIZED_ID_PREFIXES = new Map<string, string>([
  ["bp-", "xp-"],
  ["chapter-", "xhapter-"]
]);

function neutralizeId(name: string): string {
  for (const [reserved, neutral] of NEUTRALIZED_ID_PREFIXES) {
    if (name.toLowerCase().startsWith(reserved)) {
      return `${neutral}${name.slice(reserved.length)}`;
    }
  }
  return name;
}

/**
 * The same guard on the rendered side, where marked writes ids of its own.
 *
 * `## Chapter 2` inside a page becomes `<h2 id="chapter-2">` — the slug marked
 * derives from the heading text, which never existed in the markdown for
 * {@link neutralizeReservedIds} to find, and which outranks the real chapter
 * opener whenever it prints earlier. What that costs is not only the page map:
 * `chapter-N` is what the printed Contents links, the numbers written back into
 * their rows and the reader's fallback outline all navigate by, and
 * `buildBookPdfPageMap` only refuses a *decreasing* run of anchors, so a stolen
 * destination that still lands in order produces a full map of the wrong pages.
 *
 * So the rename happens where the renderer's own marks are still recognisable
 * by shape and everything else wearing a reserved name is a competitor: the
 * compiled chapter anchor — an empty `<a>` written directly before its heading,
 * so nothing but closers, comments and the `<h2>` can follow it — and the
 * injected empty page-marker `<span>` are kept, and every other reserved id is
 * renamed. Prose and code samples cannot be caught by accident: marked escapes
 * `"` and `'` everywhere it emits text, so a quoted `id=` only survives inside a
 * real tag.
 *
 * A manuscript's own `#chapter-2` link then resolves to the book's chapter
 * instead of to the manuscript's heading, which is the right way round — these
 * names exist for the apparatus the compiler prints around the manuscript.
 *
 * Runs before `liftChapterAnchorsOntoHeadings`, which overwrites the slug on
 * whichever heading it lands on anyway.
 */
export function neutralizeRenderedReservedIds(html: string): string {
  return html.replace(
    RENDERED_RESERVED_ID_RE,
    (full: string, opening: string | undefined, quote: string | undefined, name: string | undefined) =>
      opening === undefined || name === undefined ? full : `${opening}${neutralizeId(name)}${quote}`
  );
}

/**
 * The renderer's own two marks first — matched whole, so the ids inside them are
 * stepped over — then any other holder of a destination name, captured for
 * renaming. The names are matched *whole*, as `chapterAnchorId` and
 * `bookPageDestName` write them (a chapter index is a positive integer): a
 * manuscript heading only collides by slugging to exactly `chapter-2`, and one
 * that slugs to `chapter-2-the-return` is left alone, links to it included.
 */
const RENDERED_RESERVED_ID_RE = new RegExp(
  [
    `<a id="chapter-\\d+"></a>(?=(?:\\s|<!--[\\s\\S]*?-->|</[a-z0-9]+\\s*>)*<h2\\b)`,
    `<span id="(?:bp-\\d+|${SOURCES_DEST_NAME})"></span>`,
    `(id\\s*=\\s*(["']))(bp-\\d+|${SOURCES_DEST_NAME}|chapter-\\d+)\\2`
  ].join("|"),
  "gi"
);

function markerFor(
  markdown: string,
  offset: number,
  destName: string
): { text: string; at: number } | undefined {
  // A boundary inside an unclosed code fence would print the marker as code
  // text. Leave that page unanchored; the map builder then drops the whole map
  // rather than measuring around a malformed manuscript.
  if (insideOpenFence(markdown, offset)) {
    return undefined;
  }
  const lineEnd = markdown.indexOf("\n", offset);
  const line = markdown.slice(offset, lineEnd < 0 ? markdown.length : lineEnd);
  const followingLine = lineAfter(markdown, lineEnd);
  const before = markdown.slice(0, offset);
  const newlines = before.match(/\n*$/)?.[0]?.length ?? 0;
  const previousLine = previousLineOf(before, newlines);
  const continuesParagraph = newlines === 1 && previousLine !== undefined && isPlainParagraphLine(previousLine);

  const blocky = continuesParagraph ? interruptsParagraph(line, followingLine) : startsBlockSyntax(line);
  if (!blocky) {
    return { text: `<span id="${destName}"></span>`, at: offset };
  }

  // A boundary between two lines of ONE container — a quote, a list, a table
  // whose rows continue across the model-page join — is where a marker line
  // would split what the plain document keeps whole (measured: a comment
  // between two table rows ejects every following row as literal pipe text).
  if (newlines === 1 && previousLine !== undefined && startsBlockSyntax(previousLine)) {
    // No marker shape is neutral inside a table: a comment splits it and a
    // span shifts the cells. Fail soft — the map builder drops the whole map
    // rather than the book shipping a corrupted table.
    if (/^\s*\|/.test(line) || /^\s*\|/.test(previousLine)) {
      return undefined;
    }
    // Inside a quote or list line the marker can ride INSIDE the construct:
    // after the `> ` / `- ` / `1. ` prefix it is inline content at the item's
    // start — the same proven-neutral shape as a paragraph's first word.
    const prefix = line.match(/^(\s{0,3}(?:>\s?|(?:[-*+]|\d{1,9}[.)])\s+))/);
    if (prefix && !isHorizontalRuleLine(line)) {
      return { text: `<span id="${destName}"></span>`, at: offset + prefix[1]!.length };
    }
  }

  return { text: `<!--${destName}-->\n`, at: offset };
}

function isHorizontalRuleLine(line: string): boolean {
  return /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
}

/**
 * Lines a `<span>` prefix would corrupt when they stand at a block position.
 * `![` images and inline code are absent on purpose — an inline prefix is
 * safe there.
 */
function startsBlockSyntax(line: string): boolean {
  return /^(#{1,6}\s|(?:[-*+]|\d{1,9}[.)])\s|>|```|~~~|\||<[a-zA-Z!/]|(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$)/.test(
    line
  );
}

/** Block tags marked@4 lets interrupt a paragraph (its `_paragraph` html check). */
const PARAGRAPH_INTERRUPTING_TAG =
  /^<\/?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|legend|li|main|menu|nav|ol|optgroup|option|p|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)\b|^<!--/i;

/**
 * Whether marked@4.3.0 ends the open paragraph at this line — measured, not
 * assumed: `1.` interrupts, `1969.` does not; a header-and-delimiter table
 * interrupts, a lone `|pipe|` line does not; a setext underline turns the
 * paragraph into a heading and tolerates a comment in front of it.
 */
function interruptsParagraph(line: string, followingLine: string | undefined): boolean {
  if (/^(#{1,6}\s|[-*+]\s|1[.)]\s|>|```|~~~|(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$|\s{0,3}[-=]+\s*$)/.test(line)) {
    return true;
  }
  if (PARAGRAPH_INTERRUPTING_TAG.test(line)) {
    return true;
  }
  if (line.startsWith("|") && followingLine !== undefined) {
    return /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(followingLine);
  }
  return false;
}

function isPlainParagraphLine(line: string): boolean {
  return line.trim().length > 0 && !startsBlockSyntax(line);
}

function previousLineOf(before: string, trailingNewlines: number): string | undefined {
  if (trailingNewlines === 0) {
    return undefined;
  }
  const withoutNewlines = before.slice(0, before.length - trailingNewlines);
  const lineStart = withoutNewlines.lastIndexOf("\n") + 1;
  return withoutNewlines.slice(lineStart);
}

function lineAfter(markdown: string, lineEnd: number): string | undefined {
  if (lineEnd < 0) {
    return undefined;
  }
  const nextEnd = markdown.indexOf("\n", lineEnd + 1);
  return markdown.slice(lineEnd + 1, nextEnd < 0 ? markdown.length : nextEnd);
}

function insideOpenFence(markdown: string, offset: number): boolean {
  const fences = markdown.slice(0, offset).match(/^ {0,3}(?:```|~~~)/gm);
  return ((fences?.length ?? 0) & 1) === 1;
}

const BLOCK_TARGET_TAGS = "h1|h2|h3|h4|h5|h6|p|ul|ol|blockquote|pre|table|div|section|figure|hr|img";

/**
 * Moves every marker onto a real box in the rendered HTML.
 *
 * A destination is derived from its target's layout rect, and an empty inline
 * at a fragmentation boundary lands on the *previous* page (measured — it is
 * the same failure `liftChapterAnchorsOntoHeadings` exists for). So each
 * marker is resolved to something with extent: a comment becomes the id of the
 * following block element; a span glued to prose wraps the word after it; a
 * span before an image moves onto the `<img>`. A marker nothing matches is
 * left in place — a slightly ambiguous destination still beats a missing one.
 */
export function placeBookPageAnchorIds(html: string): string {
  let result = html;

  // Comment markers: id onto the next block-level open tag.
  result = result.replace(
    new RegExp(`<!--((?:bp-\\d+|${SOURCES_DEST_NAME}))-->(\\s*(?:</[a-z0-9]+\\s*>\\s*)*)<(${BLOCK_TARGET_TAGS})((?:\\s[^>]*)?)>`, "gi"),
    (_full, destName: string, between: string, tag: string, attributes: string) =>
      `${between}<${tag}${withIdAttribute(attributes, destName)}>`
  );
  // A comment whose block never followed (end of document, unexpected shape):
  // drop it rather than print it into the PDF text layer. Comments render
  // nothing, so this is belt and braces.
  result = result.replace(new RegExp(`<!--(?:bp-\\d+|${SOURCES_DEST_NAME})-->`, "gi"), "");

  // Span markers glued to content: onto a following image, or around the first
  // word so the destination has the word's own rect.
  result = result.replace(
    new RegExp(`<span id="((?:bp-\\d+|${SOURCES_DEST_NAME}))"></span><img((?:\\s[^>]*)?)>`, "gi"),
    (_full, destName: string, attributes: string) => `<img${withIdAttribute(attributes, destName)}>`
  );
  result = result.replace(
    new RegExp(`<span id="((?:bp-\\d+|${SOURCES_DEST_NAME}))"></span>([^<\\s]+)`, "gi"),
    (_full, destName: string, word: string) => `<span id="${destName}">${word}</span>`
  );

  return result;
}

/** Replaces any id the target already carried — a marked slug nothing links to. */
function withIdAttribute(attributes: string, id: string): string {
  const withoutId = attributes.replace(/\sid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, () => "").replace(/\/$/, "");
  return `${withoutId} id="${id}"`;
}

/**
 * The links that make Chrome emit a destination at all: Skia writes `/Dests`
 * only for ids that some internal link points at, and only the Contents page —
 * when a book has one — links anywhere today. `display:none` is measured to
 * contribute nothing: no layout, no link annotations, no structure elements.
 */
export function bookPageAnchorLinkNav(anchors: readonly BookPageAnchor[], options: {
  hasContents: boolean;
  hasSources: boolean;
}): string {
  const names = [
    ...anchors.map((anchor) => anchor.destName),
    ...(options.hasContents ? [CONTENTS_DEST_NAME] : []),
    ...(options.hasSources ? [SOURCES_DEST_NAME] : [])
  ];
  if (names.length === 0) {
    return "";
  }
  const links = names.map((name) => `<a href="#${encodeURIComponent(name)}"></a>`).join("");
  return `<nav class="bp-anchor-links" style="display:none" aria-hidden="true">${links}</nav>`;
}

/**
 * Prints the measured PDF page numbers into the Contents rows.
 *
 * The compiled markdown writes each row's number as the chapter's *model* page
 * index — the only number available before a render exists — while the page
 * footer prints `counter(page)`, so the two systems disagreed inside one
 * printed book. After the first render measures where each chapter landed,
 * the rows are rewritten in order and the document rendered once more.
 *
 * Returns `undefined` when the rows do not line up one-to-one with the
 * measured chapters — a partially rewritten Contents would be worse than the
 * old numbers.
 */
export function rewriteContentsPdfPageNumbers(html: string, chapterPdfPages: readonly number[]): string | undefined {
  let row = 0;
  const result = html.replace(
    /(<span class="book-contents__page">)(\d+)(<\/span>)/g,
    (full: string, open: string, _num: string, close: string) => {
      const pdfPage = chapterPdfPages[row];
      row += 1;
      return pdfPage === undefined ? full : `${open}${pdfPage}${close}`;
    }
  );
  return row === chapterPdfPages.length ? result : undefined;
}

export function appendBookPageAnchorLinkNav(html: string, nav: string): string {
  if (!nav) {
    return html;
  }
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose < 0) {
    return html + nav;
  }
  return html.slice(0, bodyClose) + nav + html.slice(bodyClose);
}
