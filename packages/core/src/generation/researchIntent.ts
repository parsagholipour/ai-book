import type { CreateProjectInput } from "../schemas/book.js";

const RESEARCH_INTENT_CATEGORIES = new Set(["SCIENCE", "HEALTH", "HISTORY", "BIOGRAPHY"]);
const RESEARCH_INTENT_PATTERN = /\b(current|recent|latest|today|real|scientific|historical|research|evidence|medicine|law|finance|fact)\b/i;

/** Shared input-only predicate: planning need not import the strategy registry. */
export function hasResearchIntent(input: CreateProjectInput): boolean {
  return RESEARCH_INTENT_CATEGORIES.has(input.category) || RESEARCH_INTENT_PATTERN.test(input.prompt);
}
