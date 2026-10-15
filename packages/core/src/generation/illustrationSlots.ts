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
  const appBookType = mobileBookType(input);
  if (isPictureBook(input, appBookType)) {
    return pictureBookIllustrationCap(input.targetPages);
  }
  const bookType = appBookType ?? inferredBookType(input.category, input.subcategory);
  return bookType === "workbook"
    ? 6
    : bookType === "lead_magnet" || bookType === "short_story"
      ? 4
      : Math.max(1, Math.ceil(input.targetPages / 8));
}

/** The most interior pictures a picture book is drawn and billed. */
export const PICTURE_BOOK_MAX_PICTURES = 12;

/**
 * **A children's picture book has a picture on every page up to twelve pages,
 * and twelve pictures spread across any longer one: `min(pages, 12)`.** It was
 * capped at four whatever its length — a 12-page bedtime book printed eight
 * sheets of words alone — and the picture book is what the store listing leads
 * with (launch review, 2026-10-13). The first rule after that, a picture a page
 * to twelve and then one per two pages, stepped *down* at thirteen (12 pages
 * drew 12, 13 drew 7), so a longer book got fewer pictures than a shorter one;
 * the count is now monotonic, and every picture book of 12 pages or more gets
 * twelve, at the tier's ordinary image rate (coordinator's decision,
 * 2026-10-13). Past twelve pages the slots are the existing even spread, so 24
 * pages draw pages 1, 3 … 23. The typesetter already gives every KIDS scene its
 * own sheet from 5 to 40 pages and sets a picture scene's words under a capped
 * picture (`pdfStoryPages.ts`), so no layout changed; past 40 pages the house
 * layout prints them inline. With a drawn cover, the largest free picture book
 * (30 pages, twelve pictures) is 1,175 plus its 40-credit plan, inside the
 * 1,250 welcome grant (`welcomeCredits.test.ts`). Mirrored by
 * `pictureBookIllustrationCount` in the app's `project_models.dart`.
 */
export function pictureBookIllustrationCap(pages: number): number {
  return Math.min(PICTURE_BOOK_MAX_PICTURES, Math.max(0, Math.round(pages)));
}

/**
 * A KIDS book the app made as a children's story (stored as `short_story`), or
 * a KIDS book with no app type at all. An Auto book (`custom`) keeps Auto's own
 * cap, because the app quotes Auto before its lane is known.
 */
function isPictureBook(input: CreateProjectInput, appBookType: LaunchBookType | undefined): boolean {
  return input.category === "KIDS" && (appBookType === "short_story" || appBookType === undefined);
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
