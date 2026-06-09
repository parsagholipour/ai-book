import { compileBookMarkdown } from "../markdown.js";
import { generateBookPdf } from "../pdf.js";
import { createPlanningPackage, revisePlanningPackage } from "../planner.js";
import {
  generateBatchDraft,
  generateChapterBrief,
  generateChapterDraft,
  generateImageBytes,
  generatePageDraft,
  generateWholeBookDraft,
  generateWholeBookPageMap,
  polishPageDraft,
  repairPageBrief,
  reviewPageDraft,
  revisePageDraft,
  runFinalBookQa,
  shouldIllustratePage
} from "../pages.js";
import {
  BATCH_WINDOW_STRATEGY_ID,
  CHAPTER_WHOLE_PASS_STRATEGY_ID,
  DRAFT_THEN_POLISH_STRATEGY_ID,
  PAGE_MAP_SEQUENTIAL_STRATEGY_ID,
  RESEARCH_GROUNDED_STRATEGY_ID,
  RESEARCH_MAP_DRAFT_POLISH_STRATEGY_ID
} from "./ids.js";
import type { BookGenerationStrategy } from "./types.js";

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
  generatePdf: generateBookPdf
};

export const pageMapSequentialStrategy = Object.freeze({
  id: PAGE_MAP_SEQUENTIAL_STRATEGY_ID,
  label: "Page-map sequential generation",
  strengthScore: 8,
  recommendedPageRange: { min: 12, max: 120 },
  executionMode: "sequential-pages",
  createChapterBriefs: generateWholeBookPageMap,
  ...sharedGeneration
} satisfies BookGenerationStrategy);

export const chapterWholePassStrategy = Object.freeze({
  id: CHAPTER_WHOLE_PASS_STRATEGY_ID,
  label: "Chapter whole-pass generation",
  strengthScore: 7,
  recommendedPageRange: { min: 16, max: 120 },
  executionMode: "chapter-whole-pass",
  createChapterBriefs: generateWholeBookPageMap,
  generateChapterDraft,
  ...sharedGeneration
} satisfies BookGenerationStrategy);

export const batchWindowStrategy = Object.freeze({
  id: BATCH_WINDOW_STRATEGY_ID,
  label: "Batch window generation",
  strengthScore: 6,
  recommendedPageRange: { min: 12, max: 80 },
  executionMode: "batch-window",
  batchSize: 4,
  createChapterBriefs: generateWholeBookPageMap,
  generateBatchDraft,
  ...sharedGeneration
} satisfies BookGenerationStrategy);

export const draftThenPolishStrategy = Object.freeze({
  id: DRAFT_THEN_POLISH_STRATEGY_ID,
  label: "Draft then polish",
  strengthScore: 9,
  recommendedPageRange: { min: 5, max: 40 },
  executionMode: "draft-then-polish",
  createChapterBriefs: generateWholeBookPageMap,
  generateWholeBookDraft,
  polishPageDraft,
  ...sharedGeneration
} satisfies BookGenerationStrategy);

export const researchGroundedStrategy = Object.freeze({
  id: RESEARCH_GROUNDED_STRATEGY_ID,
  label: "Research-grounded generation",
  strengthScore: 9,
  recommendedPageRange: { min: 12, max: 80 },
  executionMode: "sequential-pages",
  researchDepth: 12,
  createChapterBriefs: generateWholeBookPageMap,
  ...sharedGeneration
} satisfies BookGenerationStrategy);

export const researchMapDraftPolishStrategy = Object.freeze({
  id: RESEARCH_MAP_DRAFT_POLISH_STRATEGY_ID,
  label: "Research map draft & polish",
  strengthScore: 10,
  recommendedPageRange: { min: 12, max: 80 },
  executionMode: "draft-then-polish",
  researchDepth: 12,
  createChapterBriefs: generateWholeBookPageMap,
  generateWholeBookDraft,
  polishPageDraft,
  ...sharedGeneration
} satisfies BookGenerationStrategy);
