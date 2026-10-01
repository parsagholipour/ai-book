import { isDiagramFriendlyBookCategory } from "../categories.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { isRecord } from "../schemas/jsonCoercion.js";

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

/**
 * **An app book is illustrated on at most the pages it was billed for, spread
 * evenly over the pages its cadence picks.** Billing has always charged
 * `min(launchCap, slots)` while generation drew every slot: a KIDS book's
 * cadence is every page, so a 12-page children's story the app quoted "up to
 * 4 in-book illustrations" for would have drawn twelve, and a 24-page lead
 * magnet (diagram-friendly, seven slots) drew three it was never charged for.
 * The cap applies where there is a quote — a book carrying the app's `mobile`
 * metadata — and an operator book, which no one is charged for, keeps its
 * cadence's every slot. Pages past `targetPages` were never quoted, so an app
 * book does not illustrate them either.
 */
export function pageGetsInteriorIllustration(input: CreateProjectInput, pageIndex: number): boolean {
  if (!input.mediaSettings.fullIllustrations || !cadenceIllustratesPage(input, pageIndex)) {
    return false;
  }
  const cap = billedInteriorIllustrationCap(input);
  return cap === undefined || billedIllustrationPages(input, cap).includes(pageIndex);
}

/**
 * How many interior illustration jobs a book of this shape will attempt —
 * for an app book, never more than {@link interiorIllustrationLaunchCap}.
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

/**
 * The most interior illustrations a book of this type is billed for.
 *
 * The same rule `estimateInteriorImageCount` (`billing.ts`) applies to the
 * quote; it lives here because generation has to obey it, and generation
 * cannot import billing.
 */
export function interiorIllustrationLaunchCap(input: CreateProjectInput): number {
  const bookType = mobileBookType(input) ?? inferredBookType(input.category, input.subcategory);
  return bookType === "workbook"
    ? 6
    : bookType === "lead_magnet" || bookType === "short_story"
      ? 4
      : Math.max(1, Math.ceil(input.targetPages / 8));
}

function billedInteriorIllustrationCap(input: CreateProjectInput): number | undefined {
  return isRecord((input.mediaSettings as { mobile?: unknown }).mobile) ? interiorIllustrationLaunchCap(input) : undefined;
}

/** The cadence's pages within the quoted book, thinned to `cap` evenly when it picks more. */
function billedIllustrationPages(input: CreateProjectInput, cap: number): number[] {
  const slots: number[] = [];
  for (let index = 1; index <= input.targetPages; index++) {
    if (cadenceIllustratesPage(input, index)) slots.push(index);
  }
  if (slots.length <= cap) return slots;
  return Array.from({ length: cap }, (_, k) => slots[Math.floor((k * slots.length) / cap)]!);
}

function cadenceIllustratesPage(input: CreateProjectInput, pageIndex: number): boolean {
  const cadence = input.mediaSettings.illustrationCadence;
  if (cadence === "manual") {
    return false;
  }
  if (cadence === "every-page") {
    return true;
  }
  if (cadence === "every-third-page") {
    return pageIndex % 3 === 0;
  }
  if (input.category === "KIDS") {
    return true;
  }
  if (isDiagramFriendlyBookCategory(input.category)) {
    return pageIndex === 1 || pageIndex % 4 === 0;
  }
  return pageIndex === 1 || pageIndex % 8 === 0;
}

type LaunchBookType = "lead_magnet" | "workbook" | "short_story" | "custom";

/**
 * The product type the app stored, `custom` (Auto) included. Auto books are
 * now filed under the category their chat lane resolved — an Auto guide is
 * BUSINESS, an Auto workbook EDUCATION — and reading Auto through that
 * category billed it a concrete type's cap while the app quotes Auto as
 * `custom`, ⌈pages/8⌉. Auto keeps its own cap; the category still picks
 * which pages its pictures go on.
 */
function mobileBookType(input: CreateProjectInput): LaunchBookType | undefined {
  const mobile = (input.mediaSettings as { mobile?: unknown }).mobile;
  const bookType = isRecord(mobile) ? mobile.bookType : undefined;
  return bookType === "lead_magnet" || bookType === "workbook" || bookType === "short_story" || bookType === "custom"
    ? bookType
    : undefined;
}

function inferredBookType(category: string, subcategory?: string | null): LaunchBookType {
  if (subcategory === "Lead Magnet Ebook" || category === "BUSINESS" || category === "SELF_HELP") {
    return "lead_magnet";
  }
  if (subcategory === "Workbook or Study Guide" || category === "EDUCATION") {
    return "workbook";
  }
  if (subcategory === "Short Story" || category === "STORY") {
    return "short_story";
  }
  return "custom";
}
