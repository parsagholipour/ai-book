import type { TextModelThinkingEffort } from "../schemas/book.js";
import type { GenerateTextOptions } from "./types.js";

const SHORT_STRUCTURED_PURPOSES = new Set([
  "describe-pages", "select-cover-design",
  "review-dossier-provenance", "extract-excerpts", "review-chapter-edit-acceptance", "review-page", "extract-chapter-facts",
  "generate-chapter-brief",
  "final-book-qa", "audit-page-style",
  "generate-page", "revise-page",
  "author-assist-rewrite", "author-assist-proofread", "author-assist-continue", "author-assist-describe",
  "author-assist-brainstorm", "author-assist-ask", "author-chapter-feedback", "author-consistency", "author-outline",
  "extract-voice-character-candidates", "build-voice-character-persona"
]);

const CHAPTER_PURPOSES = new Set([
  "plan-book", "generate-page-map", "compose-chapter", "edit-chapter", "read-manuscript", "inventory-brief-requirements", "plan-chapter-forms",
  "author-draft-chapter"
]);

/**
 * These generation calls need room for the operator-selected reasoning effort.
 * Reasoning providers count that reasoning against max_output_tokens: the Ultra audit
 * exhausted 5,000 / 7,500 tokens planning forms and 10,608 composing chapter 1,
 * all in reasoning, with no text. Keep a total allowance that fits elevated
 * reasoning plus the chapter. Short structured stages need headroom too: the
 * Quick audit spent 35 story-extraction attempts entirely on reasoning under
 * 1,200 / 1,800 limits. These floors preserve the selected effort and the
 * visible-answer allowance. Premium page rewrites also exhausted their 3,200
 * cap with 3,083–3,200 reasoning tokens, so structured page drafts and repairs
 * use the same allowance as their critics. These are ceilings, not target token consumption.
 * The excerpt extractor asked for 4,000 and reasoned up to 5,371 at medium, so it
 * truncated in three of six Quick Draft books; it takes the structured floor.
 * Medium and low need a chapter-scale floor as well: Quick Draft's forms planner
 * (gpt-6-luna, medium) spent 4,000–5,600 tokens reasoning beside ~4,400 of JSON
 * and truncated at 6,400, 7,100 and the widened 9,600, so two of three books
 * paid two calls and one drafted from the rotated fallback forms (2026-09-30).
 * Low takes 12,000 since Quick Draft plans its forms at low effort (2026-09-30):
 * a seven-chapter plan is 5,000–7,000 tokens of JSON before any reasoning.
 * Unrecognized purposes and non-reasoning calls retain their explicit fuse.
 */
export function chapterOutputBudget(options: GenerateTextOptions, effort: TextModelThinkingEffort | undefined): number | undefined {
  if (options.maxTokens === undefined) return undefined;
  if (SHORT_STRUCTURED_PURPOSES.has(options.purpose ?? "")) {
    const floor = effort === "max" || effort === "xhigh" ? 24_000
      : effort === "high" ? 16_000 : effort === "medium" ? 8_000 : effort === "low" ? 4_000 : 0;
    return Math.max(options.maxTokens, floor);
  }
  if (!CHAPTER_PURPOSES.has(options.purpose ?? "")) return options.maxTokens;
  const floor = effort === "max" || effort === "xhigh" ? 48_000 : effort === "high" ? 32_000
    : effort === "medium" ? 16_000 : effort === "low" ? 12_000 : 0;
  return Math.max(options.maxTokens, floor);
}
