import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { mdToPdf } from "md-to-pdf";
import { scriptProfileForLanguage, type ScriptProfile } from "../prompting/script.js";
import { bookFontSetForLanguage, type BookFontSet } from "./bookFonts.js";
import { codePointsOf, embedFontFaceCss } from "./fontEmbedding.js";
import { bookPdfCss } from "./pdfCss.js";

const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};


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
};

export type PreparedMarkdownForPdf = {
  markdown: string;
  imageDataUrls: ReadonlyMap<string, string>;
};

export async function localizeImagesInMarkdown(
  markdown: string,
  options: { imageStorageDir: string; publicApiUrl: string }
): Promise<string> {
  return (await prepareMarkdownImagesForPdf(markdown, options)).markdown;
}

export async function prepareMarkdownForPdfDocument(
  markdown: string,
  options: { imageStorageDir: string; publicApiUrl: string }
): Promise<PreparedMarkdownForPdf> {
  const prepared = await prepareMarkdownImagesForPdf(markdown, options);
  return {
    markdown: insertCoverPageBreak(prepared.markdown),
    imageDataUrls: prepared.imageDataUrls
  };
}

async function prepareMarkdownImagesForPdf(
  markdown: string,
  options: { imageStorageDir: string; publicApiUrl: string }
): Promise<PreparedMarkdownForPdf> {
  const publicBase = options.publicApiUrl.replace(/\/+$/, "");
  let result = markdown;
  const imageDataUrls = new Map<string, string>();

  for (const match of markdown.matchAll(IMAGE_MARKDOWN_RE)) {
    const full = match[0];
    const alt = match[1] ?? "";
    const src = match[2] ?? "";
    const localPath = resolveImageLocalPath(src, options.imageStorageDir, publicBase);
    if (!localPath) {
      continue;
    }

    try {
      const assetPath = markdownAssetPathForLocalImage(localPath, options.imageStorageDir);
      if (!assetPath) {
        continue;
      }
      imageDataUrls.set(assetPath, await imageDataUrlForLocalPath(localPath));
      result = result.replace(full, `![${alt}](${assetPath})`);
    } catch {
      // Keep the original URL when the local file cannot be embedded.
    }
  }

  return {
    markdown: result,
    imageDataUrls
  };
}

export async function prepareMarkdownForPdf(
  markdown: string,
  options: { imageStorageDir: string; publicApiUrl: string }
): Promise<string> {
  return (await prepareMarkdownForPdfDocument(markdown, options)).markdown;
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
    publicApiUrl: options.publicApiUrl
  });
  const profile = scriptProfileForLanguage(options.language);
  const fontCss = await loadBookPdfFontCss(bookFontSetForLanguage(options.language), prepared.markdown);
  const css = `${fontCss}\n${bookPdfCss(profile)}`;

  const result = await mdToPdf(
    // The stylesheet rides on the `css` option alone. It used to also be
    // inlined into the content, and md-to-pdf applies `css` last and wins —
    // so the copy was pure waste, and a CJK book's fonts would have put
    // megabytes of it into the DOM twice.
    { content: prepared.markdown },
    {
      ...(options.outputPath ? { dest: options.outputPath } : {}),
      pdf_options: {
        format: "a4",
        printBackground: true,
        // Chapter and page headings become PDF bookmarks, which is what the
        // mobile reader's table of contents navigates by. Books compiled
        // before this was added have no outline; the reader falls back to the
        // Contents page links.
        outline: true
      },
      css,
      launch_options: {
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      },
      script: [
        // md-to-pdf's HTML wrapper is fixed and carries no `lang` or `dir`.
        // The direction itself comes from CSS, which is bidi-equivalent; this
        // is for what CSS cannot reach — Chrome copies `lang` into the PDF's
        // own `/Lang`, and `dir` adds the UA's root bidi isolation.
        ...(isDefaultLatinProfile(profile) ? [] : [{ content: buildDocumentLanguageScript(profile) }]),
        ...(prepared.imageDataUrls.size > 0
          ? [{ content: buildEmbedLocalImagesScript(prepared.imageDataUrls) }]
          : [])
      ],
      basedir: options.imageStorageDir
    }
  );

  if (!result?.content) {
    throw new Error("PDF generation returned no content");
  }

  return Buffer.from(result.content);
}

/**
 * The `@font-face` rules for the two families `BOOK_PDF_CSS` names. Only the
 * faces covering characters the book actually contains are embedded, which is
 * what keeps a Chinese book — 101 available subsets — to a few megabytes.
 */
function loadBookPdfFontCss(fontSet: BookFontSet, markdown: string): Promise<string> {
  const codePoints = codePointsOf(markdown);
  return embedFontFaceCss([
    { family: "SourceSerifBook", packages: fontSet.body, codePoints },
    { family: "InterBook", packages: fontSet.display, codePoints }
  ]);
}

function isDefaultLatinProfile(profile: ScriptProfile): boolean {
  return profile.script === "latin" && profile.direction === "ltr" && profile.code === "en";
}

function buildDocumentLanguageScript(profile: ScriptProfile): string {
  return `(() => {
  document.documentElement.lang = ${JSON.stringify(profile.code)};
  document.documentElement.dir = ${JSON.stringify(profile.direction)};
})();`;
}

function resolveImageLocalPath(
  src: string,
  imageStorageDir: string,
  publicApiBase: string
): string | null {
  let pathPart = src.trim();
  if (pathPart.startsWith(publicApiBase)) {
    pathPart = pathPart.slice(publicApiBase.length);
  }

  const match = pathPart.match(/\/assets\/images\/([^/]+)\/([^)\s]+)/);
  if (!match) {
    return null;
  }

  const projectId = match[1];
  const filename = match[2];
  if (!projectId || !filename) {
    return null;
  }
  return join(imageStorageDir, projectId, filename);
}

function markdownAssetPathForLocalImage(localPath: string, imageStorageDir: string): string | null {
  const relativePath = relative(imageStorageDir, localPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.split(sep).map(encodeURIComponent).join("/");
}

async function imageDataUrlForLocalPath(localPath: string): Promise<string> {
  const bytes = await readFile(localPath);
  return `data:${mimeTypeForPath(localPath)};base64,${bytes.toString("base64")}`;
}

function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function buildEmbedLocalImagesScript(imageDataUrls: ReadonlyMap<string, string>): string {
  const entries = JSON.stringify([...imageDataUrls.entries()]);
  return `(() => {
  const imageDataUrls = new Map(${entries});
  for (const image of document.images) {
    const src = image.getAttribute("src") || "";
    const dataUrl = imageDataUrls.get(src);
    if (dataUrl) {
      image.setAttribute("src", dataUrl);
    }
  }
})();`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
