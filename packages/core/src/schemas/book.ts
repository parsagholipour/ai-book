import { z } from "zod";
import { isRecord, numberField, stringArrayField, stringField, booleanField, arrayField, unwrapJsonObject } from "./jsonCoercion.js";

/**
 * Page and QA schemas. The project-input cluster lives in mediaSettings.ts and
 * the plan tree in plan.ts; both are re-exported here so the package surface
 * (and every "schemas/book.js" import) is unchanged.
 */

export * from "./mediaSettings.js";
export * from "./plan.js";

export const GROUNDING_STATUSES = [
  "not_applicable",
  "unverified_no_sources",
  "verified",
  "failed",
  "unavailable"
] as const;

export type GroundingStatus = (typeof GROUNDING_STATUSES)[number];

function summaryFromMarkdown(markdown: string | undefined): string {
  if (!markdown) {
    return "";
  }

  const plain = markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= 240) {
    return plain;
  }

  const clipped = plain.slice(0, 240);
  const lastSpace = clipped.lastIndexOf(" ");
  const end = lastSpace > 160 ? lastSpace : 240;
  return `${clipped.slice(0, end).trim()}...`;
}

function normalizePageDraft(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["pageDraft", "draft", "page", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const title = stringField(unwrapped, ["title", "pageTitle", "heading"]);
  const markdown = stringField(unwrapped, ["markdown", "body", "content", "text", "pageMarkdown"]);
  const summary = stringField(unwrapped, ["summary", "synopsis", "pageSummary"]);
  const imagePrompt = stringField(unwrapped, ["imagePrompt", "illustrationPrompt", "visualPrompt"]);

  return {
    title,
    markdown,
    summary: summary ?? summaryFromMarkdown(markdown),
    continuityNotes: stringArrayField(unwrapped, ["continuityNotes", "continuity"]) ?? [],
    ...(imagePrompt ? { imagePrompt } : {})
  };
}

function normalizePageProductionBeat(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    pageIndex: numberField(value, ["pageIndex", "pageNumber", "page", "index"]),
    chapterIndex: numberField(value, ["chapterIndex", "chapterNumber", "chapter"]) ?? 1,
    purpose: stringField(value, ["purpose", "goal", "objective"]),
    beat: stringField(value, ["beat", "action", "event", "description", "summary"]),
    requiredContinuity: arrayField(value, ["requiredContinuity", "continuity", "continuityNotes"]) ?? [],
    endingPressure: stringField(value, ["endingPressure", "nextPagePressure", "hook", "transition"]),
    imageMoment: stringField(value, ["imageMoment", "visualMoment", "imagePrompt"])
  };
}

function normalizeChapterBrief(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["chapterBrief", "brief", "productionBrief", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const pageBeats = arrayField(unwrapped, ["pages", "pageBeats", "beats"]);
  if (!pageBeats) {
    return unwrapped;
  }

  const inferredChapterIndex =
    numberField(unwrapped, ["chapterIndex", "chapterNumber", "chapter"]) ??
    pageBeats.map((page) => (isRecord(page) ? numberField(page, ["chapterIndex", "chapterNumber", "chapter"]) : undefined)).find(Boolean) ??
    1;
  const firstPageIndex =
    pageBeats.map((page) => (isRecord(page) ? numberField(page, ["pageIndex", "pageNumber", "page", "index"]) : undefined)).find(Boolean) ??
    1;

  return {
    ...unwrapped,
    chapterIndex: inferredChapterIndex,
    title: stringField(unwrapped, ["title", "chapterTitle"]) ?? "",
    summary: stringField(unwrapped, ["summary", "chapterSummary"]) ?? "",
    pages: pageBeats.map((page, index) => {
      const pageRecord = isRecord(page) ? page : undefined;
      const normalized = normalizePageProductionBeat(page);
      if (!isRecord(normalized)) {
        return normalized;
      }
      return {
        ...normalized,
        chapterIndex: pageRecord
          ? numberField(pageRecord, ["chapterIndex", "chapterNumber", "chapter"]) ?? inferredChapterIndex
          : inferredChapterIndex,
        pageIndex: pageRecord
          ? numberField(pageRecord, ["pageIndex", "pageNumber", "page", "index"]) ?? firstPageIndex + index
          : firstPageIndex + index
      };
    }),
    continuityFocus: arrayField(unwrapped, ["continuityFocus", "continuity", "continuityNotes"]) ?? []
  };
}

/**
 * Coerces a model-reported score onto the schema's integer 0–100.
 *
 * The postprocess schemas demand an int in [0,100], so `score: 87.5` used to
 * fail validation outright and burn a full revise/restart cycle at real token
 * cost. A score that is plainly on a 0–10 scale — the reply says so
 * (`outOf: 10`), or it is a fraction at or under 10 — is rescaled; an
 * ambiguous small *integer* is left alone rather than guessed into ten times
 * itself, since a genuinely terrible 8/100 must not become a perfect 80.
 */
function normalizeQualityScore(score: number, outOf: number | undefined): number {
  const tenScale = outOf === 10 || (score >= 0 && score <= 10 && !Number.isInteger(score));
  const scaled = tenScale ? score * 10 : score;
  return Math.min(100, Math.max(0, Math.round(scaled)));
}

function normalizePageQualityReport(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["qualityReport", "report", "review", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const approvedFromModel =
    typeof unwrapped.approved === "boolean"
      ? unwrapped.approved
      : typeof unwrapped.pass === "boolean"
        ? unwrapped.pass
        : undefined;

  const scoreFromModel = numberField(unwrapped, ["score", "qualityScore", "rating", "grade"]);
  const score =
    scoreFromModel !== undefined
      ? normalizeQualityScore(scoreFromModel, numberField(unwrapped, ["outOf", "scale", "maxScore"]))
      : approvedFromModel === true
        ? 85
        : approvedFromModel === false
          ? 45
          : 70;

  let issues = stringArrayField(unwrapped, ["issues", "problems", "concerns", "flags"]) ?? [];
  let notes = stringField(unwrapped, ["notes", "summary", "rationale"]) ?? "";
  const feedback = stringField(unwrapped, ["feedback", "critique", "commentary", "review"]);
  if (issues.length === 0 && feedback) {
    if (approvedFromModel === false) {
      issues = [feedback];
    } else {
      notes = notes || feedback;
    }
  }

  const approved = approvedFromModel ?? score >= 75;
  const requiredRevisions =
    stringArrayField(unwrapped, [
      "requiredRevisions",
      "requiredRevision",
      "revisions",
      "fixes",
      "requiredFixes",
      "suggestions"
    ]) ?? [];

  const checksRecord = isRecord(unwrapped.checks)
    ? unwrapped.checks
    : isRecord(unwrapped.checklist)
      ? unwrapped.checklist
      : undefined;
  const checks = checksRecord
    ? {
        placeholderFree: booleanField(checksRecord, ["placeholderFree", "placeholder_free"]) ?? true,
        promptLeakFree: booleanField(checksRecord, ["promptLeakFree", "prompt_leak_free"]) ?? true,
        titleClean: booleanField(checksRecord, ["titleClean", "title_clean"]) ?? true,
        repetitionOk: booleanField(checksRecord, ["repetitionOk", "repetition_ok"]) ?? true,
        progressionOk: booleanField(checksRecord, ["progressionOk", "progression_ok"]) ?? true,
        styleNatural: booleanField(checksRecord, ["styleNatural", "style_natural", "naturalStyle", "natural_style"]) ?? true
      }
    : undefined;

  const groundingStatusFromInput = stringField(unwrapped, ["groundingStatus", "grounding_status"]);
  const groundedOk =
    groundingStatusFromInput !== undefined
      ? groundingStatusFromInput !== "failed"
      : booleanField(unwrapped, ["groundedOk", "grounded_ok"]) ?? true;
  const groundingStatus =
    groundingStatusFromInput ?? (groundedOk ? "not_applicable" : "failed");
  const unsupportedClaims = stringArrayField(unwrapped, ["unsupportedClaims", "unsupported_claims"]) ?? [];

  return {
    approved,
    score,
    issues,
    requiredRevisions,
    notes,
    groundedOk,
    groundingStatus,
    unsupportedClaims,
    ...(checks ? { checks } : {})
  };
}

function normalizeFinalBookQa(value: unknown): unknown {
  const unwrapped = unwrapJsonObject(["finalBookQa", "finalQa", "qa", "report", "data", "result"])(value);
  if (!isRecord(unwrapped)) {
    return unwrapped;
  }

  const approvedFromModel = typeof unwrapped.approved === "boolean" ? unwrapped.approved : undefined;
  const scoreFromModel = numberField(unwrapped, ["score", "qualityScore", "rating", "grade"]);
  const score =
    scoreFromModel !== undefined
      ? normalizeQualityScore(scoreFromModel, numberField(unwrapped, ["outOf", "scale", "maxScore"]))
      : approvedFromModel === true
        ? 85
        : approvedFromModel === false
          ? 45
          : 70;

  let issues =
    stringArrayField(unwrapped, ["issues", "problems", "concerns", "flags", "reasons", "rejectionReasons"]) ?? [];
  let notes = stringField(unwrapped, ["notes", "summary", "rationale"]) ?? "";
  const feedback = stringField(unwrapped, ["feedback", "critique", "commentary", "review"]);
  if (issues.length === 0 && feedback) {
    if (approvedFromModel === false) {
      issues = [feedback];
    } else {
      notes = notes || feedback;
    }
  }

  const approved = approvedFromModel ?? score >= 75;
  const requiredFixes =
    stringArrayField(unwrapped, [
      "requiredFixes",
      "requiredFix",
      "requiredRevisions",
      "revisions",
      "fixes",
      "suggestions"
    ]) ?? [];

  return {
    approved,
    score,
    issues,
    requiredFixes,
    notes
  };
}

export const pageDraftSchema = z.preprocess(
  normalizePageDraft,
  z.object({
    title: z.string(),
    markdown: z
      .string()
      .refine((value) => value.trim().length > 0, { message: "Page markdown must not be empty." }),
    summary: z.string(),
    continuityNotes: z.array(z.string()).default([]),
    imagePrompt: z.string().optional()
  })
);

export const pageProductionBeatSchema = z.preprocess(
  normalizePageProductionBeat,
  z.object({
    pageIndex: z.number().int().positive(),
    chapterIndex: z.number().int().positive(),
    purpose: z.string(),
    beat: z.string(),
    requiredContinuity: z.array(z.string()).default([]),
    endingPressure: z.string(),
    imageMoment: z.string().optional()
  })
);

export const chapterBriefSchema = z.preprocess(
  normalizeChapterBrief,
  z.object({
    chapterIndex: z.number().int().positive(),
    title: z.string(),
    summary: z.string(),
    pages: z.array(pageProductionBeatSchema).min(1),
    continuityFocus: z.array(z.string()).default([])
  })
);

export const pageQualityReportSchema = z.preprocess(
  normalizePageQualityReport,
  z.object({
    approved: z.boolean(),
    score: z.number().int().min(0).max(100),
    issues: z.array(z.string()).default([]),
    requiredRevisions: z.array(z.string()).default([]),
    notes: z.string().default(""),
    groundedOk: z.boolean().default(true),
    groundingStatus: z.enum(GROUNDING_STATUSES).optional(),
    unsupportedClaims: z.array(z.string()).default([]),
    checks: z
      .object({
        placeholderFree: z.boolean(),
        promptLeakFree: z.boolean(),
        titleClean: z.boolean(),
        repetitionOk: z.boolean(),
        progressionOk: z.boolean(),
        styleNatural: z.boolean()
      })
      .default({
        placeholderFree: true,
        promptLeakFree: true,
        titleClean: true,
        repetitionOk: true,
        progressionOk: true,
        styleNatural: true
      })
  })
);

export const finalBookQaSchema = z.preprocess(
  normalizeFinalBookQa,
  z.object({
    approved: z.boolean(),
    score: z.number().int().min(0).max(100),
    issues: z.array(z.string()).default([]),
    requiredFixes: z.array(z.string()).default([]),
    notes: z.string().default("")
  })
);

export type PageDraft = z.infer<typeof pageDraftSchema>;
export type PageProductionBeat = z.infer<typeof pageProductionBeatSchema>;
export type ChapterBrief = z.infer<typeof chapterBriefSchema>;
export type PageQualityReport = z.infer<typeof pageQualityReportSchema>;
export type FinalBookQa = z.infer<typeof finalBookQaSchema>;
