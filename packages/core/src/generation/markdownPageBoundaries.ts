import { Lexer } from "marked";

/** Join page blocks while retaining the offsets used by the PDF's page map. */
export function joinMarkdownPageBlocks(blocks: readonly string[]): { markdown: string; offsets: number[] } {
  let markdown = "";
  const offsets: number[] = [];
  for (const block of blocks) {
    if (markdown) markdown += pageSeparator(markdown, block);
    offsets.push(markdown.length);
    markdown += block;
  }
  return { markdown, offsets };
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
