import type { BookPlan, CreateProjectInput } from "../../schemas/book.js";
import { isWritingMode, type WritingMode } from "../../schemas/styleContract.js";
import { inferWritingMode } from "../styleContract.js";

/**
 * Which books may carry figures: the analytical, instructional and reference
 * modes, never fiction and never a children's book. The same shape as the
 * evidence ledger's gate, and for the same reason — a mode is the plan's own
 * commitment when it made one, else the inference.
 */
export const FIGURE_WRITING_MODES: readonly WritingMode[] = ["analytical-history", "instructional", "reference"];

export function figureWritingMode(input: CreateProjectInput, plan: BookPlan): WritingMode {
  return isWritingMode(plan.writingMode) ? plan.writingMode : inferWritingMode(input, plan);
}

export function usesFigures(input: CreateProjectInput, plan: BookPlan): boolean {
  return input.category !== "KIDS" && FIGURE_WRITING_MODES.includes(figureWritingMode(input, plan));
}
