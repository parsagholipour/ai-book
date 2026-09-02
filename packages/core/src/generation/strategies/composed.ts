import { compileBookMarkdown, compileBookMarkdownWithPageAnchors } from "../markdown.js";
import { generateBookPdf, generateBookPdfWithPageMap } from "../pdf.js";
import { createPlanningPackage, revisePlanningPackage } from "../planner.js";
import {
  generateChapterBrief,
  generateImageBytes,
  generatePageDraft,
  repairPageBrief,
  reviewPageDraft,
  revisePageDraft,
  runFinalBookQa,
  shouldIllustratePage
} from "../pages.js";
import { COMPOSED_CHAPTERS_RESEARCH_STRATEGY_ID, COMPOSED_CHAPTERS_STRATEGY_ID } from "./ids.js";
import type { BookGenerationStrategy } from "./types.js";

/**
 * Composed chapters: the chapter is the unit of composition, the page is the
 * unit of storage.
 *
 * The per-page functions are still on the strategy because the finished book
 * is edited, continued and restructured page by page through the same chat
 * paths every other strategy uses; only the initial generation differs. See
 * `apps/worker/src/generation/composedChaptersPass.ts` and
 * `.scratch/composed-chapters/spec.md`.
 */

const sharedGeneration = {
  createPlan: createPlanningPackage,
  revisePlan: revisePlanningPackage,
  generateChapterBrief,
  generatePageDraft,
  reviewPageDraft,
  repairPageBrief,
  revisePageDraft,
  runFinalBookQa,
  shouldIllustratePage,
  generateImageBytes,
  compileMarkdown: compileBookMarkdown,
  compileMarkdownWithPageAnchors: compileBookMarkdownWithPageAnchors,
  generatePdf: generateBookPdf,
  generatePdfWithPageMap: generateBookPdfWithPageMap
};

export const composedChaptersStrategy = Object.freeze({
  id: COMPOSED_CHAPTERS_STRATEGY_ID,
  label: "Composed chapters",
  strengthScore: 10,
  recommendedPageRange: { min: 12, max: 600 },
  executionMode: "composed-chapters",
  ...sharedGeneration
} satisfies BookGenerationStrategy);

export const composedChaptersResearchStrategy = Object.freeze({
  id: COMPOSED_CHAPTERS_RESEARCH_STRATEGY_ID,
  label: "Composed chapters (research-grounded)",
  strengthScore: 10,
  recommendedPageRange: { min: 12, max: 600 },
  executionMode: "composed-chapters",
  researchDepth: 12,
  ...sharedGeneration
} satisfies BookGenerationStrategy);

/**
 * Whether a book was written chapter by chapter. The compile reads it to skip
 * the per-page final-QA repair loop — the whole-manuscript read replaced it —
 * while the deterministic manuscript audit still runs.
 */
export function strategyComposesChapters(strategy: Pick<BookGenerationStrategy, "executionMode">): boolean {
  return strategy.executionMode === "composed-chapters";
}
