import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { marked } from "marked";
import { scriptProfileForLanguage, type ScriptProfile } from "../prompting/script.js";
import { resolveBookImageAsset } from "./bookImageAssets.js";
import { markdownLabels } from "./markdown.js";
import { stripEmbeddedDocuments } from "./pdfDocument.js";

const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

/**
 * Reader fonts, not embedded ones: every mainstream reading system ships faces
 * for these scripts and resolves `serif` per script, readers expect to change
 * the reading font, and a CJK face would add megabytes to every file. Naming
 * `Georgia` first for a non-Latin book is the one thing worth avoiding — a
 * Latin-only face at the head of the stack makes some readers fall back per
 * character instead of picking one face for the run.
 */
function epubCss(profile: ScriptProfile): string {
  const stack =
    profile.script === "latin"
      ? `Georgia, "Times New Roman", serif`
      : `"Vazirmatn", "Noto Naskh Arabic", "Noto Serif", serif`;
  return `
html, body {
  direction: ${profile.direction};
}
body {
  font-family: ${stack};
  line-height: ${profile.lineHeight};
  margin: 0 5%;
  color: #1a1a1a;
}
h1, h2, h3 { font-family: ${stack}; page-break-after: avoid; }
img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
hr { border: none; border-top: 1px solid #d7d7d7; margin: 1.5em 0; }
pre, code { direction: ltr; unicode-bidi: isolate; text-align: left; }
${profile.hasItalic ? "" : "em, i, cite, blockquote { font-style: normal; }\nem, i { font-weight: 600; }\n"}`;
}

export type GenerateBookEpubOptions = {
  title: string;
  author?: string | undefined;
  language?: string | undefined;
  imageStorageDir: string;
  publicApiUrl: string;
  outputPath?: string | undefined;
  /**
   * The project being compiled. It narrows the illustrations this book may
   * package to that project's own, the way `sendOwnedProjectAsset` narrows the
   * HTTP asset route and `projectId` narrows the PDF renderer's file access —
   * reading the file here is the EPUB's equivalent of that render. Omitting it
   * leaves the whole image storage directory in scope, which is only right for a
   * book belonging to no project.
   */
  projectId?: string | undefined;
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
  const profile = scriptProfileForLanguage(options.language);
  const renderedChapters: EpubChapter[] = [];
  for (const [index, chapter] of chapters.entries()) {
    renderedChapters.push({
      id: `chapter-${index + 1}`,
      title: chapter.title,
      fileName: `chapter-${index + 1}.xhtml`,
      xhtml: chapterXhtml(chapter.title, await renderMarkdownToXhtml(chapter.markdown), profile)
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
  zip.file("OEBPS/styles.css", epubCss(profile));
  zip.file("OEBPS/nav.xhtml", navXhtml(options.title, renderedChapters, profile, markdownLabels(options.language).contentsHeading));
  for (const chapter of renderedChapters) {
    zip.file(`OEBPS/${chapter.fileName}`, chapter.xhtml);
  }
  for (const image of images.values()) {
    // Illustrations arrive as PNG/JPEG/WebP — already entropy-coded, so
    // deflating them spends real CPU (pako is pure JS) to save nothing. The
    // per-entry override is the same mechanism `mimetype` above uses, and
    // stored image entries are fully legal EPUB.
    zip.file(`OEBPS/${image.fileName}`, image.data, { compression: "STORE" });
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
      coverImageId: coverImage?.id,
      direction: profile.direction
    })
  );

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    // What is left to deflate is XHTML and CSS, where level 6 is within a
    // percent of level 9 for a fraction of the time. Level 9 only ever paid
    // for itself on the image entries, which no longer take this path.
    compressionOptions: { level: 6 }
  });
  if (options.outputPath) {
    await writeFile(options.outputPath, bytes);
  }
  return bytes;
}

/**
 * Packages every local illustration and rewrites the markdown to point at it.
 *
 * Two properties are contract rather than accident, and both come from the
 * *first appearance* order of the collect pass below:
 *
 * - `image-1` is the book's cover, because `contentOpf` marks the first entry
 *   of `images` as `properties="cover-image"`.
 * - a repeated illustration is packaged once, keyed by its path on disk.
 *
 * The reads run together instead of one per match — a 40-image book paid 40
 * serial disk round-trips — and the rewrite is a single `replace` pass with a
 * function replacer, so it is linear in the document rather than one full-text
 * scan per image, and `$&`-shaped alt text can no longer corrupt the output.
 */
async function packageLocalImages(
  markdown: string,
  options: GenerateBookEpubOptions,
  images: Map<string, EpubImage>
): Promise<string> {
  const publicApiBase = options.publicApiUrl.replace(/\/+$/, "");
  // Containment lives in the resolver: this used to be its own copy without one,
  // and `![x](/assets/images/p/../../../etc/passwd)` packaged a server file into
  // the reader's download. `projectId` is the other half — storage is shared, so
  // containment alone still let a manuscript name another project's illustration
  // and have it read and packaged here.
  const localPathFor = (src: string) =>
    resolveBookImageAsset(src, {
      imageStorageDir: options.imageStorageDir,
      publicApiBase,
      projectId: options.projectId
    })?.localPath ?? null;

  // A Set keeps insertion order, which is what makes the numbering below
  // first-appearance rather than filesystem-completion order.
  const orderedPaths = new Set<string>();
  for (const match of markdown.matchAll(IMAGE_MARKDOWN_RE)) {
    const localPath = localPathFor(match[2] ?? "");
    if (localPath) {
      orderedPaths.add(localPath);
    }
  }

  const files = await Promise.all(
    [...orderedPaths].map(async (localPath) => {
      try {
        return { localPath, data: await readFile(localPath) };
      } catch {
        return { localPath, data: undefined };
      }
    })
  );

  for (const file of files) {
    if (!file.data) {
      continue;
    }
    const index = images.size + 1;
    const extension = extname(file.localPath).toLowerCase() || ".png";
    images.set(file.localPath, {
      id: `image-${index}`,
      fileName: `images/image-${index}${extension}`,
      mediaType: MIME_BY_EXT[extension] ?? "application/octet-stream",
      data: file.data
    });
  }

  return markdown.replace(IMAGE_MARKDOWN_RE, (_full, alt: string, src: string) => {
    const localPath = localPathFor(src);
    const image = localPath ? images.get(localPath) : undefined;
    // Remote, unresolvable and unreadable images are all stripped, so the EPUB
    // never ships a broken reference.
    return image ? `![${alt}](${image.fileName})` : "";
  });
}

function splitIntoChapters(markdown: string, bookTitle: string): Array<{ title: string; markdown: string }> {
  const lines = markdown.split("\n");
  const chapters: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } = { title: bookTitle, lines: [] };
  let inCodeFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
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
  // The same active markup the PDF drops. Nothing here renders on this machine,
  // so there is no server file to disclose — it is the reader's device that
  // would resolve an iframe or execute an event/URL attribute shipped inside a
  // book they opened.
  return toXhtml(stripEmbeddedDocuments(html));
}

/** Self-closes void elements so the output parses as XHTML. */
function toXhtml(html: string): string {
  return html
    .replace(/<(img|br|hr|input|meta|link)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/gi, "<$1$2 />")
    .replace(/&nbsp;/g, "&#160;");
}

/** EPUB 3 requires `xml:lang`; `dir` is legal on a content document's root. */
function htmlOpenTag(profile: ScriptProfile): string {
  return (
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"` +
    ` xml:lang="${profile.code}" lang="${profile.code}" dir="${profile.direction}">`
  );
}

function chapterXhtml(title: string, body: string, profile: ScriptProfile): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
${htmlOpenTag(profile)}
<head>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css" />
</head>
<body>
${body}
</body>
</html>`;
}

function navXhtml(
  bookTitle: string,
  chapters: EpubChapter[],
  profile: ScriptProfile,
  contentsHeading: string
): string {
  const items = chapters
    .map((chapter) => `      <li><a href="${chapter.fileName}">${escapeXml(chapter.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
${htmlOpenTag(profile)}
<head>
  <title>${escapeXml(bookTitle)}</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${escapeXml(contentsHeading)}</h1>
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
  direction: "ltr" | "rtl";
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
  <spine${options.direction === "rtl" ? ` page-progression-direction="rtl"` : ""}>
${spineItems}
  </spine>
</package>`;
}

/**
 * `Project.language` is a display label as often as it is a code, and the old
 * regex rejected every label: a Persian book shipped `<dc:language>en</dc:language>`
 * because "Persian" is seven letters.
 */
function normalizeEpubLanguage(language: string | undefined): string {
  return scriptProfileForLanguage(language).code;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
