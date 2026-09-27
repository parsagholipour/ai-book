import { createHash } from "node:crypto";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import type { PriorPageContext } from "./pagesShared.js";
import type { PictureBookReviewChecks } from "./pictureBookReviewValidation.js";

/** v13 diagnoses scenes before page verdicts, with one evidence standard and repair history. */
export const PICTURE_BOOK_REVIEW_CONTRACT = 13;

export function pictureBookReviewChapters(plan: BookPlan) {
  let startPageIndex = 1;
  return (plan.chapters ?? []).map(({ index, title, targetPages }) => {
    const chapter = { index, title, startPageIndex, endPageIndex: startPageIndex + targetPages - 1 };
    startPageIndex += targetPages;
    return chapter;
  });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Summaries/briefs are no longer reviewer inputs. Every actual prose/context dependency is bound. */
export function pictureBookReviewFingerprint(options: {
  input: CreateProjectInput; plan: BookPlan; pages: readonly PriorPageContext[]; checks: PictureBookReviewChecks;
}): string {
  return createHash("sha256").update(JSON.stringify(stable({ contract: PICTURE_BOOK_REVIEW_CONTRACT,
    input: options.input, plan: options.plan, checks: options.checks,
    pages: options.pages.map(({ index, title, markdown }) => ({ index, title, markdown }))
  }))).digest("hex");
}
