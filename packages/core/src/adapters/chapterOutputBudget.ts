import type { TextModelThinkingEffort } from "../schemas/book.js";
import type { GenerateTextOptions } from "./types.js";

/**
 * These generation calls need room for the operator-selected reasoning effort.
 * Reasoning providers count that reasoning against max_output_tokens: the Ultra audit
 * exhausted 5,000 / 7,500 tokens planning forms and 10,608 composing chapter 1,
 * all in reasoning, with no text. Keep a total allowance that fits elevated
 * reasoning plus the chapter. Ordinary calls retain their explicit fuse.
 */
export function chapterOutputBudget(options: GenerateTextOptions, effort: TextModelThinkingEffort | undefined): number | undefined {
  if (options.maxTokens === undefined || !new Set([
    "plan-book", "generate-page-map", "compose-chapter", "edit-chapter", "read-manuscript", "plan-chapter-forms"
  ]).has(options.purpose ?? "")) return options.maxTokens;
  const floor = effort === "max" || effort === "xhigh" ? 48_000 : effort === "high" ? 32_000 : 0;
  return Math.max(options.maxTokens, floor);
}
