import type { CreateProjectInput } from "../../schemas/book.js";
import {
  CHAPTERED_SEQUENTIAL_STRATEGY_ID,
  DRAFT_THEN_POLISH_STRATEGY_ID,
  PAGE_MAP_SEQUENTIAL_STRATEGY_ID,
  RESEARCH_GROUNDED_STRATEGY_ID,
  RESEARCH_MAP_DRAFT_POLISH_STRATEGY_ID,
  WHOLE_BOOK_SINGLE_PASS_STRATEGY_ID,
  type BookGenerationStrategyId
} from "./ids.js";
import { getBookGenerationStrategy } from "./index.js";
import type { BookGenerationStrategy } from "./types.js";

export const AUTO_BOOK_GENERATION_STRATEGY_ID = "auto";

export type ResolvedBookGenerationStrategy = {
  strategy: BookGenerationStrategy;
  /** What the user originally asked for ("auto" when unset). */
  requestedId: string;
  /** True when the router picked the strategy instead of the user. */
  autoSelected: boolean;
  /** True when an explicit user choice was overridden because it could not produce the requested book. */
  switched: boolean;
  warnings: string[];
};

const RESEARCH_INTENT_CATEGORIES = new Set(["SCIENCE", "HEALTH", "HISTORY", "BIOGRAPHY"]);
const RESEARCH_INTENT_PATTERN =
  /\b(current|recent|latest|today|real|scientific|historical|research|evidence|medicine|law|finance|fact)\b/i;

export function hasResearchIntent(input: CreateProjectInput): boolean {
  return RESEARCH_INTENT_CATEGORIES.has(input.category) || RESEARCH_INTENT_PATTERN.test(input.prompt);
}

/**
 * Deterministically picks the best strategy for the given input.
 * Used when the user selects "auto" (or no strategy), and as the fallback
 * when an explicit choice cannot handle the requested page count.
 */
export function autoStrategyIdForInput(input: CreateProjectInput): BookGenerationStrategyId {
  const pages = input.targetPages;
  const factual = hasResearchIntent(input);

  if (pages < 5) {
    return WHOLE_BOOK_SINGLE_PASS_STRATEGY_ID;
  }
  if (pages < 12) {
    return DRAFT_THEN_POLISH_STRATEGY_ID;
  }
  if (pages <= 40) {
    return factual ? RESEARCH_MAP_DRAFT_POLISH_STRATEGY_ID : DRAFT_THEN_POLISH_STRATEGY_ID;
  }
  if (pages <= 80) {
    return factual ? RESEARCH_GROUNDED_STRATEGY_ID : PAGE_MAP_SEQUENTIAL_STRATEGY_ID;
  }
  if (pages <= 120) {
    return PAGE_MAP_SEQUENTIAL_STRATEGY_ID;
  }
  return CHAPTERED_SEQUENTIAL_STRATEGY_ID;
}

/**
 * Resolves the generation strategy for a project input.
 *
 * - "auto" (or unset) routes by page count, category, and research intent.
 * - Explicit choices are honored when the page target fits the strategy's
 *   recommended range; otherwise the router switches to a viable strategy and
 *   records a warning, because out-of-range runs fail in practice (for example
 *   whole-book single pass past its output-token budget).
 */
export function resolveBookGenerationStrategy(input: CreateProjectInput): ResolvedBookGenerationStrategy {
  const requested = input.mediaSettings.generationStrategy;

  if (!requested || requested === AUTO_BOOK_GENERATION_STRATEGY_ID) {
    const id = autoStrategyIdForInput(input);
    return {
      strategy: getBookGenerationStrategy(id),
      requestedId: AUTO_BOOK_GENERATION_STRATEGY_ID,
      autoSelected: true,
      switched: false,
      warnings: []
    };
  }

  const strategy = getBookGenerationStrategy(requested);
  const { min, max } = strategy.recommendedPageRange;
  if (input.targetPages >= min && input.targetPages <= max) {
    return { strategy, requestedId: requested, autoSelected: false, switched: false, warnings: [] };
  }

  const fallback = getBookGenerationStrategy(autoStrategyIdForInput(input));
  if (fallback.id === strategy.id) {
    return { strategy, requestedId: requested, autoSelected: false, switched: false, warnings: [] };
  }
  return {
    strategy: fallback,
    requestedId: requested,
    autoSelected: true,
    switched: true,
    warnings: [
      `Strategy "${strategy.label}" supports ${min}-${max} pages but this book targets ${input.targetPages}; switched to "${fallback.label}".`
    ]
  };
}
