import type { ManuscriptMatterHint } from "./manuscriptMatter.js";
import { markupElements, replaceMarkupElements, throughLastTag, type MarkupElementKind } from "./markupScan.js";

type EpubMatterBlock = { html: string; hint?: ManuscriptMatterHint | undefined };
type Boundary = { start: number; end: number; hint?: ManuscriptMatterHint | undefined };

const EPUB_MATTER_TYPES: Array<[RegExp, ManuscriptMatterHint]> = [
  [/^(?:toc|landmarks|page-list|loi|lot)$/, "contents"],
  [/^copyright-page$/, "copyright"],
  [/^dedication$/, "dedication"],
  [/^(?:titlepage|halftitlepage|title-page|cover)$/, "title"],
  [/^(?:epigraph|acknowledgments|acknowledgements|colophon|imprint|contributors|other-credits|seriespage)$/, "passover"]
];

/** A semantic page boundary, including the compiler's combined matter sheet. */
function matterHint(tag: string): ManuscriptMatterHint | undefined {
  const classes = tag.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) ?? [];
  if (classes.includes("book-title-page")) return "title";
  if (classes.includes("book-matter-sheet__dedication")) return "dedication";
  if (classes.includes("book-matter-sheet__publication")) return "copyright";
  if (classes.includes("book-contents")) return "contents";
  const types = [...tag.matchAll(/\b(?:epub:type|role)\s*=\s*["']([^"']+)["']/gi)].flatMap((match) =>
    match[1]!.toLowerCase().split(/\s+/).map((type) => type.replace(/^doc-/, ""))
  );
  return EPUB_MATTER_TYPES.find(([pattern]) => types.some((type) => pattern.test(type)))?.[1];
}

/** Older story exports put Sources and the final compiler-marked bio in one file. */
function compilerBiographyBoundary(body: string): Boundary | undefined {
  let boundary: Boundary | undefined;
  // The compiler emits a plain H2 immediately followed by this empty marker.
  // Its biography is the final content; ordinary body subheadings never split.
  // This is `<h2\b[^>]*>[^<>]*<\/h2>\s*(<div\b[^>]*>)\s*<\/div>` read from each
  // H2 tag: a tag the rest does not follow is passed whole, as every start
  // inside it would fail the same way.
  const tags = throughLastTag(body);
  const opening = /<h2\b[^>]*>/gi;
  const rest = /[^<>]*<\/h2>\s*(<div\b[^>]*>)\s*<\/div>/iy;
  for (let tag = opening.exec(tags); tag; tag = opening.exec(tags)) {
    rest.lastIndex = opening.lastIndex;
    const marker = rest.exec(tags);
    if (!marker) continue;
    opening.lastIndex = rest.lastIndex;
    const classes = marker[1]!.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) ?? [];
    if (classes.includes("book-about-author")) boundary = { start: tag.index, end: body.length };
  }
  return boundary;
}

/** `<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>`, case-insensitive. */
const HIDDEN_MARKUP: readonly MarkupElementKind[] = [
  { open: /<!--/g, close: "-->" },
  { open: /<script\b[^>]*>/gi, close: "</script>" },
  { open: /<style\b[^>]*>/gi, close: "</style>" }
];

/** A compiler credit paragraph: `<p\b[^>]*\bclass="…credit…"[^>]*>[\s\S]*?<\/p>`, case-insensitive. */
const CREDIT_PARAGRAPH: readonly MarkupElementKind[] = [
  {
    open: /<p\b[^>]*>/gi,
    close: "</p>",
    accepts: (tag) => /\bclass\s*=\s*(["'])(?:book-title-page__imprint|book-matter-sheet__credit)\1/i.test(tag[0])
  }
];

/**
 * The compiler's title-page foot, `<div class="book-title-page__publication">…</div>`
 * (`bookMatterPages.ts`, since 2026-10-17): the © page's lines, printed under
 * the title. Its paragraphs hold no `div`, so the first close is its own.
 */
const TITLE_PAGE_PUBLICATION: readonly MarkupElementKind[] = [
  {
    open: /<div\b[^>]*>/gi,
    close: "</div>",
    accepts: (tag) => /\bclass\s*=\s*(["'])book-title-page__publication\1/i.test(tag[0])
  }
];

/** `<body\b[^>]*>([\s\S]*)<\/body>`: everything from the first body tag to the last close after it. */
function bodyContent(document: string): string | undefined {
  const tag = /<body\b[^>]*>/i.exec(throughLastTag(document));
  if (!tag) return undefined;
  const from = tag.index + tag[0].length;
  const close = /<\/body>/gi;
  close.lastIndex = from;
  let last: number | undefined;
  for (let match = close.exec(document); match; match = close.exec(document)) last = match.index;
  return last === undefined ? undefined : document.slice(from, last);
}

/**
 * An EPUB spine item can hold several matter pages, or matter followed by prose.
 * Keep only explicit page boundaries: splitting every H2 would turn a chapter's
 * subheadings into chapters. Unmarked XHTML retains its original single section.
 * A small container stack also handles nested wrappers without a non-greedy
 * `div` regex cutting a publication sheet at its first child's closing tag.
 */
export function epubMatterBlocks(html: string): EpubMatterBlock[] {
  const document = replaceMarkupElements(html, HIDDEN_MARKUP, () => " ");
  const bodyTag = throughLastTag(document).match(/<body\b[^>]*>/i)?.[0] ?? "";
  const body = bodyContent(document) ?? replaceMarkupElements(document, [{ open: /<head\b/gi, close: "</head>" }], () => " ", 1);
  const bodyHint = matterHint(bodyTag);
  if (bodyHint) return [{ html: body, hint: bodyHint }];
  const stack: Array<{ name: string; start: number; hint: ManuscriptMatterHint | undefined }> = [];
  const biography = compilerBiographyBoundary(body);
  const boundaries: Boundary[] = biography ? [biography] : [];
  const tags = /<\/?(section|nav|div|article)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  for (const match of body.matchAll(tags)) {
    const name = match[1]!.toLowerCase();
    if (!match[0].startsWith("</")) {
      if (!match[0].endsWith("/>")) stack.push({ name, start: match.index, hint: matterHint(match[0]) });
      continue;
    }
    const open = stack.pop();
    if (open?.name !== name) {
      stack.length = 0; // Malformed wrappers do not establish a page boundary.
      continue;
    }
    if (open.hint) boundaries.push({ start: open.start, end: match.index + match[0].length, hint: open.hint });
  }
  boundaries.sort((a, b) => a.start - b.start || b.end - a.end);
  if (boundaries.length === 0) {
    return [{ html: body }];
  }
  const blocks: EpubMatterBlock[] = [];
  let offset = 0;
  for (const boundary of boundaries) {
    if (boundary.start < offset) continue; // A semantic page owns its nested wrappers.
    if (boundary.start > offset) blocks.push({ html: body.slice(offset, boundary.start) });
    let page = body.slice(boundary.start, boundary.end);
    // These exact classes contain compiler boilerplate, never reader-authored
    // matter; the new export decides whether its owner needs the credit again.
    if (/\bclass\s*=\s*["'][^"']*\b(?:book-title-page|book-matter-sheet__publication)\b/.test(page)) {
      page = replaceMarkupElements(page, CREDIT_PARAGRAPH, () => " ");
    }
    // A title page with publication lines at its foot is two pages to the
    // import: the title page, whose every line the house title page reprints,
    // and the © page, whose holder, rights line, imprint and ISBN are lifted.
    const foot = boundary.hint === "title" ? markupElements(page, TITLE_PAGE_PUBLICATION).next().value : undefined;
    if (foot) {
      blocks.push({ html: page.slice(0, foot.start) + page.slice(foot.end), hint: "title" });
      blocks.push({ html: page.slice(foot.start, foot.end), hint: "copyright" });
    } else {
      blocks.push({ html: page, hint: boundary.hint });
    }
    offset = boundary.end;
  }
  if (offset < body.length) blocks.push({ html: body.slice(offset) });
  return blocks;
}
