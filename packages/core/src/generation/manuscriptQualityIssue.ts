export type ManuscriptQualityState = "passed" | "review_recommended" | "blocked";
export type ManuscriptQualitySeverity = "error" | "warning";
export type ManuscriptQualitySource = "deterministic" | "model";

export const MANUSCRIPT_STRUCTURAL_AUDIT_DETECTOR_VERSION = "manuscript-structural-audit-v1";

export type ManuscriptQualityIssueMetrics = {
  occurrences?: number;
  affectedPageRatio?: number;
  clusterCount?: number;
  chaptersSpanned?: number;
  sameParagraphRole?: boolean;
  wouldBlock?: boolean;
};

export type ManuscriptQualityIssueEvidence = {
  pageIndex: number;
  excerpt: string;
};

export type ManuscriptQualityIssue = {
  code: string;
  severity: ManuscriptQualitySeverity;
  source: ManuscriptQualitySource;
  message: string;
  guidance: string;
  affectedPageIndexes: number[];
  metrics?: ManuscriptQualityIssueMetrics;
  evidence?: ManuscriptQualityIssueEvidence[];
};

export type ManuscriptQualityFindingDiagnostic = {
  code: string;
  detectorVersion: string;
  severity: ManuscriptQualitySeverity;
  affectedPageCount: number;
  occurrences: number;
  affectedPageRatio: number;
  clusterCount?: number;
  chaptersSpanned?: number;
  wouldBlock: boolean;
};

export type ManuscriptQualityDiagnostics = {
  detectorVersion: string;
  wouldBlock: boolean;
  findings: ManuscriptQualityFindingDiagnostic[];
};

export type ManuscriptQualityReport = {
  state: ManuscriptQualityState;
  score: number;
  issues: ManuscriptQualityIssue[];
  affectedPageIndexes: number[];
  checkedAt: string;
  diagnostics?: ManuscriptQualityDiagnostics;
};

export type ManuscriptIntegrityPage = {
  index: number;
  chapterIndex?: number;
  title: string;
  markdown: string;
};

export type ManuscriptFindingInput = {
  code: string;
  severity: ManuscriptQualitySeverity;
  message: string;
  guidance: string;
  affectedPageIndexes: number[];
  metrics?: ManuscriptQualityIssueMetrics;
  evidence?: ManuscriptQualityIssueEvidence[];
};

export function manuscriptFinding(input: ManuscriptFindingInput): ManuscriptQualityIssue {
  return {
    code: input.code,
    severity: input.severity,
    source: "deterministic",
    message: input.message,
    guidance: input.guidance,
    affectedPageIndexes: input.affectedPageIndexes,
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {})
  };
}

export function manuscriptError(
  code: string,
  message: string,
  guidance: string,
  affectedPageIndexes: number[],
  extras?: Pick<ManuscriptFindingInput, "metrics" | "evidence">
): ManuscriptQualityIssue {
  return manuscriptFinding({
    code,
    severity: "error",
    message,
    guidance,
    affectedPageIndexes,
    ...extras
  });
}

export function manuscriptWarning(
  code: string,
  message: string,
  guidance: string,
  affectedPageIndexes: number[],
  extras?: Pick<ManuscriptFindingInput, "metrics" | "evidence">
): ManuscriptQualityIssue {
  return manuscriptFinding({
    code,
    severity: "warning",
    message,
    guidance,
    affectedPageIndexes,
    ...extras
  });
}

export function compactExcerpt(plain: string, maxChars = 140): string {
  const trimmed = plain.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

export function evidenceForPages(
  pages: readonly { index: number; plain: string }[],
  indexes: readonly number[],
  limit = 6
): ManuscriptQualityIssueEvidence[] {
  const byIndex = new Map(pages.map((page) => [page.index, page.plain]));
  return indexes.slice(0, limit).flatMap((pageIndex) => {
    const plain = byIndex.get(pageIndex);
    return plain ? [{ pageIndex, excerpt: compactExcerpt(plain) }] : [];
  });
}

export function ratio(part: number, whole: number): number {
  return whole <= 0 ? 0 : part / whole;
}
