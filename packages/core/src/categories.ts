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

const SOURCE_FORWARD_BOOK_CATEGORIES = ["SCIENCE", "HEALTH", "BIOGRAPHY", "HISTORY"] as const;
const SOURCE_FORWARD_BOOK_CATEGORY_SET = new Set<string>(SOURCE_FORWARD_BOOK_CATEGORIES);

export function isSourceForwardBookCategory(category: string | undefined): category is BookCategory {
  return Boolean(category && SOURCE_FORWARD_BOOK_CATEGORY_SET.has(category));
}

const DIAGRAM_FRIENDLY_BOOK_CATEGORIES = ["SCIENCE", "EDUCATION", "HEALTH"] as const;
const DIAGRAM_FRIENDLY_BOOK_CATEGORY_SET = new Set<string>(DIAGRAM_FRIENDLY_BOOK_CATEGORIES);

export function isDiagramFriendlyBookCategory(category: string | undefined): category is BookCategory {
  return Boolean(category && DIAGRAM_FRIENDLY_BOOK_CATEGORY_SET.has(category));
}
