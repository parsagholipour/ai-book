/**
 * The last check every compiled `book.md` passes before it is rendered: does it
 * still read like a book, or has the pipeline's own scaffolding leaked into it.
 *
 * Two kinds of finding, and only one of them may be asked of an author's text.
 *
 * - **Structural** — a leading frontmatter block, raw `page-break` markup. These
 *   are about the document the compiler assembled, not about whose words are in
 *   it: the first would be read as metadata, the second forces a physical break
 *   that the page map and the story layout do not know about. Every book answers
 *   to them. The Studio normalizer turns an author's raw page break into its own
 *   separator before publish, so a Studio book never reaches this one.
 * - **Generation leaks** — `generatedAt`, a `pages: 3` line, a `## Page 3`
 *   heading, a "Page 3" Contents link, "Illustration for Page 3" alt text. Each
 *   is a shape the planner or writer produced before this project learned to
 *   strip it, which is why finding one throws: a generated book that carries one
 *   is a pipeline bug worth failing loudly over. None of them is a bug in an
 *   author's manuscript. A novel may have a chapter headed "Page 3", a character
 *   who types `generatedAt`, a poem laid out as `pages: 12`. Throwing there
 *   marked a book the author wrote FAILED over their own sentence, and nothing
 *   they could do short of rewriting it would ever let it export — so
 *   `authorManuscript` (imported or written in the Studio, `isAuthorManuscript`)
 *   runs the structural checks alone.
 */
export type BookLikeMarkdownOptions = {
  /** The author owns the text: skip the generation-leak heuristics. */
  authorManuscript?: boolean | undefined;
};

export function assertBookLikeMarkdown(markdown: string, options: BookLikeMarkdownOptions = {}): void {
  const issues = findBookLikeMarkdownIssues(markdown, options);
  if (issues.length > 0) {
    throw new Error(`Compiled book Markdown contains reader-facing generation artifacts: ${issues.join("; ")}`);
  }
}

export function findBookLikeMarkdownIssues(markdown: string, options: BookLikeMarkdownOptions = {}): string[] {
  const issues: string[] = [];
  const generationLeaks = options.authorManuscript !== true;
  if (/^---\s*\r?\n/.test(markdown.trimStart())) {
    issues.push("frontmatter block");
  }
  if (generationLeaks && (/^generatedAt\s*:/im.test(markdown) || /\bgeneratedAt\b/i.test(markdown))) {
    issues.push("generatedAt metadata");
  }
  if (generationLeaks && /^pages\s*:\s*\d+\s*$/im.test(markdown)) {
    issues.push("page-count metadata");
  }
  if (generationLeaks && /^#{1,6}\s+Page\s+\d+\b/im.test(markdown)) {
    issues.push("page-number heading");
  }
  if (generationLeaks && /^\s*-\s+\[Page\s+\d+(?::|\])/im.test(markdown)) {
    issues.push("page-number table of contents link");
  }
  if (/<div\b[^>]*class=["'][^"']*\bpage-break\b/i.test(markdown)) {
    issues.push("raw page-break markup");
  }
  if (generationLeaks && /!\[Illustration for Page \d+\]/i.test(markdown)) {
    issues.push("page-number image alt text");
  }
  return issues;
}
