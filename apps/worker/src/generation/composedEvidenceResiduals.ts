import { isRecord, type ManuscriptQualityIssue } from "@book-maker/core";
import type { EvidenceResidual } from "./composedEvidenceRepair.js";

/** The residual findings a composed chapter's report carries, read off the brief a compile's page rows already hold. */
export function storedEvidenceResiduals(brief: unknown): EvidenceResidual[] {
  if (!isRecord(brief) || !isRecord(brief.report) || !isRecord(brief.report.evidence) || !Array.isArray(brief.report.evidence.unresolved)) return [];
  return brief.report.evidence.unresolved.filter((entry): entry is EvidenceResidual =>
    isRecord(entry) && typeof entry.quote === "string" && entry.quote.length > 0 && typeof entry.reason === "string"
  );
}

/**
 * A case assertion the chapter repair could not narrow blocks the book into REVIEW_REQUIRED with the
 * pages that still carry it; a page a reader has since edited past the span clears itself.
 */
export function unsupportedCaseClaimIssues(
  pages: ReadonlyArray<{ index: number; markdown: string; chapter?: { productionBrief: unknown } | null | undefined }>
): ManuscriptQualityIssue[] {
  const hits: Array<{ index: number; findings: string[] }> = [];
  for (const page of pages) {
    const residuals = storedEvidenceResiduals(page.chapter?.productionBrief);
    const findings = residuals.filter((residual) => page.markdown.includes(residual.quote)).map((residual) => `“${residual.quote}”: ${residual.reason}`);
    if (findings.length) hits.push({ index: page.index, findings });
  }
  if (!hits.length) return [];
  const findings = [...new Set(hits.flatMap((hit) => hit.findings))];
  return [{
    code: "UNSUPPORTED_CASE_CLAIMS",
    severity: "error",
    source: "deterministic",
    message: `${findings.length} case assertion${findings.length === 1 ? "" : "s"} the evidence review could not support survived the chapter repair: ${findings.slice(0, 2).join(" | ")}${findings.length > 2 ? " | …" : ""}`,
    guidance: "Narrow or remove the quoted assertions in Edit Mode, or replace them with what the cited passages state.",
    affectedPageIndexes: hits.map((hit) => hit.index).sort((a, b) => a - b)
  }];
}
