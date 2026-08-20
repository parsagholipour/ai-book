export const BOOK_CATEGORIES = [
  "KIDS",
  "SCIENCE",
  "STORY",
  "EDUCATION",
  "BUSINESS",
  "SELF_HELP",
  "HEALTH",
  "BIOGRAPHY",
  "HISTORY",
  "SOCIETY",
  "ARTS",
  "CUSTOM"
] as const;

export type BookCategory = (typeof BOOK_CATEGORIES)[number];

const BOOK_CATEGORY_SET = new Set<string>(BOOK_CATEGORIES);

export function isBookCategory(value: string): value is BookCategory {
  return BOOK_CATEGORY_SET.has(value);
}

/**
 * Every per-category behavior set lives here, and every one of them is a
 * `Set<BookCategory>` rather than a set of strings: a member list typed as
 * plain strings takes a typo or a renamed enum value without a word from the
 * compiler, and the failure is silent — the category simply stops being
 * exempt, and the only symptom is a page the pipeline rewrites for a rule it
 * was never meant to be held to. Membership is therefore tested through
 * `isBookCategory` first, so the guards still take the `string | undefined`
 * their callers read off records and payloads.
 */
const SOURCE_FORWARD_BOOK_CATEGORIES = new Set<BookCategory>(["SCIENCE", "HEALTH", "BIOGRAPHY", "HISTORY"]);

export function isSourceForwardBookCategory(category: string | undefined): category is BookCategory {
  return Boolean(category && isBookCategory(category) && SOURCE_FORWARD_BOOK_CATEGORIES.has(category));
}

const DIAGRAM_FRIENDLY_BOOK_CATEGORIES = new Set<BookCategory>(["SCIENCE", "EDUCATION", "HEALTH"]);

export function isDiagramFriendlyBookCategory(category: string | undefined): category is BookCategory {
  return Boolean(category && isBookCategory(category) && DIAGRAM_FRIENDLY_BOOK_CATEGORIES.has(category));
}

/**
 * Practical categories are allowed to signpost: "This section covers the three
 * filters most home systems use" is the correct register for a how-to or a
 * textbook page, not scaffold, so the chapter-opener scaffold check in
 * `generation/pagesLocalQa.ts` skips them. Narrative and scholarly categories
 * stay gated.
 */
const SIGNPOSTING_BOOK_CATEGORIES = new Set<BookCategory>(["EDUCATION", "BUSINESS", "SELF_HELP", "HEALTH"]);

export function isSignpostingBookCategory(category: string | undefined): category is BookCategory {
  return Boolean(category && isBookCategory(category) && SIGNPOSTING_BOOK_CATEGORIES.has(category));
}
