import { Lexer } from "marked";

export type JoinMarkdownPageBlocksOptions = {
  /**
   * Join every boundary on a blank line: an author's manuscript, whose pages
   * are where the paginator cut *between* blocks, never mid-paragraph. See
   * `CompileMarkdownInput.authorManuscript`. The single-newline join, with its
   * table exception, is for a generated book, whose prose runs on across pages.
   */
  paragraphBreaks?: boolean | undefined;
};

/** Join page blocks while retaining the offsets used by the PDF's page map. */
export function joinMarkdownPageBlocks(
  blocks: readonly string[],
  options: JoinMarkdownPageBlocksOptions = {}
): { markdown: string; offsets: number[] } {
  let markdown = "";
  const offsets: number[] = [];
  for (const block of blocks) {
    if (markdown) markdown += options.paragraphBreaks ? paragraphSeparator(markdown, block) : pageSeparator(markdown, block);
    offsets.push(markdown.length);
    markdown += block;
  }
  return { markdown, offsets };
}

/**
 * Exactly one blank line between the two blocks, counting the newlines either
 * side already carries (a hero-image block opens on one), so the boundary reads
 * as a paragraph break and never as a continuation. A table needs no exception
 * here: the blank line is what ends it.
 */
function paragraphSeparator(before: string, after: string): string {
  // Counted from the ends, never matched against `before`: it is the whole
  // book so far, and a regex over it per page is quadratic in the book.
  let carried = 0;
  while (carried < 2 && before[before.length - 1 - carried] === "\n") carried += 1;
  for (let index = 0; carried < 2 && after[index] === "\n"; index += 1) carried += 1;
  return "\n".repeat(2 - carried);
}

function pageSeparator(before: string, after: string): string {
  // Ordinary prose, lists and quotes can continue across model pages. Tables
  // can too, but GFM also consumes a following pipe-free paragraph as another
  // row unless the page boundary restores its missing blank line.
  if (before.endsWith("\n") || after.startsWith("\n")) return "\n";
  const lastLine = before.slice(before.lastIndexOf("\n") + 1);
  const firstLine = after.split("\n", 1)[0] ?? "";
  if (!hasCellSeparator(lastLine) || hasCellSeparator(firstLine)) return "\n";
  // Inspect the accumulated document so a table spanning several page blocks
  // is still recognized; pipe-shaped examples inside code are not tables.
  const lastBlock = Lexer.lex(before).filter((token) => token.type !== "space").at(-1);
  return lastBlock?.type === "table" ? "\n\n" : "\n";
}

function hasCellSeparator(line: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\|/.test(line);
}
