import type { AppConfig } from "../config.js";
import type { ImageModelSelection, ModelTier, TextModelSelection } from "../schemas/book.js";

/**
 * Generation purposes that are mechanical (structured review, judging,
 * chapterization, page maps) rather than reader-facing prose. These route to
 * the tier's cheaper mechanical model; every other purpose — including
 * unknown future ones — routes to the prose model so quality is never
 * silently degraded.
 */
export const MECHANICAL_TEXT_PURPOSES: ReadonlySet<string> = new Set([
  "review-page",
  "judge-page-drafts",
  "final-book-qa",
  // The chapter-transition sibling of final-book-qa: a strict-schema issue
  // list, not prose. Left off this list it ran on the premium prose model.
  "book.final_qa.chapter_transitions",
  "chapterize-export",
  "repair-page-brief",
  "generate-page-map",
  "generate-chapter-brief",
  "import-chapterize",
  "import-style-profile",
  // A 300-token pick from a fixed catalog (coverDesigns.ts).
  "select-cover-design",
  "extract-story-state",
  "critique-plan",
  "verify-page-claims",
  "audit-page-style",
  "critique-page-map"
]);

export type ModelTierTextSelections = {
  prose: TextModelSelection;
  mechanical: TextModelSelection;
};

const PREMIUM_PROSE_MODEL = "gemini-2.5-pro";
// gemini-2.5-pro cannot fully disable thinking; bound the budget so thinking
// tokens (billed as output) stay a small fraction of prose cost.
const PREMIUM_PROSE_THINKING_BUDGET = 2048;
export const PREMIUM_PLAN_THINKING_BUDGET = 4096;
export const ULTRA_PLAN_THINKING_BUDGET = 8192;
export const ULTRA_PAGE_MAP_THINKING_BUDGET = 1024;
const PREMIUM_MECHANICAL_MODEL = "gemini-2.5-flash";
const PREMIUM_IMAGE_MODEL = "gemini-3.1-flash-image";
export const PREMIUM_COVER_IMAGE_MODEL = "gemini-3-pro-image";
export const PREMIUM_FALLBACK_IMAGE_MODEL = "qwen-image-2.0-pro";

export function modelTierTextSelections(tier: ModelTier, config: AppConfig): ModelTierTextSelections {
  if (tier === "fast") {
    const selection: TextModelSelection = {
      provider: "deepseek",
      model: config.DEEPSEEK_FAST_MODEL,
      thinkingEnabled: false
    };
    return { prose: selection, mechanical: selection };
  }
  if (tier === "premium" || tier === "ultra") {
    return {
      prose: {
        provider: "gemini",
        model: PREMIUM_PROSE_MODEL,
        thinkingBudget: PREMIUM_PROSE_THINKING_BUDGET
      },
      mechanical: {
        provider: "gemini",
        model: PREMIUM_MECHANICAL_MODEL,
        thinkingBudget: 0
      }
    };
  }
  return {
    prose: { provider: "deepseek", model: config.DEEPSEEK_MODEL },
    mechanical: {
      provider: "deepseek",
      model: config.DEEPSEEK_FAST_MODEL,
      thinkingEnabled: false
    }
  };
}

export function modelTierImageSelection(tier: ModelTier): ImageModelSelection | undefined {
  if (tier === "premium" || tier === "ultra") {
    return { provider: "gemini", model: PREMIUM_IMAGE_MODEL };
  }
  return undefined;
}

export function planThinkingBudgetForTier(tier: ModelTier): number | undefined {
  if (tier === "ultra") {
    return ULTRA_PLAN_THINKING_BUDGET;
  }
  if (tier === "premium") {
    return PREMIUM_PLAN_THINKING_BUDGET;
  }
  return undefined;
}

/**
 * DeepSeek counterpart used when a tier-selected Gemini model fails
 * persistently, so a premium book never dies mid-run on a provider outage.
 */
export function modelTierTextFallbackSelection(primary: TextModelSelection, config: AppConfig): TextModelSelection {
  const mechanical = primary.model === PREMIUM_MECHANICAL_MODEL;
  return mechanical
    ? { provider: "deepseek", model: config.DEEPSEEK_FAST_MODEL, thinkingEnabled: false }
    : { provider: "deepseek", model: config.DEEPSEEK_MODEL };
}
