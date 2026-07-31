import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { mdToPdf } from "md-to-pdf";

const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const require = createRequire(import.meta.url);
let cachedBookPdfFontCss: string | undefined;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const BOOK_PDF_CSS = `
  @page {
    size: A4;
    margin: 20mm 18mm 22mm;
    @bottom-center {
      content: "Page " counter(page);
      font-family: sans-serif;
      font-size: 8pt;
      color: #6b7280;
    }
  }
  @page pdf-cover {
    size: A4;
    margin: 0;
    @bottom-center {
      content: none;
    }
  }
  html,
  body {
    margin: 0;
    padding: 0;
  }
  body {
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #1a1a1a;
    max-width: 100%;
  }
  h1, h2, h3 {
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
  }
  h1 { font-size: 22pt; margin-top: 0; page-break-after: avoid; font-weight: 700; }
  h2 { font-size: 14pt; margin-top: 1.4em; page-break-after: avoid; font-weight: 700; }
  h3 { font-size: 12pt; page-break-after: avoid; font-weight: 700; }
  .book-contents {
    box-sizing: border-box;
    min-height: 245mm;
    padding: 22mm 8mm 14mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    color: #211a14;
    break-before: page;
    break-after: page;
    page-break-before: always;
    page-break-after: always;
  }
  .book-contents__eyebrow {
    margin: 0 0 0.65rem;
    text-align: center;
    font-family: "InterBook", "Segoe UI", system-ui, sans-serif;
    font-size: 8.5pt;
    font-weight: 700;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: #9a7448;
  }
  .book-contents h2 {
    margin: 0;
    text-align: center;
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 28pt;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .book-contents__ornament {
    width: 56mm;
    height: 1px;
    margin: 7mm auto 13mm;
    background: linear-gradient(90deg, transparent, #c9b79f 18%, #8b6f4e 50%, #c9b79f 82%, transparent);
  }
  .book-contents__list {
    list-style: none;
    margin: 0 auto;
    padding: 0;
    width: min(150mm, 100%);
  }
  .book-contents__item {
    margin: 0 0 7mm;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .book-contents__link {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(22mm, 42mm) max-content;
    column-gap: 3mm;
    align-items: end;
    color: inherit;
    text-decoration: none;
  }
  .book-contents__chapter {
    grid-column: 1 / 4;
    margin-bottom: 1.3mm;
    font-family: "InterBook", "Segoe UI", system-ui, sans-serif;
    font-size: 8pt;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #9a7448;
  }
  .book-contents__name {
    grid-column: 1;
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 13.5pt;
    line-height: 1.25;
  }
  .book-contents__leader {
    grid-column: 2;
    border-bottom: 1px dotted #b7a38a;
    transform: translateY(-1.8mm);
  }
  .book-contents__page {
    grid-column: 3;
    min-width: 7mm;
    text-align: right;
    font-family: "SourceSerifBook", Georgia, "Times New Roman", serif;
    font-size: 11pt;
    color: #6f5842;
  }
  .book-contents--compact,
  .book-contents--dense {
    justify-content: flex-start;
    padding-top: 16mm;
  }
  .book-contents--compact .book-contents__ornament,
  .book-contents--dense .book-contents__ornament {
    margin-bottom: 9mm;
  }
  .book-contents--compact .book-contents__item {
    margin-bottom: 4.5mm;
  }
  .book-contents--dense h2 {
    font-size: 24pt;
  }
  .book-contents--dense .book-contents__item {
    margin-bottom: 3mm;
  }
  .book-contents--dense .book-contents__chapter {
    margin-bottom: 0.7mm;
    font-size: 7.2pt;
  }
  .book-contents--dense .book-contents__name {
    font-size: 11.2pt;
  }
  img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1em auto;
    page-break-inside: avoid;
  }
  pre, code { font-family: ui-monospace, monospace; font-size: 9pt; }
  a { color: #2563eb; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
  .page-break { break-after: page; page-break-after: always; }
  .pdf-cover-page {
    page: pdf-cover;
    width: 210mm;
    height: 297mm;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #fff;
    break-after: page;
    page-break-after: always;
  }
  .pdf-cover-page img {
    width: 100%;
    height: 100%;
    max-width: none;
    margin: 0;
    object-fit: cover;
  }
`;

export type GenerateBookPdfOptions = {
  imageStorageDir: string;
  publicApiUrl: string;
  outputPath?: string | undefined;
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
  const css = `${await loadBookPdfFontCss()}\n${BOOK_PDF_CSS}`;

  const result = await mdToPdf(
    { content: `<style>${css}</style>\n\n${prepared.markdown}` },
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
      script:
        prepared.imageDataUrls.size > 0
          ? [{ content: buildEmbedLocalImagesScript(prepared.imageDataUrls) }]
          : [],
      basedir: options.imageStorageDir
    }
  );

  if (!result?.content) {
    throw new Error("PDF generation returned no content");
  }

  return Buffer.from(result.content);
}

async function loadBookPdfFontCss(): Promise<string> {
  if (cachedBookPdfFontCss) {
    return cachedBookPdfFontCss;
  }

  const fonts = await Promise.all([
    fontFace(
      "SourceSerifBook",
      "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2",
      "200 900",
      "normal"
    ),
    fontFace(
      "SourceSerifBook",
      "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2",
      "200 900",
      "italic"
    ),
    fontFace("InterBook", "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "100 900", "normal")
  ]);
  cachedBookPdfFontCss = fonts.join("\n");
  return cachedBookPdfFontCss;
}

async function fontFace(family: string, specifier: string, weight: string, style: "normal" | "italic"): Promise<string> {
  const fontPath = require.resolve(specifier);
  const bytes = await readFile(fontPath);
  return `@font-face {
  font-family: "${family}";
  src: url("data:font/woff2;base64,${bytes.toString("base64")}") format("woff2");
  font-weight: ${weight};
  font-style: ${style};
  font-display: block;
}`;
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
