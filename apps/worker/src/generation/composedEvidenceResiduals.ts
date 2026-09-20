import { isRecord, type ManuscriptQualityIssue } from "@book-maker/core";
import type { EvidenceResidual } from "./composedEvidenceRepair.js";

/** The residual findings a composed chapter's report carries, read off the brief a compile's page rows already hold. */
export function storedEvidenceResiduals(brief: unknown, review: "evidence" | "arithmetic" = "evidence"): EvidenceResidual[] {
  if (!isRecord(brief) || !isRecord(brief.report)) return [];
  const report = brief.report[review];
  if (!isRecord(report) || !Array.isArray(report.unresolved)) return [];
  return report.unresolved.filter((entry): entry is EvidenceResidual =>
    isRecord(entry) && typeof entry.quote === "string" && entry.quote.length > 0 && typeof entry.reason === "string"
  );
}

/**
 * A numeric statement the arithmetic repair could not make true blocks the book into REVIEW_REQUIRED
 * with the pages that still print it; a page edited past the statement clears itself. Measured
 * before shipping on 12,093 stored pages (88 numeric statements): five findings, all the one
 * real error.
 */
export function arithmeticErrorIssues(
  pages: ReadonlyArray<{ index: number; markdown: string; chapter?: { productionBrief: unknown } | null | undefined }>
): ManuscriptQualityIssue[] {
  const hits: Array<{ index: number; findings: string[] }> = [];
  for (const page of pages) {
    const residuals = storedEvidenceResiduals(page.chapter?.productionBrief, "arithmetic");
    const findings = residuals.filter((residual) => page.markdown.includes(residual.quote)).map((residual) => `“${residual.quote}”: ${residual.reason}`);
    if (findings.length) hits.push({ index: page.index, findings });
  }
  if (!hits.length) return [];
  const findings = [...new Set(hits.flatMap((hit) => hit.findings))];
  return [{
    code: "ARITHMETIC_ERRORS",
    severity: "error",
    source: "deterministic",
    message: `${findings.length} numeric statement${findings.length === 1 ? "" : "s"} the arithmetic check found wrong survived the chapter repair: ${findings.slice(0, 2).join(" | ")}${findings.length > 2 ? " | …" : ""}`,
    guidance: "Correct the quoted numbers in Edit Mode to the values given, or remove the intermediate steps and keep the correct result.",
    affectedPageIndexes: hits.map((hit) => hit.index).sort((a, b) => a - b)
  }];
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
