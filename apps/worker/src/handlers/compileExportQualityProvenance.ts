import type { PageTextSnapshot } from "../generation/bookHelpers.js";
import type { ManuscriptQualityReport } from "@book-maker/core";
import { createHash } from "node:crypto";

/** Compact, exact evidence of the page snapshot a stored compile report graded. */
export interface ReviewedPageFingerprint {
  index: number;
  revision: number;
  contentHash: string;
}

export interface StoredQualityProvenance {
  version: 1;
  finalReviewRan: boolean;
  deterministicWarningsAffectVerdict: boolean;
  reviewedPages: ReviewedPageFingerprint[];
}

const PROVENANCE_KEY = "_standDownProvenance";

/**
 * Adds worker-private provenance to the JSON report. API normalizers read only
 * the public report fields, while a Bull redelivery can prove which keeper the
 * findings describe without storing a second copy of the manuscript.
 */
export function qualityReportWithProvenance(
  report: ManuscriptQualityReport,
  options: {
    finalReviewRan: boolean;
    deterministicWarningsAffectVerdict?: boolean;
    reviewedPages: PageTextSnapshot[] | ReviewedPageFingerprint[];
  }
): ManuscriptQualityReport {
  const reviewedPages = options.reviewedPages.map((page) =>
    "contentHash" in page ? page : fingerprintPage(page)
  );
  return {
    ...report,
    [PROVENANCE_KEY]: {
      version: 1,
      finalReviewRan: options.finalReviewRan,
      deterministicWarningsAffectVerdict:
        options.deterministicWarningsAffectVerdict ?? options.finalReviewRan,
      reviewedPages
    }
  } as ManuscriptQualityReport;
}

/** Returns null for legacy reports whose reviewed manuscript cannot be proved. */
export function storedQualityProvenance(value: unknown): StoredQualityProvenance | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[PROVENANCE_KEY];
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  if (record.version !== 1 || typeof record.finalReviewRan !== "boolean" || !Array.isArray(record.reviewedPages)) {
    return null;
  }
  if (
    record.deterministicWarningsAffectVerdict !== undefined &&
    typeof record.deterministicWarningsAffectVerdict !== "boolean"
  ) {
    return null;
  }
  const reviewedPages: ReviewedPageFingerprint[] = [];
  const indexes = new Set<number>();
  for (const value of record.reviewedPages) {
    const page = parseFingerprint(value);
    if (page === null || indexes.has(page.index)) return null;
    indexes.add(page.index);
    reviewedPages.push(page);
  }
  return {
    version: 1,
    finalReviewRan: record.finalReviewRan,
    // Reports written before this field existed used finalReviewRan for this
    // decision, so that is the only honest legacy reconstruction.
    deterministicWarningsAffectVerdict:
      record.deterministicWarningsAffectVerdict ?? record.finalReviewRan,
    reviewedPages
  };
}

/** Which current page positions no longer match the durable reviewed snapshot. */
export function pagesOutsideStoredQualityProvenance(
  reviewed: ReviewedPageFingerprint[],
  current: PageTextSnapshot[]
): Set<number> {
  const currentByIndex = new Map(current.map((page) => [page.index, page]));
  const reviewedIndexes = new Set(reviewed.map((page) => page.index));
  const moved = new Set<number>();
  for (const page of reviewed) {
    const now = currentByIndex.get(page.index);
    if (!now || now.revision !== page.revision || fingerprintPage(now).contentHash !== page.contentHash) {
      moved.add(page.index);
    }
  }
  for (const page of current) {
    if (!reviewedIndexes.has(page.index)) moved.add(page.index);
  }
  return moved;
}

function fingerprintPage(page: PageTextSnapshot): ReviewedPageFingerprint {
  return {
    index: page.index,
    revision: page.revision,
    contentHash: createHash("sha256").update(JSON.stringify([page.title, page.markdown])).digest("hex")
  };
}

function parseFingerprint(value: unknown): ReviewedPageFingerprint | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.index) ||
    Number(record.index) < 1 ||
    !Number.isInteger(record.revision) ||
    Number(record.revision) < 0 ||
    typeof record.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.contentHash)
  ) {
    return null;
  }
  return { index: Number(record.index), revision: Number(record.revision), contentHash: record.contentHash };
}
