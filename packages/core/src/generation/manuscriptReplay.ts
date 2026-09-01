import {
  buildManuscriptQualityReport,
  runDeterministicManuscriptChecks
} from "./manuscriptQuality.js";
import type {
  ManuscriptIntegrityPage,
  ManuscriptQualityDiagnostics,
  ManuscriptQualityIssue,
  ManuscriptQualityReport
} from "./manuscriptQualityIssue.js";

export type ManuscriptReplayInput = {
  pages: ManuscriptIntegrityPage[];
  expectedPageCount?: number;
  language?: string;
};

export type ManuscriptReplayResult = {
  issues: ManuscriptQualityIssue[];
  report: ManuscriptQualityReport;
  diagnostics: ManuscriptQualityDiagnostics;
  elapsedMs: number;
};

/**
 * Run the deterministic manuscript audit on caller-supplied pages.
 * The helper never reads `storage/` or any other mutable path.
 */
export function replayDeterministicManuscriptChecks(input: ManuscriptReplayInput): ManuscriptReplayResult {
  const started = performance.now();
  const issues = runDeterministicManuscriptChecks({
    pages: input.pages,
    expectedPageCount: input.expectedPageCount ?? input.pages.length,
    ...(input.language ? { language: input.language } : {})
  });
  const elapsedMs = performance.now() - started;
  const report = buildManuscriptQualityReport(issues, [], {
    finalReviewRan: true,
    deterministicWarningsAffectVerdict: true,
    manuscriptPageCount: input.pages.length
  });
  return {
    issues,
    report,
    diagnostics: report.diagnostics ?? {
      detectorVersion: "manuscript-structural-audit-v1",
      wouldBlock: false,
      findings: []
    },
    elapsedMs
  };
}
