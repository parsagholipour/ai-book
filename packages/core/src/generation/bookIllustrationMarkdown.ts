import { bookMatterSectionEnd } from "./bookMatterPages.js";

/**
 * Which `imageMarkdownRe` matches in this text are illustrations, by offset.
 *
 * An escaped bang is printed as text. The compiler's title page and matter
 * sheet are HTML blocks whose fields are literal text, and About the Author
 * is escaped text from its heading to the end of the book. No illustration is
 * placed in any of them. PDF, EPUB and stored-image materialization share this
 * check so a field's image-shaped words neither change nor cause a file read.
 *
 * Read per text, because the story path rewrites slices of the book and every
 * slice must answer for its own offsets.
 */
export function bookIllustrationAt(text: string): (offset: number) => boolean {
  const matter = bookMatterRanges(text);
  return (offset) => !escapedAt(text, offset) && !matter.some(([start, end]) => offset >= start && offset < end);
}

/** `formatAboutAuthor`'s marker, including every smaller biography size. */
const ABOUT_AUTHOR_MARKER = /\n\n<div class="book-about-author(?: book-about-author--[a-z0-9-]+)?"><\/div>\n/g;

function bookMatterRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (let at = text.indexOf("<section"); at >= 0; at = text.indexOf("<section", at + 1)) {
    // An HTML block opens a line, which is where the compiler writes both sections.
    const end = at === 0 || text[at - 1] === "\n" ? bookMatterSectionEnd(text, at) : undefined;
    if (end !== undefined) {
      ranges.push([at, end]);
    }
  }
  // The heading is the line before the marker's blank line, and the block is
  // always last, so it runs to the end of whichever slice holds it. Only the
  // last marker is the compiler's: page prose may spell an earlier one too.
  const about = [...text.matchAll(ABOUT_AUTHOR_MARKER)].at(-1)?.index;
  if (about !== undefined) {
    ranges.push([text.lastIndexOf("\n", about - 1) + 1, text.length]);
  }
  return ranges;
}

/** Whether `offset` follows an odd run of backslashes, which escapes it. */
function escapedAt(text: string, offset: number): boolean {
  let start = offset;
  while (start > 0 && text[start - 1] === "\\") {
    start--;
  }
  return (offset - start) % 2 === 1;
}
