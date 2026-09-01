import { optionalIssueCluster, type ManuscriptQualityIssue } from "@book-maker/core";

export function parseStoredQualityIssue(value: unknown): ManuscriptQualityIssue | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.code !== "string" ||
    (record.severity !== "error" && record.severity !== "warning") ||
    (record.source !== "deterministic" && record.source !== "model") ||
    typeof record.message !== "string" ||
    typeof record.guidance !== "string" ||
    !Array.isArray(record.affectedPageIndexes) ||
    record.affectedPageIndexes.some((index) => typeof index !== "number")
  ) {
    return null;
  }
  return {
    code: record.code,
    severity: record.severity,
    source: record.source,
    message: record.message,
    guidance: record.guidance,
    affectedPageIndexes: record.affectedPageIndexes,
    ...optionalIssueMetrics(record.metrics),
    ...optionalIssueEvidence(record.evidence),
    ...optionalIssueCluster(record.cluster)
  };
}

function optionalIssueMetrics(
  value: unknown
): { metrics: NonNullable<ManuscriptQualityIssue["metrics"]> } | Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const metrics: NonNullable<ManuscriptQualityIssue["metrics"]> = {
    ...(typeof record.occurrences === "number" && Number.isFinite(record.occurrences)
      ? { occurrences: record.occurrences }
      : {}),
    ...(typeof record.affectedPageRatio === "number" && Number.isFinite(record.affectedPageRatio)
      ? { affectedPageRatio: record.affectedPageRatio }
      : {}),
    ...(typeof record.clusterCount === "number" && Number.isFinite(record.clusterCount)
      ? { clusterCount: record.clusterCount }
      : {}),
    ...(typeof record.chaptersSpanned === "number" && Number.isFinite(record.chaptersSpanned)
      ? { chaptersSpanned: record.chaptersSpanned }
      : {}),
    ...(typeof record.sameParagraphRole === "boolean" ? { sameParagraphRole: record.sameParagraphRole } : {}),
    ...(typeof record.wouldBlock === "boolean" ? { wouldBlock: record.wouldBlock } : {})
  };
  return Object.keys(metrics).length > 0 ? { metrics } : {};
}

function optionalIssueEvidence(
  value: unknown
): { evidence: NonNullable<ManuscriptQualityIssue["evidence"]> } | Record<string, never> {
  if (!Array.isArray(value)) {
    return {};
  }
  const evidence = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (!Number.isInteger(record.pageIndex) || typeof record.excerpt !== "string") {
      return [];
    }
    return [{ pageIndex: Number(record.pageIndex), excerpt: record.excerpt }];
  });
  return evidence.length > 0 ? { evidence } : {};
}
