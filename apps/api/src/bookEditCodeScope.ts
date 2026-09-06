import type { BookEditIntent, BookEditPageContext, BookEditProjectStage } from "./bookEditIntent.js";
import { spokenPageNumbersFromMessage } from "./bookEditMessage.js";
import { type ReaderPageNumbering } from "./bookPageNumbering.js";

/**
 * The deterministic pass over a routed "write the code in <language>" request.
 *
 * On 2026-09-06 a reader sent "Use JavaScript in the codes" right after an
 * edit that had named "pages 3 and 4"; the router read those numbers out of
 * `recentConversation`, scoped the new request to the two pages that were
 * already JavaScript, and the reader paid for an edit whose card said
 * "Nothing was changed" while five Python pages sat untouched. Two things
 * were missing, and both are decided here from the page features rather than
 * asked of the model again: which pages *need* the language (a fence tag that
 * is not already it), and that a message naming no page is scoped over the
 * whole book, whatever the previous turn named.
 *
 * It only ever narrows a `page_rewrite` to the pages that need the change, or
 * answers when none do — it never widens beyond the pages that carry code and
 * never touches a request that names its own pages or came from a reader
 * selection. A wrong narrowing is one Cancel away, because a finished book
 * prices every edit as a proposal card first.
 */
export function narrowCodeLanguageIntent(
  intent: BookEditIntent,
  message: string,
  pages: BookEditPageContext[],
  options: { stage: BookEditProjectStage; numbering: ReaderPageNumbering; readerSelected: boolean }
): BookEditIntent {
  if (options.stage !== "complete" || intent.kind !== "page_rewrite") {
    return intent;
  }
  const language = codeLanguageRequest(message);
  if (language === null) {
    return intent;
  }
  // No features loaded at all: nothing is known, so nothing is decided here.
  if (!pages.some((page) => page.codeBlocks !== undefined)) {
    return intent;
  }
  const namesPages = options.readerSelected || spokenPageNumbersFromMessage(message).length > 0;
  const candidates = namesPages
    ? pages.filter((page) => intent.affectedPageIndexes.includes(page.index))
    : pages.filter((page) => (page.codeBlocks ?? 0) > 0);
  const needed = candidates
    .filter((page) => pageNeedsCodeLanguage(page, language))
    .map((page) => page.index)
    .sort((a, b) => a - b);
  if (needed.length === 0) {
    const where = namesPages && intent.affectedPageIndexes.length > 0
      ? `on page ${describePages(options.numbering.displayPages(intent.affectedPageIndexes))}`
      : "in this book";
    return {
      ...intent,
      kind: "answer",
      affectedPageIndexes: [],
      scope: "none",
      impact: "small_text",
      clarification: "none",
      assistantMessage: `The code ${where} is already in ${codeLanguageLabel(language)}, so there is nothing to change.`
    };
  }
  const unchanged =
    needed.length === intent.affectedPageIndexes.length && needed.every((index, at) => intent.affectedPageIndexes[at] === index);
  if (unchanged) {
    return intent;
  }
  return {
    ...intent,
    affectedPageIndexes: needed,
    scope: "explicit_pages",
    ...(intent.perPageInstructions
      ? { perPageInstructions: intent.perPageInstructions.filter((entry) => needed.includes(entry.pageIndex)) }
      : {})
  };
}

function describePages(printed: number[]): string {
  if (printed.length === 1) return String(printed[0]);
  if (printed.length === 2) return `${printed[0]} and ${printed[1]}`;
  return `${printed.slice(0, -1).join(", ")} and ${printed[printed.length - 1]}`;
}

/** How the reply spells a fence tag; anything unlisted is capitalised as written. */
function codeLanguageLabel(language: string): string {
  const labels: Record<string, string> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    python: "Python",
    cpp: "C++",
    csharp: "C#",
    php: "PHP",
    sql: "SQL",
    go: "Go"
  };
  return labels[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * A request to write the book's code in one language, and which one: it names
 * code and exactly one programming language, and is not asking to add code
 * where there is none. The model-free twin of the router's content-scoped
 * targeting rule; a router outage used to turn "use JavaScript in the codes"
 * into a whole-book quote or a clarify. The language comes back as the fence
 * tag the book would write it under, so it compares against
 * `BookEditPageContext.codeLanguages` directly.
 */
export function codeLanguageRequest(message: string): string | null {
  if (!/\b(?:codes?|snippets?|pseudocode|listings?|code\s+(?:examples?|blocks?|samples?))\b/i.test(message)) {
    return null;
  }
  if (/\b(?:add|insert|include|put)\b.{0,40}\b(?:codes?|snippets?|examples?|listings?)\b/i.test(message)) {
    return null;
  }
  const named = new Set<string>();
  for (const match of message.matchAll(CODE_LANGUAGE_NAME_PATTERN)) {
    named.add(canonicalCodeLanguage(match[0]));
  }
  return named.size === 1 ? [...named][0]! : null;
}

export function mentionsCodeContent(message: string): boolean {
  return codeLanguageRequest(message) !== null;
}

const CODE_LANGUAGE_NAME_PATTERN =
  /(?<![\p{L}\p{N}])(?:javascript|typescript|python|java|kotlin|swift|rust|golang|go|ruby|php|c\+\+|cpp|c#|csharp|sql|bash|shell|dart|scala|haskell|lua|perl|js|ts|py)(?![\p{L}\p{N}])/giu;

/** One spelling per language, the way a fence tags it, so "C++" and a ```cpp block agree. */
export function canonicalCodeLanguage(name: string): string {
  const lower = name.toLowerCase();
  return CODE_LANGUAGE_ALIASES[lower] ?? lower;
}

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  golang: "go",
  "c++": "cpp",
  "c#": "csharp",
  shell: "bash",
  sh: "bash"
};

/** The pages whose context says they carry a fenced code block. */
export function pageIndexesWithCodeBlocks(pages: BookEditPageContext[]): number[] {
  return pages
    .filter((page) => (page.codeBlocks ?? 0) > 0)
    .map((page) => page.index)
    .sort((a, b) => a - b);
}

/**
 * Whether a page's code still has to be written in `language`: it carries a
 * block, and at least one of its fence tags is not already that language. A
 * page whose languages are unknown is assumed to need it — the patch tier
 * declines a page with nothing to change, so the cost of guessing wrong is one
 * cheap call, while dropping it would silently leave the request half done.
 */
export function pageNeedsCodeLanguage(page: BookEditPageContext, language: string): boolean {
  if ((page.codeBlocks ?? 0) === 0) {
    return false;
  }
  if (!page.codeLanguages || page.codeLanguages.length === 0) {
    return true;
  }
  return page.codeLanguages.some((tag) => canonicalCodeLanguage(tag) !== language);
}

export function pageIndexesNeedingCodeLanguage(pages: BookEditPageContext[], language: string): number[] {
  return pages
    .filter((page) => pageNeedsCodeLanguage(page, language))
    .map((page) => page.index)
    .sort((a, b) => a - b);
}
