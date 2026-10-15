import {
  DocumentArchive,
  DocumentTextError,
  EPUB_DOCUMENT_MAX_BYTES,
  normalizeExtractedText,
  orderedEpubChapterPaths,
  stripHtml
} from "./documentText.js";
import { epubMatterBlocks } from "./epubMatterBlocks.js";
import type { MatterSourceSection } from "./manuscriptMatter.js";
import { firstMarkupElement, markupElements, replaceTags, type MarkupElement, type MarkupElementKind } from "./markupScan.js";

/** An EPUB's sections, and what its package metadata says about the book. */
export type EpubManuscript = { sections: MatterSourceSection[]; title?: string | undefined; creators: string[] };

/**
 * EPUB: one section per spine item or explicit matter page, in reading order —
 * its `<title>` is metadata, and its first `<h1>`/`<h2>` is the section's title,
 * which the compiler prints as the chapter heading, so neither is page text.
 * A section is never dropped here: its own front and back matter comes out in
 * `separateManuscriptMatter`, by the same rule as every other format. This
 * used to drop any spine item whose title began like boilerplate and ran under
 * 1,500 characters — an About the Author with its text, an acknowledgments
 * page, and a short chapter called "Covert" or "Navigating the Storm".
 *
 * Reading stops once the sections hold more than `stopAfterChars` of text:
 * the caller refuses a manuscript that long, and the rest would only cost it.
 */
export async function extractEpubSections(data: Buffer, stopAfterChars = Number.POSITIVE_INFINITY): Promise<EpubManuscript> {
  const archive = await DocumentArchive.open(data, "EPUB");
  const paths = await orderedEpubChapterPaths(archive);
  const sections: MatterSourceSection[] = [];
  let read = 0;
  for (const path of paths) {
    if (read > stopAfterChars) return { sections, creators: [] };
    const html = await archive.text(path, EPUB_DOCUMENT_MAX_BYTES);
    if (!html) {
      continue;
    }
    // One file can hold thousands of blocks; its `<title>` is read once, not once per block.
    let documentTitle: string | undefined;
    for (const { html: body, hint } of epubMatterBlocks(html)) {
      const headingElement = firstMarkupElement(body, HEADING_ELEMENTS);
      const heading = headingElement ? inlineText(elementBody(body, headingElement)) : "";
      documentTitle ??= heading ? undefined : inlineText(firstElementBody(html, TITLE_ELEMENT) ?? "");
      const title = heading || documentTitle || null;
      // A title page's heading is already its title, never a repeated subtitle.
      // Other heading-only pages ("Part One") retain their divider text.
      const text = normalizeExtractedText(stripHtml(headingElement ? body.replace(body.slice(headingElement.start, headingElement.end), " ") : body))
        || (hint === "title" ? "" : heading);
      if (!text && !heading) continue;
      sections.push({ title, text, standalone: true, ...(hint ? { hint } : {}), ...(heading ? {} : { headingless: true }) });
      read += text.length;
    }
  }
  if (sections.length === 0) {
    throw new DocumentTextError("UNREADABLE_FILE", "No readable chapters were found in that EPUB.");
  }
  return { sections, ...(await epubPackageMetadata(archive)) };
}

/** `<h([12])\b[^>]*>([\s\S]*?)<\/h\1>`, case-insensitive. */
export const HEADING_ELEMENTS: readonly MarkupElementKind[] = [
  { open: /<h1\b[^>]*>/gi, close: "</h1>" },
  { open: /<h2\b[^>]*>/gi, close: "</h2>" }
];
const TITLE_ELEMENT: readonly MarkupElementKind[] = [{ open: /<title\b[^>]*>/gi, close: "</title>" }];

export function elementBody(text: string, element: MarkupElement): string {
  return text.slice(element.bodyStart, element.bodyEnd);
}

function firstElementBody(text: string, kinds: readonly MarkupElementKind[]): string | undefined {
  const element = firstMarkupElement(text, kinds);
  return element && elementBody(text, element);
}

/** The package's title and creators: the book's name, and names its title page may print. */
async function epubPackageMetadata(archive: DocumentArchive): Promise<{ title?: string; creators: string[] }> {
  try {
    const container = await archive.text("META-INF/container.xml");
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath ? await archive.text(opfPath) : undefined;
    if (!opf) {
      return { creators: [] };
    }
    const title = inlineText(firstElementBody(opf, [{ open: /<dc:title\b[^>]*>/gi, close: "</dc:title>" }]) ?? "");
    const creators = Array.from(markupElements(opf, [{ open: /<dc:creator\b[^>]*>/gi, close: "</dc:creator>" }]), (element) =>
      inlineText(elementBody(opf, element))
    ).filter(Boolean);
    return { ...(title && !/^(?:untitled|unknown)$/i.test(title) ? { title: title.slice(0, 200) } : {}), creators };
  } catch (error) {
    if (error instanceof DocumentTextError) throw error;
    return { creators: [] };
  }
}

/** An element's text on one line: tags off, the common entities read. */
function inlineText(html: string): string {
  return replaceTags(html, /<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => codePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash);/gi, (_, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–"
};

function codePoint(value: number): string {
  return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
}
