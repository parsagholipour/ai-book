import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import sharp from "sharp";
import { imageMarkdownRe, leadingCoverIllustration, resolveBookImageAsset } from "./bookImageAssets.js";
import { findFigureFences, type FigureFence } from "./figures/figureBlocks.js";
import { figureSvg } from "./figures/figureHtml.js";
import type { FigureSpec } from "./figures/figureSpec.js";
import type { FigureRenderContext } from "./figures/figureSvgShared.js";

/**
 * What the Word export takes out of the compiled markdown before marked sees
 * it, and the pictures it embeds.
 *
 * The compiler writes four things as raw HTML that the PDF and EPUB render as
 * markup and a Word document cannot: the title page, the matter sheet (the
 * dedication and publication details), the Contents with its dotted leaders,
 * and the `<a id="chapter-N"></a>` destinations the Contents links to.
 * `prepareDocxSource` reads the first two back into fields and drops the Contents.
 * Chapter anchors survive until the token walk identifies their headings, then
 * become bookmarks. The document rebuilds its own Contents only when the compiler printed one
 * (`contents`) — and cuts the manuscript around every figure block, so the
 * JSON of a figure is never lexed as prose.
 *
 * Nothing here renders HTML, which is the whole of this export's answer to the
 * `stripEmbeddedDocuments` concern: a manuscript is user text, and the one
 * active thing it can still smuggle into a Word file is a hyperlink target, so
 * `externalLinkTarget` admits three schemes and prints everything else as words.
 */

export type DocxTitlePage = {
  title: string;
  subtitle: string | undefined;
  byline: string | undefined;
  /** The line at the title page's foot — the free tier's credit when no matter sheet holds it. */
  imprint?: string | undefined;
};

export type DocxMatterSheet = {
  /** Paragraphs; a line break inside one is a `\n`. */
  dedication: string[];
  publication: string[];
  credit: string | undefined;
};

export type DocxSegment = { kind: "markdown"; text: string } | { kind: "figure"; fence: FigureFence };

export type DocxSource = {
  cover: { alt: string; src: string } | undefined;
  titlePage: DocxTitlePage | undefined;
  matterSheet: DocxMatterSheet | undefined;
  /**
   * Whether the compiler printed a Contents. It writes one only for a book
   * long enough to be set in chapters (`chapterPresentationFor`), so this —
   * not a count of `##` headings, which the Sources and About the Author have
   * too — is what decides whether the Word file prints one.
   */
  contents: boolean;
  segments: DocxSegment[];
};

const TITLE_PAGE_OPEN_RE = /^<section\b[^>]*class=["'][^"']*\bbook-title-page\b/i;
const CONTENTS_OPEN_RE = /^<section\b[^>]*class=["'][^"']*\bbook-contents\b/i;
const MATTER_SHEET_OPEN_RE = /^<section\b[^>]*class=["'][^"']*\bbook-matter-sheet\b/i;
const SECTION_CLOSE_RE = /^<\/section>\s*$/i;

export function docxChapterAnchorId(markup: string): string | undefined {
  return /^<a\s+id=(["'])(chapter-[a-z0-9_-]+)\1><\/a>\s*$/i.exec(markup)?.[2];
}

function unescapeHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** A title page as read, with the publication lines its foot carries (`bookMatterPages.ts`). */
type ReadTitlePage = { page: DocxTitlePage; publication: string[] };

function titlePageFrom(section: string): ReadTitlePage | undefined {
  const title = section.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (title === undefined) {
    return undefined;
  }
  const subtitle = section.match(/<p\b[^>]*\bbook-title-page__subtitle\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const byline = section.match(/<p\b[^>]*\bbook-title-page__byline\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const imprint = section.match(/<p\b[^>]*\bbook-title-page__imprint\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const page: DocxTitlePage = {
    title: unescapeHtml(title),
    subtitle: subtitle === undefined ? undefined : unescapeHtml(subtitle) || undefined,
    byline: byline === undefined ? undefined : unescapeHtml(byline) || undefined,
    ...(imprint === undefined ? {} : { imprint: unescapeHtml(imprint) || undefined })
  };
  const publication = blockParagraphs(section, "book-title-page__publication")
    .filter((paragraph) => !paragraph.className.includes("book-title-page__imprint"))
    .map((paragraph) => paragraph.text);
  return { page, publication };
}

/** The `<p>`s of one `<div class="…__name">` inside the matter sheet, each with its class. */
function matterParagraphs(section: string, name: string): Array<{ text: string; className: string }> {
  return blockParagraphs(section, `book-matter-sheet__${name}`);
}

/** The `<p>`s of the compiler's `<div class="className">`, each with its class; its `<p>`s hold no `<div>`. */
function blockParagraphs(section: string, className: string): Array<{ text: string; className: string }> {
  const block = section.match(new RegExp(`<div\\b[^>]*\\b${className}\\b[^>]*>([\\s\\S]*?)<\\/div>`, "i"))?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
    .map((match) => ({ text: unescapeHtml(match[2] ?? ""), className: match[1] ?? "" }))
    .filter((paragraph) => paragraph.text);
}

function matterSheetFrom(section: string): DocxMatterSheet | undefined {
  const publication = matterParagraphs(section, "publication");
  const credit = publication.find((paragraph) => paragraph.className.includes("book-matter-sheet__credit"));
  const sheet: DocxMatterSheet = {
    dedication: matterParagraphs(section, "dedication").map((paragraph) => paragraph.text),
    publication: publication.filter((paragraph) => paragraph !== credit).map((paragraph) => paragraph.text),
    credit: credit?.text
  };
  return sheet.dedication.length + sheet.publication.length > 0 || sheet.credit ? sheet : undefined;
}

/**
 * Strips the compiler's HTML furniture, fence-aware. A line that opens a
 * fence toggles the scan off, so a code sample about the book's own markup is
 * printed rather than consumed.
 */
function stripFurniture(markdown: string): {
  text: string;
  titlePage: DocxTitlePage | undefined;
  matterSheet: DocxMatterSheet | undefined;
  contents: boolean;
} {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let titlePage: ReadTitlePage | undefined;
  let matterSheet: DocxMatterSheet | undefined;
  let contents = false;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^[ \t]{0,3}```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    if (TITLE_PAGE_OPEN_RE.test(line) || CONTENTS_OPEN_RE.test(line) || MATTER_SHEET_OPEN_RE.test(line)) {
      const isTitlePage = TITLE_PAGE_OPEN_RE.test(line);
      const isMatterSheet = MATTER_SHEET_OPEN_RE.test(line);
      if (CONTENTS_OPEN_RE.test(line)) contents = true;
      const section: string[] = [line];
      while (index + 1 < lines.length && !SECTION_CLOSE_RE.test(lines[index]!)) {
        index += 1;
        section.push(lines[index]!);
      }
      if (isTitlePage && !titlePage) {
        titlePage = titlePageFrom(section.join("\n"));
      }
      if (isMatterSheet && !matterSheet) {
        matterSheet = matterSheetFrom(section.join("\n"));
      }
      continue;
    }
    if (docxChapterAnchorId(line)) {
      // The compiler can join an anchor directly after the previous page's
      // prose. Give it its own token without changing any rendered paragraphs.
      kept.push("", line, "");
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), ...wordFrontMatter(titlePage, matterSheet), contents };
}

/**
 * The Word file's front matter, which kept its own layout when the PDF moved
 * the publication lines to the title page's foot (2026-10-17): the title page
 * holds the title, subtitle and byline, and a page of its own the dedication
 * and the publication lines, the credit with them — or at the title page's
 * foot when that page would be empty. A DOCX import recognises our title page
 * only when every line on it is the title, subtitle, byline or publisher
 * (`manuscriptMatter.ts`), so © lines there would come back as book text. A
 * book compiled before the move carries the old sections and reads the same.
 */
function wordFrontMatter(
  read: ReadTitlePage | undefined,
  sheet: DocxMatterSheet | undefined
): { titlePage: DocxTitlePage | undefined; matterSheet: DocxMatterSheet | undefined } {
  if (!read) return { titlePage: undefined, matterSheet: sheet };
  const dedication = sheet?.dedication ?? [];
  const publication = [...read.publication, ...(sheet?.publication ?? [])];
  const credit = sheet?.credit ?? (dedication.length + publication.length > 0 ? read.page.imprint : undefined);
  if (dedication.length + publication.length === 0 && !credit) return { titlePage: read.page, matterSheet: undefined };
  const { title, subtitle, byline } = read.page;
  return {
    titlePage: credit === read.page.imprint ? { title, subtitle, byline } : read.page,
    matterSheet: { dedication, publication, credit }
  };
}

/** The manuscript cut around its figures, with the front matter read off. */
export function prepareDocxSource(markdown: string, options: { extractCover?: boolean } = {}): DocxSource {
  const cover = options.extractCover === false ? undefined : leadingCoverIllustration(markdown);
  const body = cover ? cover.rest : markdown;
  const { text, titlePage, matterSheet, contents } = stripFurniture(body);
  const segments: DocxSegment[] = [];
  let cursor = 0;
  for (const fence of findFigureFences(text)) {
    if (fence.start > cursor) {
      segments.push({ kind: "markdown", text: text.slice(cursor, fence.start) });
    }
    segments.push({ kind: "figure", fence });
    cursor = fence.end;
  }
  if (cursor < text.length) {
    segments.push({ kind: "markdown", text: text.slice(cursor) });
  }
  return {
    cover: cover ? { alt: cover.alt, src: cover.src } : undefined,
    titlePage,
    matterSheet,
    contents,
    segments
  };
}

/** A picture ready for `ImageRun`: a format Word accepts, at its pixel size. */
export type DocxImage = {
  type: "png" | "jpg" | "gif" | "bmp";
  data: Buffer;
  width: number;
  height: number;
};

/**
 * The text block of the page, in pixels at 96 dpi: A4 less the 18 mm side
 * margins `docxSection` sets. Every picture is scaled to fit inside it.
 */
export const DOCX_TEXT_WIDTH_PX = 656;
/** Leaves room under a full-height picture for its caption. */
export const DOCX_IMAGE_MAX_HEIGHT_PX = 880;

const PASSTHROUGH_TYPES: Record<string, DocxImage["type"]> = {
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".gif": "gif",
  ".bmp": "bmp"
};

export function fitImage(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) {
    return { width: 1, height: 1 };
  }
  let scale = Math.min(1, DOCX_TEXT_WIDTH_PX / width);
  scale = Math.min(scale, DOCX_IMAGE_MAX_HEIGHT_PX / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Reads one illustration into the shape Word accepts. PNG, JPEG, GIF and BMP
 * pass through as they are; anything else — WebP, SVG, AVIF — is re-encoded as
 * PNG, because `ImageRun` takes those four and nothing more. Null when the bytes
 * cannot be read as a picture at all.
 */
export async function docxImageFromBytes(bytes: Buffer, extension: string): Promise<DocxImage | null> {
  try {
    const passthrough = PASSTHROUGH_TYPES[extension.toLowerCase()];
    if (passthrough) {
      const metadata = await sharp(bytes).metadata();
      return { type: passthrough, data: bytes, ...fitImage(metadata.width ?? 0, metadata.height ?? 0) };
    }
    const png = await sharp(bytes, { density: 192 }).png().toBuffer();
    const metadata = await sharp(png).metadata();
    return { type: "png", data: png, ...fitImage(metadata.width ?? 0, metadata.height ?? 0) };
  } catch {
    return null;
  }
}

export type DocxImageAssetOptions = {
  imageStorageDir: string;
  publicApiUrl: string;
  projectId?: string | undefined;
};

/**
 * Every local illustration the manuscript references, keyed by the `src` it was
 * written with, read once per file in first-appearance order.
 *
 * Containment is the resolver's: `resolveBookImageAsset` decodes before it
 * resolves and admits exactly `<imageStorageDir>/<projectId>/<filename>`, and
 * `projectId` narrows that to this book's own directory. Remote, unresolvable
 * and unreadable pictures are absent from the map, so the document ships no
 * broken reference.
 */
export async function loadDocxImageAssets(
  markdown: string,
  options: DocxImageAssetOptions
): Promise<Map<string, DocxImage>> {
  const publicApiBase = options.publicApiUrl.replace(/\/+$/, "");
  const localPathFor = (src: string) =>
    resolveBookImageAsset(src, {
      imageStorageDir: options.imageStorageDir,
      publicApiBase,
      projectId: options.projectId
    })?.localPath ?? null;

  const sources = new Map<string, string>();
  for (const match of markdown.matchAll(imageMarkdownRe())) {
    const src = match[2] ?? "";
    const localPath = localPathFor(src);
    if (localPath && !sources.has(src)) {
      sources.set(src, localPath);
    }
  }

  const byPath = new Map<string, Promise<DocxImage | null>>();
  for (const localPath of new Set(sources.values())) {
    byPath.set(
      localPath,
      readFile(localPath)
        .then((bytes) => docxImageFromBytes(bytes, extname(localPath)))
        .catch(() => null)
    );
  }

  const images = new Map<string, DocxImage>();
  for (const [src, localPath] of sources) {
    const image = await byPath.get(localPath);
    if (image) {
      images.set(src, image);
    }
  }
  return images;
}

/**
 * A figure drawn as a PNG through sharp's librsvg, or null when it cannot be.
 *
 * The SVG names the PDF's embedded display face, which no rasteriser outside
 * Chrome can see, so labels are set in whatever fontconfig substitutes. A
 * figure that fails here is printed as its stand-in sentence, never a failed
 * export.
 */
export async function rasterizeFigure(spec: FigureSpec, context: FigureRenderContext): Promise<DocxImage | null> {
  try {
    const svg = Buffer.from(figureSvg(spec, context), "utf8");
    const png = await sharp(svg, { density: 192 }).png().toBuffer();
    const metadata = await sharp(png).metadata();
    return { type: "png", data: png, ...fitImage(metadata.width ?? 0, metadata.height ?? 0) };
  } catch {
    return null;
  }
}

/**
 * The link targets a Word file may carry. Everything else — `javascript:`,
 * `data:`, `file:`, a bare fragment, a relative path into nowhere — is printed
 * as its text alone.
 */
export function externalLinkTarget(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
}
