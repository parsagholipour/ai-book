import { arithmeticFindings, figureFreeProse, isRecord, stripFigureFences, verifiedFinding, type ManuscriptQualityIssue } from "@book-maker/core";
import type { EvidenceResidual } from "./composedEvidenceRepair.js";
import { SOURCE_CLAIM_REVIEW, sourceClaimDigest } from "./sourceClaimState.js";

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
 * A numeric statement the arithmetic repair could not make true, with the
 * pages that still print it and each statement quoted on its page; a page
 * edited past the statement clears itself. Measured before shipping on 12,093
 * stored pages (88 numeric statements): five findings, all the one real error.
 *
 * **A residual stands only where the page still prints it as a whole statement,
 * and only while the arithmetic is still wrong.** The chapter report stores the
 * statement it could not fix, and the compile used to find it with
 * `includes`: `24^{10}\equiv1` was found at the start of the corrected
 * `24^{10}\equiv16\cdot2\equiv32\pmod{41}` and blocked a book whose
 * arithmetic was right (cmusr57zp p.19, 2026-10-15). So the quote has to end
 * where the page's statement ends (`printsStatement`), and the compile redoes
 * the arithmetic over the chapter as it now stands (`stillWrong`) — the
 * delimited checker for math, the stored computation for prose — and files
 * only what code still disagrees with. `ARITHMETIC_ERRORS` is one of the
 * findings a reader is shown (`readerFindings.ts`), so the quote is its
 * evidence, never a model's.
 */
export function arithmeticErrorIssues(
  pages: ReadonlyArray<{ index: number; markdown: string; chapter?: { id?: string; productionBrief: unknown } | null | undefined }>
): ManuscriptQualityIssue[] {
  return [false, true].flatMap(reviewOnly => arithmeticIssuesByKind(pages, reviewOnly));
}

function arithmeticIssuesByKind(
  pages: ReadonlyArray<{ index: number; markdown: string; chapter?: { id?: string; productionBrief: unknown } | null | undefined }>,
  reviewOnly: boolean
): ManuscriptQualityIssue[] {
  const chapterText = chapterTextOf(pages);
  const hits: Array<{ index: number; findings: string[]; quotes: string[] }> = [];
  for (const page of pages) {
    const residuals = storedEvidenceResiduals(page.chapter?.productionBrief, "arithmetic")
      .filter(finding => (finding.reviewOnly === true) === reviewOnly)
      .filter(residual => printsStatement(page.markdown, residual.quote) && stillWrong(residual, chapterText(page)));
    if (residuals.length) hits.push({ index: page.index, findings: residuals.map((residual) => `“${residual.quote}”: ${residual.reason}`), quotes: residuals.map((residual) => residual.quote) });
  }
  if (!hits.length) return [];
  const findings = [...new Set(hits.flatMap((hit) => hit.findings))];
  return [{
    code: reviewOnly ? "ARITHMETIC_REVIEW_REQUIRED" : "ARITHMETIC_ERRORS",
    severity: "error",
    source: reviewOnly ? "model" : "deterministic",
    message: `${findings.length} numeric statement${findings.length === 1 ? "" : "s"} ${reviewOnly ? "need verification because the calculation and intent checks disagreed" : "the arithmetic check found wrong survived the chapter repair"}: ${findings.slice(0, 2).join(" | ")}${findings.length > 2 ? " | …" : ""}`,
    guidance: reviewOnly ? "Check the stated rule, inputs and calculation before changing the quoted number. The proposed correction is unconfirmed." : "Correct the quoted numbers in Edit Mode to the values given, or remove the intermediate steps and keep the correct result.",
    affectedPageIndexes: hits.map((hit) => hit.index).sort((a, b) => a - b),
    evidence: hits.flatMap((hit) => hit.quotes.map((quote) => ({ pageIndex: hit.index, excerpt: quote })))
  }];
}

/**
 * Whether `text` prints `quote` as a whole statement: not inside a longer word
 * or number on the left, and not continued by a digit (or a separator and a
 * digit) or a letter on the right. A prefix of a corrected statement is the
 * case this exists for.
 */
export function printsStatement(text: string, quote: string): boolean {
  if (!quote) return false;
  const wordChar = /[\p{L}\p{N}]/u;
  const digit = /\p{N}/u;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text.slice(at + quote.length, at + quote.length + 2);
    if (wordChar.test(quote[0]!) && wordChar.test(before)) continue;
    const last = quote[quote.length - 1]!;
    if (digit.test(last) && (digit.test(after[0] ?? "") || (/^[.,]/.test(after) && digit.test(after[1] ?? "")))) continue;
    if (/\p{L}/u.test(last) && /\p{L}/u.test(after[0] ?? "")) continue;
    return true;
  }
  return false;
}

/**
 * Whether code still finds the residual wrong in the chapter as it now stands:
 * the delimited checker finds the same statement, or, for prose arithmetic, the
 * stored computation still disagrees with the stated result. A residual neither
 * can re-check is dropped: it is not a defect code can stand behind.
 */
function stillWrong(residual: EvidenceResidual, chapterMarkdown: string): boolean {
  const text = figureFreeProse(chapterMarkdown);
  // The checker quotes the whole delimited statement, which may run on past the stored
  // quote (a trailing `\pmod{41}`); it still has to be the same statement, not a prefix.
  if (arithmeticFindings(text).some((finding) => finding.quote === residual.quote || printsStatement(finding.quote, residual.quote))) return true;
  const computation = /(?:^|: )([\d\s.+\-*/()×÷−]+?) = -?[\d.,]+, not (.+?)\.(?:\s|$)/u.exec(residual.reason);
  return computation !== null && verifiedFinding(text, residual.quote, computation[1]!, computation[2]!) !== undefined;
}

/** Each page's whole chapter, as the chapter's arithmetic was checked; a page with no chapter is its own. */
function chapterTextOf(
  pages: ReadonlyArray<{ index: number; markdown: string; chapter?: { id?: string } | null | undefined }>
): (page: { markdown: string; chapter?: { id?: string } | null | undefined }) => string {
  const byChapter = new Map<string, string>();
  for (const page of [...pages].sort((a, b) => a.index - b.index)) {
    const id = page.chapter?.id;
    if (id) byChapter.set(id, byChapter.has(id) ? `${byChapter.get(id)}\n\n${page.markdown}` : page.markdown);
  }
  return (page) => (page.chapter?.id ? byChapter.get(page.chapter.id) : undefined) ?? page.markdown;
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
  // Off with the review itself: a stored ledger on an older book would
  // otherwise flag every later edit as unverified, with nothing left to verify it.
  const factual = SOURCE_CLAIM_REVIEW ? sourceClaimVerificationIssues(pages) : [];
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
