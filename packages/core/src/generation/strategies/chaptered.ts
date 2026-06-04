import { compileBookMarkdown } from "../markdown.js";
import { generateBookPdf } from "../pdf.js";
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
import { CHAPTERED_SEQUENTIAL_STRATEGY_ID } from "./ids.js";
import type { BookGenerationStrategy } from "./types.js";

export const chapteredBookGenerationStrategy = Object.freeze({
  id: CHAPTERED_SEQUENTIAL_STRATEGY_ID,
  label: "Chaptered sequential generation",
  strengthScore: 7,
  recommendedPageRange: { min: 12, max: 80 },
  executionMode: "sequential-pages",
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
} satisfies BookGenerationStrategy);
