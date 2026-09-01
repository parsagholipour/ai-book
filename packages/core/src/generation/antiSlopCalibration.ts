import { decodeGeneratedChapterBrief, PageMapResponseInvalidError } from "./generatedChapterBriefAcceptance.js";
import { MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION, type ManuscriptIntegrityPage } from "./manuscriptQualityIssue.js";
import {
  DUPLICATE_CLUSTER_BLOCKING_MIN_PAGES,
  STRUCTURAL_FAMILY_PAGE_RATIO_BLOCKING,
  STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_CHAPTERS,
  STRUCTURAL_OCCURRENCE_SPAN_BLOCKING_MIN_OCCURRENCES
} from "./manuscriptQualityPolicy.js";
import { replayDeterministicManuscriptChecks } from "./manuscriptReplay.js";
import {
  MANUSCRIPT_REVIEW_MAX_CALLS,
  MANUSCRIPT_REVIEW_MAX_OUTPUT_TOKENS,
  MANUSCRIPT_REVIEW_PACKS_PER_CALL,
  MANUSCRIPT_REVIEW_PACK_MAX_PAGES,
  MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS,
  MANUSCRIPT_REVIEW_TEMPERATURE
} from "./manuscriptReviewPacks.js";
import { MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE } from "./manuscriptStructuralReview.js";
import { PRODUCTION_MAP_AUDIT_VERSION, auditProductionMap, productionMapContractFromRanges } from "./productionMapAudit.js";
import { STYLE_CONTRACT_VERSION } from "./styleContract.js";
import {
  malformedGeneratedChapterBriefFixtures,
  mechanicsChapterBriefContract
} from "./testing/generatedChapterBriefFixtures.js";
import {
  indusSubjectDistinctEvidencePages,
  manuscriptWideSymmetricalHedgingPages,
  persianWithEnglishHedgeIslands
} from "./testing/manuscriptStructuralAuditFixtures.js";
import { anchorCollidingBriefs, collidingBriefs } from "./testing/pageBeatDedupFixtures.js";
import {
  deliberateParallelChapterPages,
  fictionMotifPages,
  importedShortPages,
  instructionalTerminologyPages
} from "./testing/antiSlopCalibrationFixtures.js";

export const ANTI_SLOP_DETECTOR_VERSION = MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION;
export const ANTI_SLOP_PRODUCTION_MAP_DETECTOR_VERSION = PRODUCTION_MAP_AUDIT_VERSION;
export const ANTI_SLOP_STYLE_CONTRACT_VERSION = STYLE_CONTRACT_VERSION;

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
  maxOutputTokens: MANUSCRIPT_REVIEW_MAX_OUTPUT_TOKENS,
  temperature: MANUSCRIPT_REVIEW_TEMPERATURE,
  purpose: MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE
} as const;

export const ANTI_SLOP_THRESHOLD_STATUS = "unchanged, provisional" as const;

export const ANTI_SLOP_LIVE_GATES_MET = false;
export const PHASE_06_AUTOMATIC_CONSOLIDATION_ENTRY_MET = false;
export const ANTI_SLOP_AUTOMATIC_CONSOLIDATION_IMPLEMENTED = false;

export const ANTI_SLOP_AUTOMATIC_REPAIR_EXCLUSIONS = [
  "imported manuscripts",
  "pages marked as user-edited after generation",
  "books already complete before the feature rollout",
  "books whose current content revision changed during review",
  "clusters involving quotations, deliberate refrains, legal wording, exercises, or reference definitions unless a safe genre-specific policy exists"
] as const;

export const ANTI_SLOP_CORPUS_CALIBRATION_OWNER =
  "operators / this repo’s generation-quality admin";
export const ANTI_SLOP_CORPUS_CALIBRATION_CADENCE = "after 50 classified books or 7 days";

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
  stage4FlagRemoval: "documented removal plan; BOOK_MAKER_PRODUCTION_MAP_INTEGRITY not deleted in Phase 05 or Phase 06"
} as const;

export const BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV = "BOOK_MAKER_PRODUCTION_MAP_INTEGRITY";

export const ANTI_SLOP_FLAG_REMOVAL_PLAN = {
  env: BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV,
  removeAfter:
    "≥50 classified books or 7 days of normal volume, whichever is larger, and <2% hard-block false positives on a live clean-control set. None of those live gates are measured in this environment. Phase 06 did not remove the env flag."
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
  duplicateClusterMinPages: DUPLICATE_CLUSTER_BLOCKING_MIN_PAGES,
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
  styleContractVersion: string;
  liveGatesMet: false;
  phase06AutomaticConsolidationEntryMet: false;
  automaticConsolidationImplemented: false;
  productionMapIntegrityEnvRetained: true;
  productionMapIntegrityEnv: typeof BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV;
  productionMapIntegrityRemovalPlan: string;
  thresholdStatus: typeof ANTI_SLOP_THRESHOLD_STATUS;
  structuralReviewBounds: typeof ANTI_SLOP_STRUCTURAL_REVIEW_BOUNDS;
  automaticRepairExclusions: typeof ANTI_SLOP_AUTOMATIC_REPAIR_EXCLUSIONS;
  corpusCalibrationOwner: typeof ANTI_SLOP_CORPUS_CALIBRATION_OWNER;
  corpusCalibrationCadence: typeof ANTI_SLOP_CORPUS_CALIBRATION_CADENCE;
  fixtures: AntiSlopFixtureReplay[];
};

export type AntiSlopCalibrationCli = AntiSlopCalibrationReport & {
  ok: boolean;
  summary: { total: number; passed: number; failed: number };
  failedFixtures: Array<{ id: string; detail: string }>;
};

/**
 * Distilled-fixture replay only. Never reads `storage/` or live books. Live
 * 50-book / 7-day gates are structurally present on this report and remain unmet.
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

  // Distinct beats sharing an evidence ledger: found, routed to the sparse
  // rewrite, and never blocking (`productionMapAnchors.ts`).
  const anchored = anchorCollidingBriefs();
  const anchorAudit = await auditProductionMap(
    anchored,
    productionMapContractFromRanges(
      Math.max(...anchored.flatMap((brief) => brief.pages.map((page) => page.pageIndex))),
      anchored.map((brief) => ({
        chapterIndex: brief.chapterIndex,
        startPage: Math.min(...brief.pages.map((page) => page.pageIndex)),
        endPage: Math.max(...brief.pages.map((page) => page.pageIndex))
      })),
      "analytical-history"
    )
  );
  fixtures.push({
    id: "boundary:shared-evidence-anchors",
    kind: "boundary",
    passed:
      !anchorAudit.blocking &&
      anchorAudit.sparseFindings.some((finding) => finding.code === "SHARED_EVIDENCE_ANCHORS"),
    detail: anchorAudit.findings.map((finding) => finding.code).join(",")
  });

  fixtures.push(manuscriptFixture("known-failure:hedge-saturation", "known-failure", manuscriptWideSymmetricalHedgingPages(), {
    expectWouldBlock: true
  }));
  // Four pages on one subject argued from distinct evidence. The treatment
  // detector this fixture used to guard against is gone (2026-09-02); the
  // fixture stays as the shared-subject case no surviving detector may block.
  fixtures.push(manuscriptFixture("clean:distinct-evidence", "clean", indusSubjectDistinctEvidencePages(), {
    expectCleanish: true
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
    styleContractVersion: ANTI_SLOP_STYLE_CONTRACT_VERSION,
    liveGatesMet: false,
    phase06AutomaticConsolidationEntryMet: false,
    automaticConsolidationImplemented: false,
    productionMapIntegrityEnvRetained: true,
    productionMapIntegrityEnv: BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV,
    productionMapIntegrityRemovalPlan: ANTI_SLOP_FLAG_REMOVAL_PLAN.removeAfter,
    thresholdStatus: ANTI_SLOP_THRESHOLD_STATUS,
    structuralReviewBounds: ANTI_SLOP_STRUCTURAL_REVIEW_BOUNDS,
    automaticRepairExclusions: ANTI_SLOP_AUTOMATIC_REPAIR_EXCLUSIONS,
    corpusCalibrationOwner: ANTI_SLOP_CORPUS_CALIBRATION_OWNER,
    corpusCalibrationCadence: ANTI_SLOP_CORPUS_CALIBRATION_CADENCE,
    fixtures
  };
}

/** CLI payload for `pnpm anti-slop:replay`. Distilled fixtures only; no `storage/`. */
export function formatAntiSlopCalibrationCli(report: AntiSlopCalibrationReport): AntiSlopCalibrationCli {
  const failedFixtures = report.fixtures
    .filter((fixture) => !fixture.passed)
    .map((fixture) => ({ id: fixture.id, detail: fixture.detail }));
  return {
    ...report,
    ok: failedFixtures.length === 0,
    summary: {
      total: report.fixtures.length,
      passed: report.fixtures.length - failedFixtures.length,
      failed: failedFixtures.length
    },
    failedFixtures
  };
}

function manuscriptFixture(
  id: string,
  kind: AntiSlopFixtureKind,
  pages: ManuscriptIntegrityPage[],
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
