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
 * The compiler writes three things as raw HTML that the PDF and EPUB render as
 * markup and a Word document cannot: the coverless title page, the Contents
 * with its dotted leaders, and the `<a id="chapter-N"></a>` destinations the
 * Contents links to. `prepareDocxSource` reads the first back into fields,
 * drops the other two — the document rebuilds its own Contents from the chapter
 * headings and bookmarks them itself — and cuts the manuscript around every
 * figure block, so the JSON of a figure is never lexed as prose.
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
};

export type DocxSegment = { kind: "markdown"; text: string } | { kind: "figure"; fence: FigureFence };

export type DocxSource = {
  cover: { alt: string; src: string } | undefined;
  titlePage: DocxTitlePage | undefined;
  segments: DocxSegment[];
};

const TITLE_PAGE_OPEN_RE = /^<section\b[^>]*class=["'][^"']*\bbook-title-page\b/i;
const CONTENTS_OPEN_RE = /^<section\b[^>]*class=["'][^"']*\bbook-contents\b/i;
const SECTION_CLOSE_RE = /^<\/section>\s*$/i;
const CHAPTER_ANCHOR_RE = /^<a\s+id=(["'])chapter-[a-z0-9-]+\1><\/a>\s*$/i;

function unescapeHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function titlePageFrom(section: string): DocxTitlePage | undefined {
  const title = section.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (title === undefined) {
    return undefined;
  }
  const subtitle = section.match(/<p\b[^>]*\bbook-title-page__subtitle\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const byline = section.match(/<p\b[^>]*\bbook-title-page__byline\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  return {
    title: unescapeHtml(title),
    subtitle: subtitle === undefined ? undefined : unescapeHtml(subtitle) || undefined,
    byline: byline === undefined ? undefined : unescapeHtml(byline) || undefined
  };
}

/**
 * Strips the compiler's HTML furniture, fence-aware. A line that opens a
 * fence toggles the scan off, so a code sample about the book's own markup is
 * printed rather than consumed.
 */
function stripFurniture(markdown: string): { text: string; titlePage: DocxTitlePage | undefined } {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let titlePage: DocxTitlePage | undefined;
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
    if (TITLE_PAGE_OPEN_RE.test(line) || CONTENTS_OPEN_RE.test(line)) {
      const isTitlePage = TITLE_PAGE_OPEN_RE.test(line);
      const section: string[] = [line];
      while (index + 1 < lines.length && !SECTION_CLOSE_RE.test(lines[index]!)) {
        index += 1;
        section.push(lines[index]!);
      }
      if (isTitlePage && !titlePage) {
        titlePage = titlePageFrom(section.join("\n"));
      }
      continue;
    }
    if (CHAPTER_ANCHOR_RE.test(line)) {
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), titlePage };
}

/** The manuscript cut around its figures, with the front matter read off. */
export function prepareDocxSource(markdown: string): DocxSource {
  const cover = leadingCoverIllustration(markdown);
  const body = cover ? cover.rest : markdown;
  const { text, titlePage } = stripFurniture(body);
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
