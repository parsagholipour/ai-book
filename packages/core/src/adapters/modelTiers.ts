import type {
  CreateProjectInput,
  ImageModelSelection,
  ModelTier
} from "../schemas/book.js";

/**
 * Which tier a book runs — and is priced — at.
 *
 * `mediaSettings.modelTier` and nothing else. It is the field live Quality-tab
 * text routing and the image selection below route on, it is typed and
 * validated, and it is what `billing.ts`'s
 * provider-cost table and tier price keys read — pricing off
 * `mediaSettings.mobile.qualityPreset` instead, as `billing.ts` used to, meant a
 * project that set the tier directly got premium models for free, because that
 * echo is only ever written by the app. One answer, not two that happen to
 * agree.
 *
 * No tier recorded is `balanced`, so projects created before tier routing join
 * the same operator-controlled balanced route as current projects.
 *
 * It lives here rather than in `billing.ts` because a tier is not a price. Two
 * of its callers are the worker's `generation/tuning.ts` and
 * `generation/qualitySettings.ts`, which spend no credits and ask only which
 * models a book runs; both are `vi.mock`ed modules, so reaching this through the
 * barrel pulled puppeteer, sharp and `node:fs` into their mock factories for one
 * property lookup — and a suite that bare-factory-mocks `@book-maker/core` left
 * it `undefined` inside the real module. Hence `@book-maker/core/modelTiers`,
 * which this file earns by having no runtime imports at all: keep it that way.
 *
 * `modelTierFromMediaSettings` (`billing.ts`) is the twin for callers holding a
 * raw `mediaSettings` JSON column. It stays there because parsing one needs zod.
 */
export function modelTierForInput(input: CreateProjectInput): ModelTier {
  return input.mediaSettings.modelTier ?? "balanced";
}

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
  "critique-page-map",
  "dedupe-page-beats",
  // The copyright-safe image-prompt rewrite
  // (`generation/copyrightSafeImagePrompt.ts`): a strict-schema find-and-replace
  // that swaps protected names for generic descriptions and is forbidden from
  // touching anything else. Spelled out rather than imported from the constant,
  // because this module's subpath export is gated on having no runtime imports.
  "rewrite-image-prompt-copyright-safe"
]);

export const PREMIUM_PLAN_THINKING_BUDGET = 4096;
export const ULTRA_PLAN_THINKING_BUDGET = 8192;
export const ULTRA_PAGE_MAP_THINKING_BUDGET = 1024;
const PREMIUM_IMAGE_MODEL = "gemini-3.1-flash-image";
export const PREMIUM_COVER_IMAGE_MODEL = "gemini-3-pro-image";
export const PREMIUM_FALLBACK_IMAGE_MODEL = "qwen-image-2.0-pro";

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
