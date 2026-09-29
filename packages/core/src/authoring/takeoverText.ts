import { DEFAULT_CHAPTER_HEADING_STYLE, sanitizePageMarkdown } from "../generation/markdown.js";
import { markdownLabels } from "../generation/markdownLabels.js";

/**
 * A generated page as its author will own it, when the owner takes the book
 * over into the Writing Studio.
 *
 * The book must print the same the moment it changes hands, but the author
 * compile reads a page differently from the generated one
 * (`CompileMarkdownInput.authorManuscript`): it never unwraps a model's
 * whole-page ```` ```markdown ```` wrapper, never strips a leading `## Page 3`
 * or the page's own title, and prints no hero above the prose — a Studio
 * picture is a line in the text. So the page's text is rewritten once into what
 * the generated compile *printed*: `sanitizePageMarkdown` under the generated
 * rules (reused, never re-implemented, so the two cannot drift), with the hero
 * as the first line.
 */

export type TakeoverPage = {
  index: number;
  title: string;
  markdown: string;
};

/**
 * The page's own text exactly as the generated compile printed it. `chapter`
 * is the printed chapter this page opens, if any: a leading heading that only
 * repeats that chapter's heading goes, in every wording it could have had.
 */
export function generatedPagePrintedText(
  page: TakeoverPage,
  options: { chapter?: { index: number; title: string } | undefined; language?: string | undefined } = {}
): string {
  const labels = markdownLabels(options.language);
  const chapter = options.chapter ? { ...options.chapter, summary: "" } : undefined;
  return sanitizePageMarkdown(page, chapter, labels, { style: DEFAULT_CHAPTER_HEADING_STYLE, word: labels.chapter }, false);
}

/**
 * The line a page's hero illustration becomes: the markdown the compile's hero
 * block printed, with the alt text it printed (the book language's
 * "Illustration").
 */
export function takeoverHeroLine(path: string, language?: string): string {
  const alt = markdownLabels(language).illustration.replace(/[[\]]/g, "");
  return `![${alt}](${path})`;
}

/** The whole page as the takeover stores it: the hero line (when there is one), a blank line, the printed text. */
export function takenOverPageText(
  page: TakeoverPage,
  options: {
    chapter?: { index: number; title: string } | undefined;
    language?: string | undefined;
    heroPath?: string | null | undefined;
  } = {}
): string {
  const body = generatedPagePrintedText(page, options);
  if (!options.heroPath) {
    return body;
  }
  const line = takeoverHeroLine(options.heroPath, options.language);
  return body ? `${line}\n\n${body}` : line;
}
