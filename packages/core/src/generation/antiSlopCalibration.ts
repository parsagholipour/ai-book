import { decodeGeneratedChapterBrief, PageMapResponseInvalidError } from "./generatedChapterBriefAcceptance.js";
import { MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION } from "./manuscriptQualityIssue.js";
import {
  DUPLICATE_TREATMENT_CLUSTER_BLOCKING_MIN_PAGES,
  STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING,
  STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS,
  STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES
} from "./manuscriptQualityPolicy.js";
import { replayDeterministicManuscriptChecks } from "./manuscriptReplay.js";
import {
  MANUSCRIPT_REVIEW_MAX_CALLS,
  MANUSCRIPT_REVIEW_PACKS_PER_CALL,
  MANUSCRIPT_REVIEW_PACK_MAX_PAGES,
  MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS
} from "./manuscriptReviewPacks.js";
import { MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE } from "./manuscriptStructuralReview.js";
import { PRODUCTION_MAP_AUDIT_VERSION, auditProductionMap, productionMapContractFromRanges } from "./productionMapAudit.js";
import {
  malformedGeneratedChapterBriefFixtures,
  mechanicsChapterBriefContract
} from "./testing/generatedChapterBriefFixtures.js";
import {
  fourParaphrasedIndusWeightPages,
  indusSubjectDistinctEvidencePages,
  manuscriptWideSymmetricalHedgingPages,
  persianWithEnglishHedgeIslands
} from "./testing/manuscriptStructuralAuditFixtures.js";
import { collidingBriefs } from "./testing/pageBeatDedupFixtures.js";
import {
  deliberateParallelChapterPages,
  fictionMotifPages,
  importedShortPages,
  instructionalTerminologyPages
} from "./testing/antiSlopCalibrationFixtures.js";

export const ANTI_SLOP_DETECTOR_VERSION = MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION;
export const ANTI_SLOP_PRODUCTION_MAP_DETECTOR_VERSION = PRODUCTION_MAP_AUDIT_VERSION;

export const ANTI_SLOP_PROVIDER_PURPOSES = [
  "generate-chapter-brief",
  "dedupe-page-beats",
  "review-manuscript-structure"
] as const;

export const ANTI_SLOP_STRUCTURAL_REVIEW_BOUNDS = {
  packsPerCall: MANUSCRIPT_REVIEW_PACKS_PER_CALL,
  maxCalls: MANUSCRIPT_REVIEW_MAX_CALLS,
  maxPagesPerPack: MANUSCRIPT_REVIEW_PACK_MAX_PAGES,
  maxProseChars: MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS,
  purpose: MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE
} as const;

export const ANTI_SLOP_THRESHOLD_STATUS = "unchanged, provisional" as const;

export const ANTI_SLOP_LIVE_GATES_MET = false;
export const PHASE_06_AUTOMATIC_CONSOLIDATION_ENTRY_MET = false;

export const ANTI_SLOP_LIVE_RELEASE_GATES = {
  classifiedBooks: { required: 50, measured: false as const, value: null },
  observationDays: { required: 7, measured: false as const, value: null },
  hardBlockFalsePositiveRate: { required: 0.02, measured: false as const, value: null },
  highConfidenceOverturnRate: { required: 0.1, measured: false as const, value: null },
  completionRegression: { required: "none", measured: false as const, value: null }
};

export const ANTI_SLOP_ROLLOUT_STAGES = {
  stage1Shadow: "wouldBlock diagnostics and BOOK_MAKER_PRODUCTION_MAP_INTEGRITY=shadow",
  stage2PageMapDefaultOn: "page-map integrity default enforce; env shadow switch retained",
  stage3Manuscript: "Phase 04 blocks high-confidence corroborated clusters; Phase 03 prevalence stays wouldBlock",
  stage4FlagRemoval: "documented removal plan; flags not deleted this phase"
} as const;

export const BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV = "BOOK_MAKER_PRODUCTION_MAP_INTEGRITY";

export const ANTI_SLOP_FLAG_REMOVAL_PLAN = {
  env: BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV,
  removeAfter:
    "≥50 classified books or 7 days of normal volume, whichever is larger, and <2% hard-block false positives on a live clean-control set. None of those live gates are measured in this environment."
} as const;

export const ANTI_SLOP_METRICS_FIELDS = [
  "invalidChapterBriefRate",
  "schemaRepairSuccessRate",
  "denseChapterRegenerationRate",
  "productionMapFindings",
  "structuralFindingRateByCodeAndDetectorVersion",
  "candidateToConfirmedModelReviewRate",
  "reviewRequiredRate",
  "manualOverturnRate",
  "addedModelCallsAndTokensPerBook",
  "cleanPathNoCallRate",
  "deterministicAuditLatencyMs",
  "generationCompletionAndRetryRates"
] as const;

export const ANTI_SLOP_SHADOW_PREVALENCE_THRESHOLDS = {
  duplicateTreatmentClusterMinPages: DUPLICATE_TREATMENT_CLUSTER_BLOCKING_MIN_PAGES,
  structuralFamilyPageRatio: STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING,
  occurrenceSpanMinOccurrences: STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES,
  occurrenceSpanMinChapters: STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS
} as const;

export type AntiSlopFixtureKind = "known-failure" | "clean" | "boundary";

export type AntiSlopFixtureReplay = {
  id: string;
  kind: AntiSlopFixtureKind;
  passed: boolean;
  detail: string;
};

export type AntiSlopCalibrationReport = {
  detectorVersion: string;
  productionMapDetectorVersion: string;
  liveGatesMet: false;
  phase06AutomaticConsolidationEntryMet: false;
  thresholdStatus: typeof ANTI_SLOP_THRESHOLD_STATUS;
  fixtures: AntiSlopFixtureReplay[];
};

/**
 * Distilled-fixture replay only. Never reads `storage/`. Live 50-book / 7-day
 * gates are structurally present on this report and remain unmet.
 */
export async function replayAntiSlopCalibration(): Promise<AntiSlopCalibrationReport> {
  const fixtures: AntiSlopFixtureReplay[] = [];

  for (const fixture of malformedGeneratedChapterBriefFixtures) {
    let passed = false;
    let detail = "did not throw";
    try {
      decodeGeneratedChapterBrief(fixture.raw, mechanicsChapterBriefContract);
    } catch (error) {
      passed =
        error instanceof PageMapResponseInvalidError &&
        error.violations.some((violation) => violation.code === fixture.expectedCode);
      detail = passed
        ? fixture.expectedCode
        : error instanceof PageMapResponseInvalidError
          ? error.violations.map((violation) => violation.code).join(",")
          : String(error);
    }
    fixtures.push({
      id: `malformed-map:${fixture.name}`,
      kind: "known-failure",
      passed,
      detail
    });
  }

  const colliding = collidingBriefs();
  const pages = colliding.flatMap((brief) => brief.pages);
  const last = Math.max(...pages.map((page) => page.pageIndex));
  const audit = await auditProductionMap(
    colliding,
    productionMapContractFromRanges(
      last,
      colliding.map((brief) => {
        const indexes = brief.pages.map((page) => page.pageIndex);
        return {
          chapterIndex: brief.chapterIndex,
          startPage: Math.min(...indexes),
          endPage: Math.max(...indexes)
        };
      })
    )
  );
  fixtures.push({
    id: "malformed-map:colliding-briefs",
    kind: "known-failure",
    passed: audit.blocking,
    detail: audit.findings.map((finding) => finding.code).join(",")
  });

  fixtures.push(manuscriptFixture("known-failure:indus-paraphrase", "known-failure", fourParaphrasedIndusWeightPages(), {
    expectFinding: "SAME_CHAPTER_TREATMENT_REPETITION"
  }));
  fixtures.push(manuscriptFixture("known-failure:hedge-saturation", "known-failure", manuscriptWideSymmetricalHedgingPages(), {
    expectWouldBlock: true
  }));
  fixtures.push(manuscriptFixture("clean:distinct-evidence", "clean", indusSubjectDistinctEvidencePages(), {
    forbidFinding: "SAME_CHAPTER_TREATMENT_REPETITION"
  }));
  fixtures.push(manuscriptFixture("clean:fiction-motif", "clean", fictionMotifPages(), { expectCleanish: true }));
  fixtures.push(
    manuscriptFixture("clean:instructional-terminology", "clean", instructionalTerminologyPages(), {
      expectCleanish: true
    })
  );
  fixtures.push(manuscriptFixture("boundary:imported-short", "boundary", importedShortPages(), { expectCleanish: true }));
  fixtures.push(
    manuscriptFixture("boundary:non-english", "boundary", persianWithEnglishHedgeIslands(), {
      language: "fa",
      expectCleanish: true
    })
  );
  fixtures.push(
    manuscriptFixture("boundary:deliberate-parallel", "boundary", deliberateParallelChapterPages(), {
      expectCleanish: true
    })
  );

  return {
    detectorVersion: ANTI_SLOP_DETECTOR_VERSION,
    productionMapDetectorVersion: ANTI_SLOP_PRODUCTION_MAP_DETECTOR_VERSION,
    liveGatesMet: false,
    phase06AutomaticConsolidationEntryMet: false,
    thresholdStatus: ANTI_SLOP_THRESHOLD_STATUS,
    fixtures
  };
}

function manuscriptFixture(
  id: string,
  kind: AntiSlopFixtureKind,
  pages: ReturnType<typeof fourParaphrasedIndusWeightPages>,
  options: {
    expectFinding?: string;
    forbidFinding?: string;
    expectWouldBlock?: boolean;
    expectCleanish?: boolean;
    language?: string;
  }
): AntiSlopFixtureReplay {
  const replayed = replayDeterministicManuscriptChecks({
    pages,
    expectedPageCount: pages.length,
    ...(options.language ? { language: options.language } : {})
  });
  const codes = replayed.issues.map((issue) => issue.code);
  let passed = true;
  let detail = codes.join(",") || "none";
  if (options.expectFinding) {
    passed = codes.includes(options.expectFinding);
    detail = passed ? options.expectFinding : `missing ${options.expectFinding}; had ${detail}`;
  }
  if (options.forbidFinding) {
    passed = passed && !codes.includes(options.forbidFinding);
    if (codes.includes(options.forbidFinding)) {
      detail = `unexpected ${options.forbidFinding}`;
    }
  }
  if (options.expectWouldBlock) {
    passed = passed && replayed.diagnostics.wouldBlock === true;
    if (!replayed.diagnostics.wouldBlock) {
      detail = "wouldBlock was false";
    }
  }
  if (options.expectCleanish) {
    const publicationBlocking = replayed.report.state === "blocked";
    passed = passed && !publicationBlocking;
    if (publicationBlocking) {
      detail = `blocked with ${detail}`;
    }
  }
  return { id, kind, passed, detail };
}
