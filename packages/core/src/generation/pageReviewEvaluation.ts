import { z } from "zod";
import { bookPlanSchema, chapterBriefSchema, chapterPlanSchema, createProjectSchema, pageDraftSchema, pageProductionBeatSchema, pageQualityReportSchema } from "../schemas/book.js";
import type { DecisionOutcome } from "../adapters/decisions.js";

export type PageReviewObservation = {
  id: string;
  outcome?: DecisionOutcome | undefined;
  elapsedMs: number;
  diagnosticCalls: number;
  /** Absent means no independent prose/evidence adjudication was supplied. */
  adjudication?: "clean" | "defect" | undefined;
};
const percentile = (values: number[], fraction: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]! : null;
};
/** Routing comparisons, never an assumption that the diagnostic reviewer is truth. */
export function summarizePageReviewObservations(rows: PageReviewObservation[]) {
  const screened = rows.filter((row) => row.outcome);
  const comparable = screened.filter((row) => row.outcome?.disagreement !== undefined);
  const adjudicated = screened.filter((row) => row.adjudication !== undefined && row.outcome?.answers);
  const latencies = rows.map((row) => row.elapsedMs);
  const screenLatencies = screened.flatMap((row) => row.outcome?.screenDurationMs === undefined ? [] : [row.outcome.screenDurationMs]);
  return {
    examples: rows.length,
    screenOpportunities: screened.length,
    diagnosticCalls: rows.reduce((sum, row) => sum + row.diagnosticCalls, 0),
    fallbackFrequency: screened.length ? screened.filter((row) => !row.outcome?.wouldAvoidReview).length / screened.length : null,
    avoidedDiagnosticCalls: screened.filter((row) => row.outcome?.reviewAvoided).length,
    potentialAvoidedDiagnosticCalls: screened.filter((row) => row.outcome?.wouldAvoidReview).length,
    comparable: comparable.length,
    disagreements: comparable.filter((row) => row.outcome?.disagreement).map((row) => row.id),
    disagreementRate: comparable.length ? comparable.filter((row) => row.outcome?.disagreement).length / comparable.length : null,
    adjudicated: adjudicated.length,
    independentlyConfirmedMisses: adjudicated.filter((row) => row.adjudication === "defect" && row.outcome?.wouldAvoidReview).map((row) => row.id),
    totalLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    screenLatencyMs: { p50: percentile(screenLatencies, 0.5), p95: percentile(screenLatencies, 0.95) }
  };
}

export const savedReviewPageSchema = z.object({ index: z.number().int().positive(), title: z.string(), markdown: z.string(), summary: z.string() });
export const savedPageReviewFixtureSchema = z.object({
  id: z.string(), provenance: z.string(), adjudication: z.enum(["clean", "defect"]).optional(), frozenReview: pageQualityReportSchema.optional(),
  options: z.object({ input: createProjectSchema, plan: bookPlanSchema, chapter: chapterPlanSchema.optional(), chapterBrief: chapterBriefSchema.optional(), pageBrief: pageProductionBeatSchema.optional(),
    chapterPageStart: z.number().optional(), chapterPageEnd: z.number().optional(), pageIndex: z.number().int().positive(), draft: pageDraftSchema,
    previousPages: z.array(savedReviewPageSchema), nextPages: z.array(savedReviewPageSchema).optional(), continuityNotes: z.array(z.string()), researchNotes: z.array(z.string()).optional(), retrievedResearch: z.array(z.string()).optional(),
    styleExcerpts: z.array(z.string()).optional(), userRequest: z.string().optional() })
});
export const savedPageReviewFixturesSchema = z.array(savedPageReviewFixtureSchema);
export const savedReviewPagesSchema = z.array(savedReviewPageSchema.extend({ status: z.string().optional() }));
export type SavedPageReviewFixture = z.infer<typeof savedPageReviewFixtureSchema>;
