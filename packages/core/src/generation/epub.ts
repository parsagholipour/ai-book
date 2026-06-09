import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { marked } from "marked";

const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const EPUB_CSS = `
body {
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.55;
  margin: 0 5%;
  color: #1a1a1a;
}
h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; page-break-after: avoid; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
hr { border: none; border-top: 1px solid #d7d7d7; margin: 1.5em 0; }
`;

export type GenerateBookEpubOptions = {
  title: string;
  author?: string | undefined;
  language?: string | undefined;
  imageStorageDir: string;
  publicApiUrl: string;
  outputPath?: string | undefined;
};

type EpubChapter = {
  id: string;
  title: string;
  fileName: string;
  xhtml: string;
};

type EpubImage = {
  id: string;
  fileName: string;
  mediaType: string;
  data: Buffer;
};

/**
 * Builds an EPUB 3 file from the compiled book markdown. Local illustration
 * assets referenced through the public API are packaged into the archive.
 */
export async function generateBookEpub(markdown: string, options: GenerateBookEpubOptions): Promise<Buffer> {
  const images = new Map<string, EpubImage>();
  const localizedMarkdown = await packageLocalImages(markdown, options, images);
  const chapters = splitIntoChapters(localizedMarkdown, options.title);
  const renderedChapters: EpubChapter[] = [];
  for (const [index, chapter] of chapters.entries()) {
    renderedChapters.push({
      id: `chapter-${index + 1}`,
      title: chapter.title,
      fileName: `chapter-${index + 1}.xhtml`,
      xhtml: chapterXhtml(chapter.title, await renderMarkdownToXhtml(chapter.markdown))
    });
  }

  const bookId = `urn:uuid:${randomUUID()}`;
  const language = normalizeEpubLanguage(options.language);
  const coverImage = [...images.values()][0];

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );
  zip.file("OEBPS/styles.css", EPUB_CSS);
  zip.file("OEBPS/nav.xhtml", navXhtml(options.title, renderedChapters));
  for (const chapter of renderedChapters) {
    zip.file(`OEBPS/${chapter.fileName}`, chapter.xhtml);
  }
  for (const image of images.values()) {
    zip.file(`OEBPS/${image.fileName}`, image.data);
  }
  zip.file(
    "OEBPS/content.opf",
    contentOpf({
      bookId,
      title: options.title,
      author: options.author,
      language,
      chapters: renderedChapters,
      images: [...images.values()],
      coverImageId: coverImage?.id
    })
  );

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });
  if (options.outputPath) {
    await writeFile(options.outputPath, bytes);
  }
  return bytes;
}

async function packageLocalImages(
  markdown: string,
  options: GenerateBookEpubOptions,
  images: Map<string, EpubImage>
): Promise<string> {
  const publicBase = options.publicApiUrl.replace(/\/+$/, "");
  let result = markdown;

  for (const match of markdown.matchAll(IMAGE_MARKDOWN_RE)) {
    const full = match[0];
    const alt = match[1] ?? "";
    const src = match[2] ?? "";
    const localPath = resolveImageLocalPath(src, options.imageStorageDir, publicBase);
    if (!localPath) {
      // Strip remote/unresolvable images so the EPUB never has broken refs.
      result = result.replace(full, "");
      continue;
    }
    try {
      let image = images.get(localPath);
      if (!image) {
        const data = await readFile(localPath);
        const index = images.size + 1;
        const extension = extname(localPath).toLowerCase() || ".png";
        image = {
          id: `image-${index}`,
          fileName: `images/image-${index}${extension}`,
          mediaType: MIME_BY_EXT[extension] ?? "application/octet-stream",
          data
        };
        images.set(localPath, image);
      }
      result = result.replace(full, `![${alt}](${image.fileName})`);
    } catch {
      result = result.replace(full, "");
    }
  }

  return result;
}

function resolveImageLocalPath(src: string, imageStorageDir: string, publicApiBase: string): string | null {
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
  return join(imageStorageDir, projectId, decodeURIComponent(filename));
}

function splitIntoChapters(markdown: string, bookTitle: string): Array<{ title: string; markdown: string }> {
  const lines = markdown.split("\n");
  const chapters: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } = { title: bookTitle, lines: [] };
  let inCodeFence = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
    }
    const heading = !inCodeFence ? line.match(/^##\s+(.+)$/) : null;
    if (heading) {
      if (current.lines.some((existing) => existing.trim().length > 0)) {
        chapters.push(current);
      }
      current = { title: heading[1]!.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((existing) => existing.trim().length > 0)) {
    chapters.push(current);
  }
  if (chapters.length === 0) {
    chapters.push({ title: bookTitle, lines: lines });
  }
  return chapters.map((chapter) => ({ title: chapter.title, markdown: chapter.lines.join("\n") }));
}

async function renderMarkdownToXhtml(markdown: string): Promise<string> {
  const html = await marked.parse(markdown, { async: true, gfm: true });
  return toXhtml(html);
}

/** Self-closes void elements so the output parses as XHTML. */
function toXhtml(html: string): string {
  return html
    .replace(/<(img|br|hr|input|meta|link)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/gi, "<$1$2 />")
    .replace(/&nbsp;/g, "&#160;");
}

function chapterXhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css" />
</head>
<body>
${body}
</body>
</html>`;
}

function navXhtml(bookTitle: string, chapters: EpubChapter[]): string {
  const items = chapters
    .map((chapter) => `      <li><a href="${chapter.fileName}">${escapeXml(chapter.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${escapeXml(bookTitle)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function contentOpf(options: {
  bookId: string;
  title: string;
  author: string | undefined;
  language: string;
  chapters: EpubChapter[];
  images: EpubImage[];
  coverImageId: string | undefined;
}): string {
  const manifestItems = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="css" href="styles.css" media-type="text/css"/>`,
    ...options.chapters.map(
      (chapter) => `    <item id="${chapter.id}" href="${chapter.fileName}" media-type="application/xhtml+xml"/>`
    ),
    ...options.images.map(
      (image) =>
        `    <item id="${image.id}" href="${image.fileName}" media-type="${image.mediaType}"${
          image.id === options.coverImageId ? ' properties="cover-image"' : ""
        }/>`
    )
  ].join("\n");
  const spineItems = options.chapters.map((chapter) => `    <itemref idref="${chapter.id}"/>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(options.bookId)}</dc:identifier>
    <dc:title>${escapeXml(options.title)}</dc:title>
    <dc:language>${escapeXml(options.language)}</dc:language>
    ${options.author ? `<dc:creator>${escapeXml(options.author)}</dc:creator>` : ""}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>`;
}

function normalizeEpubLanguage(language: string | undefined): string {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed) {
    return "en";
  }
  const candidate = trimmed.split(/[_\s]/)[0] ?? trimmed;
  return /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(candidate) ? candidate : "en";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
