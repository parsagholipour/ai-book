import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scriptProfileForLanguage, type ScriptProfile } from "../prompting/script.js";
import { resolveBookImageAsset } from "./bookImageAssets.js";
import { withRenderPage } from "./browserPool.js";
import { renderDocumentTempPath } from "./exportTempSweep.js";
import { bookFontSetForLanguage, type BookFontSet } from "./bookFonts.js";
import { codePointsOf, embedFontFaceCss } from "./fontEmbedding.js";
import { bookPdfCss } from "./pdfCss.js";
import { BOOK_PDF_MEDIA_TYPE, BOOK_PDF_OPTIONS, buildBookPdfDocument } from "./pdfDocument.js";
import { applyRenderResourcePolicy } from "./renderResourcePolicy.js";

const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

export type GenerateBookPdfOptions = {
  imageStorageDir: string;
  publicApiUrl: string;
  outputPath?: string | undefined;
  /**
   * The book's language, in any of the shapes `Project.language` holds ("fa",
   * "Farsi", "Persian"). It picks the embedded fonts and the text direction —
   * without it a Persian book has no Arabic glyphs to render with.
   */
  language?: string | undefined;
  /**
   * The project being compiled. It narrows the files the renderer may read to
   * that project's own illustrations, the way `sendOwnedProjectAsset` narrows
   * the HTTP asset route — printing from `file://` is what dropped that check.
   * Without it the whole image storage directory is readable, which is the
   * fallback for callers that render a book belonging to no project.
   */
  projectId?: string | undefined;
};

type PdfImageOptions = { imageStorageDir: string; publicApiUrl: string; projectId?: string | undefined };

export async function localizeImagesInMarkdown(markdown: string, options: PdfImageOptions): Promise<string> {
  return prepareMarkdownImagesForPdf(markdown, options);
}

export async function prepareMarkdownForPdfDocument(
  markdown: string,
  options: PdfImageOptions
): Promise<string> {
  return insertCoverPageBreak(await prepareMarkdownImagesForPdf(markdown, options));
}

/**
 * Rewrites every local illustration to the path the renderer reads it from.
 *
 * The path is relative, and the document is printed from a file inside
 * `imageStorageDir`, so Chrome opens each illustration directly off disk. The
 * bytes used to be read here, base64'd, and shipped into the page as a data-URI
 * map — a second copy of every image on top of the one the renderer already had.
 *
 * Only existence is checked, and all the checks run together: an image whose
 * file is gone keeps its original URL rather than being pointed at a path that
 * is not there either. The rewrite is a single `replace` pass with a function
 * replacer, so it is linear in the document rather than one full-text scan per
 * image, and a `$&` or `$'` in alt text can no longer rewrite itself.
 */
async function prepareMarkdownImagesForPdf(
  markdown: string,
  options: PdfImageOptions
): Promise<string> {
  const publicApiBase = options.publicApiUrl.replace(/\/+$/, "");
  // Another project's illustration is refused here as well as at the renderer's
  // allowlist, so the document never names a file the render is going to abort —
  // and the EPUB, which has no renderer to stop it, is refusing the same thing in
  // the same place.
  const resolve = (src: string) =>
    resolveBookImageAsset(src, {
      imageStorageDir: options.imageStorageDir,
      publicApiBase,
      projectId: options.projectId
    });

  const localPaths = new Map<string, string>();
  for (const match of markdown.matchAll(IMAGE_MARKDOWN_RE)) {
    const resolved = resolve(match[2] ?? "");
    if (resolved) {
      localPaths.set(resolved.assetPath, resolved.localPath);
    }
  }

  const readable = new Set<string>();
  await Promise.all(
    [...localPaths].map(async ([assetPath, localPath]) => {
      try {
        await access(localPath, constants.R_OK);
        readable.add(assetPath);
      } catch {
        // Leave it out; the rewrite below keeps the original URL.
      }
    })
  );

  return markdown.replace(IMAGE_MARKDOWN_RE, (full: string, alt: string, src: string) => {
    const resolved = resolve(src);
    return resolved && readable.has(resolved.assetPath) ? `![${alt}](${resolved.assetPath})` : full;
  });
}

export function insertCoverPageBreak(markdown: string): string {
  if (/^<div\b[^>]*class=["'][^"']*\bpdf-cover-page\b/i.test(markdown.trimStart())) {
    return markdown;
  }

  const leadingImage = markdown.match(/^!\[([^\]]*)]\(([^)]+)\)(\s*)/);
  if (!leadingImage) {
    return markdown;
  }
  const full = leadingImage[0] ?? "";
  const alt = leadingImage[1] ?? "";
  const src = leadingImage[2] ?? "";
  let rest = markdown.slice(full.length).trimStart();
  rest = rest.replace(/^<div\b[^>]*class=["'][^"']*\bpage-break\b[^>]*>\s*<\/div>\s*/i, "");

  const altAttribute = escapeHtmlAttribute(alt);
  const cover = [
    `<div class="pdf-cover-page" aria-label="${altAttribute || "Book cover"}">`,
    `  <img src="${escapeHtmlAttribute(src)}" alt="${altAttribute}" />`,
    "</div>"
  ].join("\n");
  return rest ? `${cover}\n\n${rest}` : cover;
}

export async function generateBookPdf(
  markdown: string,
  options: GenerateBookPdfOptions
): Promise<Buffer> {
  const prepared = await prepareMarkdownForPdfDocument(markdown, {
    imageStorageDir: options.imageStorageDir,
    publicApiUrl: options.publicApiUrl,
    projectId: options.projectId
  });
  const profile = scriptProfileForLanguage(options.language);
  const fontCss = await loadBookPdfFontCss(bookFontSetForLanguage(options.language), prepared, profile);
  const html = await buildBookPdfDocument({
    markdown: prepared,
    css: `${fontCss}\n${bookPdfCss(profile)}`,
    profile
  });

  const pdf = await renderPdfDocument(html, {
    imageStorageDir: options.imageStorageDir,
    assetRoot: options.projectId
      ? join(options.imageStorageDir, options.projectId)
      : options.imageStorageDir
  });
  if (options.outputPath) {
    await writeFile(options.outputPath, pdf);
  }
  return pdf;
}

/**
 * Prints an assembled document, handing Chrome a real file on disk.
 *
 * The document is written *into* `imageStorageDir` so the book's relative asset
 * paths (`projectId/filename`) resolve against it exactly as they resolved
 * against md-to-pdf's static server — except Chrome now reads the HTML, the CSS
 * and every illustration straight off disk, so nothing crosses CDP at all. That
 * is what removes the pathological exports: `addStyleTag`/`addScriptTag` take no
 * timeout, and a legacy illustrated book was shipping a ~27 MB JSON image map
 * through one of them.
 *
 * The file is not web-reachable. `/assets/images/:projectId/:filename` is a
 * two-segment parameter route rather than a static mount, so nothing at the root
 * of the directory can be fetched.
 *
 * What a `file://` document *can* reach is the rest of the disk, which is the
 * one thing the static server used to prevent — hence the resource policy below.
 */
async function renderPdfDocument(
  html: string,
  options: { imageStorageDir: string; assetRoot: string }
): Promise<Buffer> {
  await mkdir(options.imageStorageDir, { recursive: true });
  const documentPath = renderDocumentTempPath(options.imageStorageDir);
  await writeFile(documentPath, html, "utf8");

  try {
    // `withRenderPage` owns the one retry a shared browser needs, so the temp
    // document has to outlive it — hence the `finally` rather than a cleanup
    // inside the render.
    return await printDocument(documentPath, options.assetRoot);
  } finally {
    // Covers every way this call can end except the ones where no code of ours
    // runs at all: a SIGKILL, an OOM kill, a container evicted mid-render.
    // `sweepStaleExportTempFiles` collects what those leave behind.
    await rm(documentPath, { force: true }).catch(() => undefined);
  }
}

function printDocument(documentPath: string, assetRoot: string): Promise<Buffer> {
  return withRenderPage(async (page) => {
    // Manuscripts are content, never programs. Disabling script before the
    // first navigation is the only way to cover windows a document might open:
    // request interception is installed per page, after a popup's first
    // navigation has already begun. Puppeteer's own `evaluate` calls below
    // still run through CDP with page JavaScript disabled.
    await page.setJavaScriptEnabled(false);
    // Before the navigation, because the navigation is one of the things it
    // governs: this document, and this book's illustrations, and nothing else.
    await applyRenderResourcePolicy(page, { documentPath, assetRoot });
    await page.goto(pathToFileURL(documentPath).href, { waitUntil: "load" });
    // Replaces md-to-pdf's `networkidle0` wait, which was a hard ≥500 ms floor
    // and the only thing sequencing web fonts and image decode before the
    // print. `page.pdf()` waits on `document.fonts.ready` itself in puppeteer
    // 25, so the fonts are double-covered — the explicit wait stays so that the
    // image decode is ordered after them, and so the sequencing is visible here
    // rather than in a dependency's default.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
    });
    await page.emulateMediaType(BOOK_PDF_MEDIA_TYPE);
    return Buffer.from(await page.pdf(BOOK_PDF_OPTIONS));
  });
}

/**
 * The `@font-face` rules for the two families `BOOK_PDF_CSS` names. Only the
 * faces covering characters the book actually contains are embedded, which is
 * what keeps a Chinese book — 101 available subsets — to a few megabytes.
 */
function loadBookPdfFontCss(fontSet: BookFontSet, markdown: string, profile: ScriptProfile): Promise<string> {
  // The footer's digits come from the script profile rather than from the book
  // text, so a Persian book that happens to write every number out in words
  // still has to carry the faces that can draw "۱۲" at the foot of the page.
  const codePoints = codePointsOf(markdown, profile.numerals ?? "");
  return embedFontFaceCss([
    { family: "SourceSerifBook", packages: fontSet.body, codePoints },
    { family: "InterBook", packages: fontSet.display, codePoints }
  ]);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
