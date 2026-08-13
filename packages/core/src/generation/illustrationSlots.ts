import { isDiagramFriendlyBookCategory } from "../categories.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";

/**
 * Whether this page will get an interior illustration job.
 *
 * Billing counts the same slots via {@link interiorIllustrationSlotCount}, so
 * a quote cannot charge for images generation will never attempt. The `plan`
 * argument is unused; it stays on the signature because every generation
 * strategy exposes this as `(input, plan, pageIndex)`.
 */
export function shouldIllustratePage(input: CreateProjectInput, _plan: BookPlan, pageIndex: number): boolean {
  return pageGetsInteriorIllustration(input, pageIndex);
}

export function pageGetsInteriorIllustration(input: CreateProjectInput, pageIndex: number): boolean {
  if (!input.mediaSettings.fullIllustrations) {
    return false;
  }
  const cadence = input.mediaSettings.illustrationCadence;
  if (cadence === "manual") {
    return false;
  }
  if (cadence === "every-page") {
    return true;
  }
  if (input.category === "KIDS") {
    return true;
  }
  if (isDiagramFriendlyBookCategory(input.category)) {
    return pageIndex === 1 || pageIndex % 4 === 0;
  }
  return pageIndex === 1 || pageIndex % 8 === 0;
}

/**
 * How many interior illustration jobs a book of this shape will attempt.
 *
 * Not the billed count: KIDS every-page and diagram-friendly books can still
 * produce more than the launch cap charges for. The billed count is
 * `min(launchCap, this)`.
 */
export function interiorIllustrationSlotCount(input: CreateProjectInput, pageCount = input.targetPages): number {
  if (!input.mediaSettings.fullIllustrations) {
    return 0;
  }
  const pages = Math.max(0, Math.round(pageCount));
  let n = 0;
  for (let i = 1; i <= pages; i++) {
    if (pageGetsInteriorIllustration(input, i)) {
      n += 1;
    }
  }
  return n;
}
