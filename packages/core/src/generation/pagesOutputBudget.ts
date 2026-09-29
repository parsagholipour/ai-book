import type { CreateProjectInput } from "../schemas/book.js";
import { isDiagramFriendlyBookCategory } from "../categories.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";

export function targetWordsPerPage(input: CreateProjectInput): { min: number; max: number } {
  const kidsGuidance = kidsReadingGuidanceForInput(input);
  if (kidsGuidance) {
    return kidsGuidance.targetWordsPerPage;
  }
  if (isDiagramFriendlyBookCategory(input.category)) {
    return { min: 140, max: 360 };
  }
  return { min: 160, max: 420 };
}

const WHOLE_BOOK_MIN_OUTPUT_SAFETY_TOKENS = 16_000;
const WHOLE_BOOK_MAX_OUTPUT_SAFETY_TOKENS = 64_000;
const WHOLE_BOOK_VISIBLE_TEXT_TOKENS_PER_WORD = 3;
const WHOLE_BOOK_METADATA_TOKENS_PER_PAGE = 600;

export function wholeBookMaxTokens(input: CreateProjectInput): number {
  const maxWordsPerPage = targetWordsPerPage(input).max;
  const generousTokensPerPage =
    maxWordsPerPage * WHOLE_BOOK_VISIBLE_TEXT_TOKENS_PER_WORD + WHOLE_BOOK_METADATA_TOKENS_PER_PAGE;

  // maxTokens is a runaway-output fuse, not the expected response size. The
  // visible-text multiplier is deliberately conservative for token-dense
  // languages, while the per-page allowance covers JSON, summaries,
  // continuity notes, and image prompts. Short books receive extra headroom so
  // a normal five-page draft cannot collide with the safety limit again.
  return Math.min(
    WHOLE_BOOK_MAX_OUTPUT_SAFETY_TOKENS,
    Math.max(WHOLE_BOOK_MIN_OUTPUT_SAFETY_TOKENS, input.targetPages * generousTokensPerPage)
  );
}
