import { isRecord, stripFigureFences, type ManuscriptQualityIssue } from "@book-maker/core";
import type { EvidenceResidual } from "./composedEvidenceRepair.js";
import { sourceClaimDigest } from "./sourceClaimState.js";

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
    const brief = page.chapter?.productionBrief;
    if (isRecord(brief) && isRecord(brief.report) && isRecord(brief.report.sourceClaims)) continue;
    const residuals = storedEvidenceResiduals(page.chapter?.productionBrief);
    const findings = residuals.filter((residual) => page.markdown.includes(residual.quote)).map((residual) => `“${residual.quote}”: ${residual.reason}`);
    if (findings.length) hits.push({ index: page.index, findings });
  }
  const factual = sourceClaimVerificationIssues(pages);
  if (!hits.length) return factual;
  const findings = [...new Set(hits.flatMap((hit) => hit.findings))];
  return [...factual, {
    code: "UNSUPPORTED_CASE_CLAIMS",
    severity: "error",
    source: "deterministic",
    message: `${findings.length} case assertion${findings.length === 1 ? "" : "s"} the evidence review could not support survived the chapter repair: ${findings.slice(0, 2).join(" | ")}${findings.length > 2 ? " | …" : ""}`,
    guidance: "Narrow or remove the quoted assertions in Edit Mode, or replace them with what the cited passages state.",
    affectedPageIndexes: hits.map((hit) => hit.index).sort((a, b) => a - b)
  }];
}

/** Model decisions retain their claim-to-passage ledger; missing/incomplete checks cannot clear QA. */
export function sourceClaimVerificationIssues(
  pages: ReadonlyArray<{ index: number; markdown: string; chapter?: { productionBrief: unknown } | null | undefined }>
): ManuscriptQualityIssue[] {
  const groups = new Map<string, typeof pages[number][]>();
  for (const page of pages) {
    const brief = page.chapter?.productionBrief;
    if (!isRecord(brief) || !isRecord(brief.report) || !isRecord(brief.report.sourceClaims)) continue;
    const key = JSON.stringify({ chapterIndex: brief.chapterIndex, review: brief.report.sourceClaims });
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }
  const unavailable = new Set<number>();
  const affected = new Set<number>();
  const findings = new Set<string>();
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  for (const [key, group] of groups) {
    const review: unknown = JSON.parse(key).review;
    if (!isRecord(review)) continue;
    if (!isRecord(review.coverage) || review.coverage.status !== "reviewed") group.forEach((page) => unavailable.add(page.index));
    if (!Array.isArray(review.claims)) continue;
    const ordered = [...group].sort((a, b) => a.index - b.index);
    // Compile-time repairs and later edits are additional writers. A reprint
    // makes no model call, but cannot reuse verification of different prose.
    if (typeof review.textDigest === "string" && review.textDigest !== sourceClaimDigest(ordered.map((page) => stripFigureFences(page.markdown).prose).join("\n\n"))) {
      group.forEach((page) => unavailable.add(page.index));
    }
    const text = ordered.map((page) => normalize(page.markdown)).join(" ");
    for (const claim of review.claims) {
      if (!isRecord(claim) || claim.status === "supported" || typeof claim.quote !== "string" || !claim.quote.trim()) continue;
      const quote = normalize(claim.quote);
      // Repeated assertions flag every affected page, including across a cut.
      for (let start = text.indexOf(quote); start >= 0; start = text.indexOf(quote, start + quote.length)) {
        findings.add(`“${claim.quote}”: ${String(claim.reason ?? "No supporting passage")}`);
        let offset = 0;
        for (const page of ordered) {
          const end = offset + normalize(page.markdown).length;
          if (end > start && offset < start + quote.length) affected.add(page.index);
          offset = end + 1;
        }
      }
    }
  }
  const issues: ManuscriptQualityIssue[] = [];
  if (unavailable.size) issues.push({ code: "SOURCE_VERIFICATION_INCOMPLETE", severity: "error", source: "model",
    message: "Factual claim verification was unavailable, incomplete, or belongs to an earlier version of the manuscript.",
    guidance: "Retry source verification or review the affected chapters before treating their factual claims as checked.", affectedPageIndexes: [...unavailable].sort((a, b) => a - b) });
  if (findings.size) issues.push({ code: "UNSUPPORTED_FACTUAL_CLAIMS", severity: "error", source: "model",
    message: `${findings.size} factual assertions lack verified support or contradict their source passages: ${[...findings].slice(0, 2).join(" | ")}`,
    guidance: "Correct claims against their supporting passages, or remove the unsupported specifics.", affectedPageIndexes: [...affected].sort((a, b) => a - b) });
  return issues;
}
