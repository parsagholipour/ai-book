import { MAX_PICTURE_BOOK_PAGES } from "./pageCountAllowance.js";
import { z } from "zod";
import { pictureBookFindingSchema, pictureBookReviewRowSchema } from "./pictureBookReviewValidation.js";

export const UNRESOLVED_PICTURE_BOOK_FINDING = "Unresolved manuscript finding: ";
/** Retain the diagnosis as diagnostic data, without granting it repair scope. */
export function unresolvedPictureBookFinding(finding: unknown): string {
  return `${UNRESOLVED_PICTURE_BOOK_FINDING}${JSON.stringify(finding)}`;
}

/** Diagnose whole-scene defects before committing to individual page verdicts.
 * Canonical stored reviews keep their existing per-page finding contract. */
export function pictureBookFindingsFirstSchema(repair: boolean) {
  const row = repair ? pictureBookReviewRowSchema : pictureBookReviewRowSchema.omit({ repairAssessment: true, requirementAssessments: true });
  return z.strictObject({
    findings: z.array(pictureBookFindingSchema.extend({ pageIndex: z.number().int().positive() })).max(160),
    pages: z.array(row.omit({ findings: true })).min(1).max(MAX_PICTURE_BOOK_PAGES)
  });
}

/** Accept legacy per-page responses too. Never discard an unowned diagnosis or
 * use a clean page row to overwrite a manuscript-level finding. */
export function distributePictureBookFindings(raw: { pages: unknown[]; findings?: unknown[] | undefined }) {
  if (raw.findings === undefined) return { pages: raw.pages, protocolIssues: [] as string[] };
  const protocolIssues: string[] = [];
  const byPage = new Map<number, unknown[]>();
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const finding of raw.findings) {
    if (!record(finding) || typeof finding.pageIndex !== "number" || !Number.isInteger(finding.pageIndex) ||
      !raw.pages.some(page => record(page) && page.pageIndex === finding.pageIndex)) {
      protocolIssues.push(unresolvedPictureBookFinding(finding));
      continue;
    }
    const { pageIndex, ...diagnosis } = finding;
    byPage.set(pageIndex, [...(byPage.get(pageIndex) ?? []), diagnosis]);
  }
  return { pages: raw.pages.map(page => {
    if (!record(page)) return page;
    if (page.findings !== undefined && (!Array.isArray(page.findings) || page.findings.length > 0))
      protocolIssues.push(unresolvedPictureBookFinding({ pageIndex: page.pageIndex, findings: page.findings }));
    return { ...page, findings: byPage.get(page.pageIndex as number) ?? [] };
  }), protocolIssues };
}
