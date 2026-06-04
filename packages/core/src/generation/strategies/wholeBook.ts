import { compileBookMarkdown } from "../markdown.js";
import { generateBookPdf } from "../pdf.js";
import { createPlanningPackage, revisePlanningPackage } from "../planner.js";
import {
  generateChapterBrief,
  generateImageBytes,
  generatePageDraft,
  generateWholeBookDraft,
  repairPageBrief,
  reviewPageDraft,
  revisePageDraft,
  runFinalBookQa,
  shouldIllustratePage
} from "../pages.js";
import { WHOLE_BOOK_SINGLE_PASS_STRATEGY_ID } from "./ids.js";
import type { BookGenerationStrategy } from "./types.js";

export const wholeBookSinglePassStrategy = Object.freeze({
  id: WHOLE_BOOK_SINGLE_PASS_STRATEGY_ID,
  label: "Whole book single pass",
  strengthScore: 3,
  recommendedPageRange: { min: 5, max: 20 },
  executionMode: "whole-book",
  createPlan: createPlanningPackage,
  revisePlan: revisePlanningPackage,
  generateChapterBrief,
  generatePageDraft,
  generateWholeBookDraft,
  reviewPageDraft,
  repairPageBrief,
  revisePageDraft,
  runFinalBookQa,
  shouldIllustratePage,
  generateImageBytes,
  compileMarkdown: compileBookMarkdown,
  generatePdf: generateBookPdf
} satisfies BookGenerationStrategy);
