import { createHash } from "node:crypto";
import {
  manuscriptCoverageIssues, manuscriptCoverageSchema, reviewManuscriptCoverage,
  type CoveragePage, type ManuscriptCoverage, type ManuscriptQualityIssue, type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";

export type StoredManuscriptCoverage = { fingerprint: string; review: ManuscriptCoverage };

export function manuscriptCoverageFingerprint(brief: string, promises: readonly string[], pages: readonly CoveragePage[]): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, brief, promises, pages: [...pages]
    .sort((a, b) => a.index - b.index).map(({ index, markdown }) => ({ index, markdown })) })).digest("hex");
}

/** Recompiles reuse only evidence for exactly the same brief, promises and final page text. */
export async function manuscriptCoverageForCompile(options: {
  projectId: string; brief: string; promises: readonly string[]; pages: readonly CoveragePage[];
  textModel: TextModelAdapter; allowModelReview: boolean;
}): Promise<{ issues: ManuscriptQualityIssue[]; stored: StoredManuscriptCoverage }> {
  const promises = [...new Set(options.promises)].sort();
  const fingerprint = manuscriptCoverageFingerprint(options.brief, promises, options.pages);
  try {
    const cached = await prisma.generationJob.findFirst({
      where: { projectId: options.projectId, type: "COMPILE_EXPORT", qualityReport: { path: ["briefCoverage", "fingerprint"], equals: fingerprint } },
      orderBy: { createdAt: "desc" }, select: { qualityReport: true }
    });
    const report = cached?.qualityReport;
    const stored = report && typeof report === "object" && !Array.isArray(report) ? report.briefCoverage : null;
    const review = manuscriptCoverageSchema.safeParse(stored && typeof stored === "object" && !Array.isArray(stored) ? stored.review : null);
    if (stored && typeof stored === "object" && !Array.isArray(stored) && stored.fingerprint === fingerprint && review.success && review.data.status === "reviewed") {
      return { stored: { fingerprint, review: review.data }, issues: manuscriptCoverageIssues(review.data) };
    }
  } catch (error) {
    if (isStopRequestedError(error)) throw error;
    // A cache miss never prevents the review or grants an unverified pass.
  }
  const result = options.allowModelReview
    ? await reviewManuscriptCoverage({ brief: options.brief, promises, pages: options.pages, textModel: options.textModel })
    : { status: "unavailable" as const, requirements: [] };
  const review: ManuscriptCoverage = { status: result.status, requirements: result.requirements };
  return { stored: { fingerprint, review }, issues: "issues" in result ? result.issues : manuscriptCoverageIssues(review) };
}
