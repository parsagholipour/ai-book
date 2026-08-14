import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { PDFOptions } from "puppeteer";
import { defaultConfig } from "md-to-pdf/dist/lib/config.js";
import { getHtml } from "md-to-pdf/dist/lib/get-html.js";
import type { ScriptProfile } from "../prompting/script.js";
import {
  appendBookPageAnchorLinkNav,
  neutralizeRenderedReservedIds,
  placeBookPageAnchorIds
} from "./pdfPageAnchors.js";

/**
 * The HTML document a book is printed from.
 *
 * This used to be `md-to-pdf`'s own pipeline. We still borrow its renderer —
 * `getHtml` carries marked@4.3.0, highlight.js and `langPrefix: 'hljs '`, and
 * re-rendering the markdown with this repo's own marked@18 instead would change
 * heading ids, email mangling and loose/tight list `<p>` wrapping, which moves
 * every page break in every book ever compiled. What we no longer borrow is the
 * *delivery*: a Chromium launched and destroyed per export, an HTTP static
 * server with a free-port probe, and megabytes of CSS and image data pushed
 * across CDP as untimed `addStyleTag`/`addScriptTag` payloads.
 *
 * Everything `md-to-pdf` used to apply by default is therefore pinned here by
 * hand. Each of these was silently in effect before and would change the
 * rendered book if it were dropped — see `pdfDocument.test.ts`, which asserts
 * the two base stylesheets are byte-for-byte the ones we typeset against.
 */

const require = createRequire(import.meta.url);

/**
 * `md-to-pdf` has no `exports` map, so these are legal subpath imports with
 * `.d.ts` files beside them — but that also means a version bump can silently
 * re-typeset every book. The dependency is pinned to an exact version in
 * `package.json` for that reason, and the stylesheet digests are asserted in a
 * test so a bump fails loudly instead of quietly.
 */
export function bookPdfBaseStylesheetPaths(): { markdownCss: string; highlightCss: string } {
  const markdownCss = defaultConfig.stylesheet[0];
  if (!markdownCss) {
    throw new Error("md-to-pdf no longer ships a default stylesheet.");
  }
  // Resolved through md-to-pdf's own require, not ours: it is md-to-pdf's copy
  // of highlight.js whose theme its `langPrefix: 'hljs '` class names match.
  const requireFromMdToPdf = createRequire(require.resolve("md-to-pdf"));
  const highlightCss = resolve(
    dirname(requireFromMdToPdf.resolve("highlight.js")),
    "..",
    "styles",
    `${defaultConfig.highlight_style}.css`
  );
  return { markdownCss, highlightCss };
}

let baseStylesheets: Promise<{ markdownCss: string; highlightCss: string }> | undefined;

function loadBaseStylesheets(): Promise<{ markdownCss: string; highlightCss: string }> {
  baseStylesheets ??= (async () => {
    const paths = bookPdfBaseStylesheetPaths();
    const [markdownCss, highlightCss] = await Promise.all([
      readFile(paths.markdownCss, "utf8"),
      readFile(paths.highlightCss, "utf8")
    ]);
    return { markdownCss, highlightCss };
  })();
  return baseStylesheets;
}

/**
 * The print options, pinned.
 *
 * `margin` is carried over from md-to-pdf's defaults, but it is worth knowing
 * that it changes nothing today: `bookPdfCss` sets `@page { margin }`, and
 * Chrome honours the CSS box over these CDP parameters — measured, and the page
 * count and line width are identical at 30/40/30/20mm, at 1 cm, and with the
 * option omitted entirely. It stays because it is the fallback the day someone
 * takes `@page { margin }` out of the stylesheet, and because reproducing
 * md-to-pdf's configuration exactly is what makes this file auditable. Do not
 * read it as the thing that controls the text block; that is `pdfCss.ts`.
 */
export const BOOK_PDF_OPTIONS: PDFOptions = {
  format: "a4",
  printBackground: true,
  margin: {
    top: "30mm",
    right: "40mm",
    bottom: "30mm",
    left: "20mm"
  },
  // Chapter and page headings become PDF bookmarks, which is what the mobile
  // reader's table of contents navigates by. Books compiled before this was
  // added have no outline; the reader falls back to the Contents page links.
  outline: true
};

/**
 * The media type the book is typeset for. `md-to-pdf` defaulted to `'screen'`;
 * `page.pdf()` on its own emulates *print*, which is a different cascade.
 */
export const BOOK_PDF_MEDIA_TYPE = "screen" as const;

export type BookPdfDocumentOptions = {
  /** Markdown with images already rewritten to renderer-relative asset paths. */
  markdown: string;
  /** The book's own stylesheet: embedded fonts plus `bookPdfCss`. */
  css: string;
  profile: ScriptProfile;
  /**
   * The hidden link nav from `bookPageAnchorLinkNav`, when this render carries
   * page-map markers. Its presence also runs `placeBookPageAnchorIds`, which
   * resolves each marker onto a real box.
   */
  pageAnchorNav?: string | undefined;
};

/**
 * Assembles the document exactly as the old `setContent` + three `addStyleTag`
 * calls left the DOM: markdown.css, then the highlight theme, then ours. The
 * order is the cascade the book is typeset against — `RTL_OVERRIDES` in
 * `pdfCss.ts` exists precisely to undo rules from the first sheet.
 */
export async function buildBookPdfDocument(options: BookPdfDocumentOptions): Promise<string> {
  const { markdownCss, highlightCss } = await loadBaseStylesheets();
  let html = liftChapterAnchorsOntoHeadings(
    // Unconditional, and before the lift: a page whose text merely *reads* like
    // `## Chapter 2` is handed that heading's slug by marked, and the lift would
    // then plant the real chapter's id behind a copy Chrome resolves first.
    neutralizeRenderedReservedIds(
      stripEmbeddedDocuments(
        getHtml(options.markdown, {
          ...defaultConfig,
          document_title: "",
          body_class: []
        })
      )
    )
  );
  if (options.pageAnchorNav !== undefined) {
    html = appendBookPageAnchorLinkNav(placeBookPageAnchorIds(html), options.pageAnchorNav);
  }
  const styles = [markdownCss, highlightCss, options.css]
    .map((css) => `<style>\n${css}\n</style>`)
    .join("");

  // Function replacers throughout: a `$&` or `$'` inside a stylesheet or the
  // book's own prose would otherwise be expanded by `String.replace`.
  return withDocumentLanguage(html, options.profile).replace("</head>", () => `${styles}</head>`);
}

/**
 * The chapter anchor a Contents link points at, moved onto the heading itself.
 *
 * `compileBookMarkdown` emits `<a id="chapter-N"></a>` on its own line *before*
 * the `## ` heading, and markdown has no way to attach an inline to the block
 * that follows it — so marked glues the anchor to the end of the block that
 * came before, wherever that ends: `<p>…<a id></a></p>`, `<li>…<a id></a></li>`,
 * `<blockquote><p>…<a id></a></p></blockquote>`, its own `<p><a id></a></p>`, or
 * a bare block after the Contents `</section>`.
 *
 * Chrome derives a named destination from the target's layout rect, and
 * `page-break-after: avoid` on `h2` (`pdfCss.ts`) pushes a heading that would
 * straddle a break onto the next page — while that zero-height anchor stays
 * behind at the foot of the previous one. So roughly one chapter link in seven
 * landed a page early, which is what the reader's Contents page and
 * `readerOutlineFromLinks` (the app's fallback table of contents) navigate by.
 *
 * A blank line before the anchor, or a block-level `<div id>` in its place, both
 * leave the destination behind exactly as before — an empty box at a page
 * boundary is fragmented onto the preceding page either way. The destination has
 * to be *on* the heading, and the heading is a real box in every writing
 * direction, which is why this is done here and not in the markdown: putting the
 * anchor inside the `## ` line makes Chrome drop the entire `/Dests` table on a
 * strongly-RTL heading, and it would leak `<a id=…>` into the EPUB's TOC labels
 * through `splitIntoChapters`' `^##\s+(.+)$` capture.
 *
 * Layout is untouched: the anchor is empty, so deleting it leaves whatever box
 * held it exactly the size it was — including the empty `<p></p>` shape, which
 * is deliberately left standing rather than unwrapped. The `<h2>`'s own
 * marked-generated slug is overwritten, and nothing reads it: no stylesheet here
 * has an id selector or `:target`, the EPUB is rendered by a different marked
 * that emits no heading ids at all, and the outline Chrome builds comes from the
 * heading box rather than its id.
 */
export function liftChapterAnchorsOntoHeadings(html: string): string {
  CHAPTER_ANCHOR_RE.lastIndex = 0;
  let result = "";
  let copiedThrough = 0;
  let lifted = false;
  let match: RegExpExecArray | null;
  while ((match = CHAPTER_ANCHOR_RE.exec(html)) !== null) {
    const anchorEnd = match.index + match[0].length;
    const heading = findHeadingTag(html, anchorEnd);
    // No heading to carry the id: leave the anchor exactly where it is, because
    // a destination in the wrong place still beats a Contents link with no
    // destination at all.
    if (!heading) {
      continue;
    }
    result += html.slice(copiedThrough, match.index);
    result += html.slice(anchorEnd, heading.start);
    result += `<h2${withAnchorId(heading.attributes, match[1] ?? "")}>`;
    copiedThrough = heading.end + 1;
    lifted = true;
    CHAPTER_ANCHOR_RE.lastIndex = copiedThrough;
  }
  return lifted ? result + html.slice(copiedThrough) : html;
}

/**
 * The anchor as `compileBookMarkdown` writes it: an `<a>` carrying a
 * `chapter-…` id and nothing else. The id is captured from a double-quoted
 * value, so it cannot contain a quote and is safe to write back verbatim.
 */
const CHAPTER_ANCHOR_RE = /<a\b[^>]*?\sid="(chapter-[^"]*)"[^>]*>\s*<\/a\s*>/gi;

function findHeadingTag(html: string, from: number): { start: number; end: number; attributes: string } | undefined {
  const opening = /<h2\b/i;
  const rest = html.slice(from);
  const found = opening.exec(rest);
  if (!found) {
    return undefined;
  }
  const start = from + found.index;
  const end = findTagEnd(html, start + 1);
  if (end < 0) {
    return undefined;
  }
  return { start, end, attributes: html.slice(start + 3, end) };
}

/** Replaces whatever id the heading had — marked's slug — with the anchor's. */
function withAnchorId(attributes: string, id: string): string {
  const withoutId = attributes.replace(/\sid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, () => "").replace(/\/$/, "");
  return `${withoutId} id="${id}"`;
}

/**
 * Elements that put a *foreign document* on the page, removed from the
 * manuscript's own HTML.
 *
 * Markdown passes raw HTML through, and a manuscript is user text — so an
 * imported book could carry `<iframe src="file:///etc/passwd">` and print the
 * server's password file as part of chapter one. `renderResourcePolicy.ts` is
 * what actually stops that load; this is the second lock, and it is worth having
 * because the two fail differently: the policy is an allowlist on a live
 * browser, this is a property of the document that outlives it.
 *
 * None of these has a meaning in a printed book. `<script>` goes with them —
 * nothing in the pipeline emits one, and the typesetting has to be a function of
 * the manuscript rather than of whatever it decided to run. Executable
 * attributes are removed too: deleting a `<script>` element while leaving
 * `<img onerror="window.open(...)>` behind still lets manuscript text execute.
 *
 * Applied to the rendered HTML rather than to the markdown on purpose: a book
 * *about* HTML keeps its `<iframe>` examples, because marked has already
 * escaped everything inside a code fence to `&lt;iframe&gt;` by this point.
 */
const EMBEDDED_DOCUMENT_RE =
  /<(script|iframe|frame|frameset|object|applet|portal)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?(?:script|iframe|frame|frameset|object|applet|portal|embed|link|base)\b[^>]*>|<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi;

export function stripEmbeddedDocuments(html: string): string {
  // `<meta charset>` survives — only `http-equiv` (a refresh is a navigation).
  return stripExecutableAttributes(html.replace(EMBEDDED_DOCUMENT_RE, () => ""));
}

/**
 * URL-bearing attributes in HTML, SVG and MathML.
 *
 * A `javascript:` URL is executable even without an event attribute. Navigation
 * attributes also reject data documents: MIME aliases and XML-with-XHTML
 * payloads make a selective list too easy to evade, and a book has no reason
 * to turn a click into a new inline document.
 */
const URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "profile",
  "src",
  "srcset",
  "usemap",
  "xlink:href"
]);

const NAVIGATION_URL_ATTRIBUTES = new Set(["action", "formaction", "href", "xlink:href"]);

/**
 * Removes executable attributes while preserving every byte of an ordinary tag.
 *
 * This is a small tokenizer rather than a tag-shaped regular expression: `>` is
 * legal inside a quoted attribute, attributes may be quoted or bare, and a `/`
 * may separate an attribute in malformed-but-browser-accepted HTML. Removal is
 * range-based, so safe markup is returned verbatim and normal book layout cannot
 * drift from serialization changes.
 */
function stripExecutableAttributes(html: string): string {
  const removals: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      break;
    }
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }

    const first = html[tagStart + 1] ?? "";
    if (!/[A-Za-z]/.test(first)) {
      cursor = tagStart + 1;
      continue;
    }
    const tagEnd = findTagEnd(html, tagStart + 1);
    if (tagEnd < 0) {
      break;
    }
    collectExecutableAttributeRanges(html, tagStart + 1, tagEnd, removals);
    cursor = tagEnd + 1;
  }

  if (removals.length === 0) {
    return html;
  }
  let result = "";
  let copiedThrough = 0;
  for (const removal of removals) {
    result += html.slice(copiedThrough, removal.start);
    copiedThrough = removal.end;
  }
  return result + html.slice(copiedThrough);
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function collectExecutableAttributeRanges(
  html: string,
  contentStart: number,
  tagEnd: number,
  removals: Array<{ start: number; end: number }>
): void {
  let cursor = contentStart;
  while (cursor < tagEnd && /[A-Za-z0-9:_-]/.test(html[cursor] ?? "")) {
    cursor += 1;
  }

  while (cursor < tagEnd) {
    while (cursor < tagEnd && /\s/.test(html[cursor] ?? "")) {
      cursor += 1;
    }
    // HTML's tokenizer treats a stray slash before an attribute as a parse
    // error and then continues with that attribute. Do the same, so
    // `<img/onerror=...>` cannot evade the check.
    while (html[cursor] === "/") {
      cursor += 1;
      while (cursor < tagEnd && /\s/.test(html[cursor] ?? "")) {
        cursor += 1;
      }
    }
    if (cursor >= tagEnd) {
      break;
    }

    const attributeStart = cursor;
    while (cursor < tagEnd && !/[\s=/>]/.test(html[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor === attributeStart) {
      cursor += 1;
      continue;
    }
    const name = html.slice(attributeStart, cursor).toLowerCase();
    while (cursor < tagEnd && /\s/.test(html[cursor] ?? "")) {
      cursor += 1;
    }

    let value = "";
    if (html[cursor] === "=") {
      cursor += 1;
      while (cursor < tagEnd && /\s/.test(html[cursor] ?? "")) {
        cursor += 1;
      }
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < tagEnd && html[cursor] !== quote) {
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
        if (html[cursor] === quote) {
          cursor += 1;
        }
      } else {
        const valueStart = cursor;
        while (cursor < tagEnd && !/[\s>]/.test(html[cursor] ?? "")) {
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
      }
    }

    if (isExecutableAttribute(name, value)) {
      removals.push({ start: attributeStart, end: cursor });
    }
  }
}

function isExecutableAttribute(name: string, value: string): boolean {
  if (name.startsWith("on") || name === "srcdoc") {
    return true;
  }
  const normalized = normalizeExecutableValue(value);
  if (URL_ATTRIBUTES.has(name)) {
    if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:")) {
      return true;
    }
    if (NAVIGATION_URL_ATTRIBUTES.has(name) && normalized.startsWith("data:")) {
      return true;
    }
  }
  if (name === "style") {
    return /(?:javascript|vbscript):|expression\s*\(|-moz-binding\s*:/i.test(normalized);
  }
  return false;
}

/** Browser-relevant decoding for a URL scheme, not a general HTML decoder. */
function normalizeExecutableValue(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_full, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&(colon|tab|newline);/gi, (_full, name: string) =>
      name.toLowerCase() === "colon" ? ":" : name.toLowerCase() === "tab" ? "\t" : "\n"
    )
    // Browsers ignore ASCII whitespace and controls around/in a scheme. Removing
    // them before comparison catches `java&#x09;script:` as well as leading space.
    .replace(/[\u0000-\u0020\u007f]+/g, "")
    .toLowerCase();
}

/**
 * md-to-pdf's wrapper carries a bare `<html>`, which is why the language used to
 * be set by an injected script. The direction itself comes from CSS, which is
 * bidi-equivalent; this is for what CSS cannot reach — Chrome copies `lang` into
 * the PDF's own `/Lang`, and `dir` adds the UA's root bidi isolation.
 */
function withDocumentLanguage(html: string, profile: ScriptProfile): string {
  if (isDefaultLatinProfile(profile)) {
    return html;
  }
  return html.replace("<html>", () => `<html lang="${profile.code}" dir="${profile.direction}">`);
}

export function isDefaultLatinProfile(profile: ScriptProfile): boolean {
  return profile.script === "latin" && profile.direction === "ltr" && profile.code === "en";
}
