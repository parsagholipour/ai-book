import type { TextModelThinkingEffort } from "../schemas/book.js";
import type { GenerateTextOptions } from "./types.js";

const SHORT_STRUCTURED_PURPOSES = new Set([
  "extract-story-state", "describe-pages", "critique-plan", "select-cover-design",
  "review-dossier-provenance", "review-chapter-edit-acceptance", "review-page",
  "critique-page-map", "generate-chapter-brief", "book.final_qa.chapter_transitions",
  "final-book-qa", "audit-page-style", "review-manuscript-structure",
  "generate-page", "polish-page", "revise-page", "repair-page-brief", "judge-page-drafts"
]);

const CHAPTER_PURPOSES = new Set([
  "plan-book", "generate-page-map", "compose-chapter", "edit-chapter", "read-manuscript", "inventory-brief-requirements", "plan-chapter-forms"
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
  const floor = effort === "max" || effort === "xhigh" ? 48_000 : effort === "high" ? 32_000 : 0;
  return Math.max(options.maxTokens, floor);
}
