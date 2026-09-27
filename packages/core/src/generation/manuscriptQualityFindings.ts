import { createHash } from "node:crypto";
import type { ManuscriptQualityIssue, ManuscriptQualitySeverity } from "./manuscriptQualityIssue.js";
import { pageFindingProvenance } from "./manuscriptQualityProvenance.js";

export type ManuscriptQualityFinding = {
  id: string;
  severity: ManuscriptQualitySeverity;
  /** Indexes into the unchanged diagnostic ledger, including repair history. */
  issueIndexes: number[];
};
const pagesKey = (issue: ManuscriptQualityIssue) => JSON.stringify([...new Set(issue.affectedPageIndexes)].sort((a, b) => a - b));
const pageMessage = (message: string) => message.replace(/^Page \d+:\s*/u, "").trim();
const rejectedMessage = (issue: ManuscriptQualityIssue) => issue.message.replace(/^Page QA did not approve the saved draft:\s*/u, "").trim();
const requirement = (issue: ManuscriptQualityIssue) => /Requested requirement: “([^”]+)”/u.exec(issue.message)?.[1];
const identity = (issue: ManuscriptQualityIssue) => JSON.stringify([issue.code, pagesKey(issue), issue.message.trim(),
  issue.provenance?.kind === "repair" ? issue.provenance.repairOperationId : undefined]);
const primaryPage = (issue: ManuscriptQualityIssue): number | undefined => {
  if (issue.provenance?.primaryPageIndex !== undefined) return issue.provenance.primaryPageIndex;
  if (issue.code === "PAGE_QA_UNRESOLVED" && issue.affectedPageIndexes.length === 1) return issue.affectedPageIndexes[0];
  const index = issue.code === "WHOLE_BOOK_REVIEW" ? Number(/^Page (\d+):/u.exec(issue.message)?.[1]) : NaN;
  return issue.affectedPageIndexes.includes(index) ? index : undefined;
};
const compatibleIds = (a: ManuscriptQualityIssue, b: ManuscriptQualityIssue) =>
  !a.provenance?.findingId || !b.provenance?.findingId || a.provenance.findingId === b.provenance.findingId;

/** Link exact diagnostic relationships, never infer equivalence from page overlap.
 * Older reports need no migration: their original observations remain authoritative.
 */
export function groupManuscriptQualityFindings(issues: readonly ManuscriptQualityIssue[]): ManuscriptQualityFinding[] {
  const parent = issues.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : root(parent[index]!);
  const join = (a: number, b: number) => { parent[root(b)] = root(a); };
  const identical = new Map<string, number>();
  issues.forEach((issue, index) => {
    const key = JSON.stringify([identity(issue), issue.provenance?.findingId, issue.provenance?.repairOperationId]), previous = identical.get(key);
    if (previous !== undefined) join(previous, index);
    else identical.set(key, index);
  });
  const byProvenance = new Map<string, number>();
  issues.forEach((issue, index) => {
    if (!issue.provenance?.findingId) return;
    const key = JSON.stringify([issue.provenance.findingId, primaryPage(issue)]), previous = byProvenance.get(key);
    if (previous !== undefined) join(previous, index);
    else byProvenance.set(key, index);
  });
  // Coverage aliases are validated against supplied atomic obligations and prose
  // targets before persistence. Never infer this link from shared pages or quotes.
  issues.forEach((issue, index) => {
    if (issue.provenance?.kind === "repair") return;
    for (const id of issue.provenance?.relatedFindingIds ?? []) {
      issues.forEach((candidate, candidateIndex) => {
        if (candidate.provenance?.kind !== "repair" && candidate.provenance?.findingId === id) join(index, candidateIndex);
      });
    }
  });
  issues.forEach((issue, index) => {
    if (issue.code !== "PAGE_QA_UNRESOLVED" || issue.affectedPageIndexes.length !== 1) return;
    const samePage = (candidate: ManuscriptQualityIssue) => candidate.code === "WHOLE_BOOK_REVIEW" &&
      primaryPage(candidate) === primaryPage(issue) && compatibleIds(candidate, issue);
    // Only a verbatim diagnosis establishes the relationship. The associated
    // saved revision instruction may then be linked, without guessing array pairing.
    const diagnoses = issues.flatMap((candidate, i) => samePage(candidate) && pageMessage(candidate.message) === rejectedMessage(issue) ? [i] : []);
    if (!diagnoses.length) return;
    diagnoses.forEach(i => join(index, i));
    issues.forEach((candidate, i) => {
      if (samePage(candidate) && pageMessage(candidate.message) === issue.guidance.trim()) {
        // Shared generic guidance cannot bridge two separate diagnoses.
        const owners = issues.filter(other => other.code === "PAGE_QA_UNRESOLVED" && primaryPage(other) === primaryPage(issue) &&
          other.guidance.trim() === issue.guidance.trim());
        if (new Set(owners.map(rejectedMessage)).size === 1) join(index, i);
      }
    });
  });
  issues.forEach((issue, index) => {
    if (issue.code !== "FINAL_QA_REPAIR_REJECTED" || issue.severity !== "warning") return;
    const quote = requirement(issue);
    if (!quote) return; // Unavailable/ambiguous repair evidence is an independent warning.
    const matches = issues.flatMap((candidate, i) => ["WHOLE_BOOK_REVIEW", "PAGE_QA_UNRESOLVED"].includes(candidate.code) &&
      pagesKey(candidate) === pagesKey(issue) && requirement(candidate) === quote ? [root(i)] : []);
    const distinct = [...new Set(matches)];
    if (distinct.length === 1) join(distinct[0]!, index);
  });
  const groups = new Map<number, number[]>();
  issues.forEach((_, index) => { const key = root(index); groups.set(key, [...(groups.get(key) ?? []), index]); });
  return [...groups.values()].map(issueIndexes => {
    const observations = issueIndexes.map(i => issues[i]!);
    const anchor = observations.find(i => i.code === "PAGE_QA_UNRESOLVED") ?? observations.find(i => i.provenance?.findingId) ??
      [...observations].sort((a, b) => identity(a).localeCompare(identity(b)))[0]!;
    const primary = primaryPage(anchor);
    return { id: anchor.provenance?.findingId ?? (primary !== undefined && ["PAGE_QA_UNRESOLVED", "WHOLE_BOOK_REVIEW"].includes(anchor.code)
      ? pageFindingProvenance(primary, anchor.code === "PAGE_QA_UNRESOLVED" ? rejectedMessage(anchor) : pageMessage(anchor.message)).findingId!
      : `finding-${createHash("sha256").update(identity(anchor)).digest("hex").slice(0, 24)}`),
      severity: issueIndexes.some(i => issues[i]!.severity === "error") ? "error" : "warning", issueIndexes };
  });
}

export function manuscriptQualityPenalty(findings: readonly ManuscriptQualityFinding[]): number {
  return findings.reduce((sum, finding) => sum + (finding.severity === "error" ? 18 : 5), 0);
}

function recordedFindingGroups(value: unknown, issues: readonly ManuscriptQualityIssue[]): ManuscriptQualityFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<number>();
  const groups: ManuscriptQualityFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" ||
      !["warning", "error"].includes(item.severity) || !Array.isArray(item.issueIndexes) || !item.issueIndexes.length) return undefined;
    for (const index of item.issueIndexes) {
      if (!Number.isInteger(index) || !issues[index] || seen.has(index)) return undefined;
      seen.add(index);
    }
    groups.push({ id: item.id, issueIndexes: item.issueIndexes,
      severity: item.issueIndexes.some((index: number) => issues[index]!.severity === "error") ? "error" : item.severity });
  }
  return seen.size === issues.length ? groups : undefined;
}

/** Preserve the grouping that produced a saved score; new reports compute new groups. */
export function manuscriptQualityCards(issues: readonly ManuscriptQualityIssue[], recordedFindings?: unknown): ManuscriptQualityIssue[] {
  return (recordedFindingGroups(recordedFindings, issues) ?? groupManuscriptQualityFindings(issues)).map(finding => {
    const observations = finding.issueIndexes.map(i => issues[i]!);
    if (observations.length === 1) return observations[0]!;
    const keeper = observations.find(i => i.code === "PAGE_QA_UNRESOLVED") ?? observations[0]!;
    const provenance = keeper.provenance ?? observations.find(i => i.provenance)?.provenance;
    const allPages = [...new Set(observations.flatMap(i => i.affectedPageIndexes))].sort((a, b) => a - b);
    const primary = primaryPage(keeper);
    const affectedPageIndexes = primary !== undefined && allPages.includes(primary) ? [primary, ...allPages.filter(index => index !== primary)] : allPages;
    const diagnosis = keeper.code === "PAGE_QA_UNRESOLVED" ? rejectedMessage(keeper) : pageMessage(keeper.message);
    const messages = [...new Set(observations.map(i => i.code === "PAGE_QA_UNRESOLVED" ? rejectedMessage(i) : pageMessage(i.message)))]
      .filter(message => message !== keeper.guidance.trim() || message === diagnosis);
    const evidence = [...new Map(observations.flatMap(issue => issue.evidence ?? [])
      .map(item => [JSON.stringify([item.pageIndex, item.excerpt]), item])).values()];
    return { ...keeper, severity: finding.severity, message: messages.join("\n\n"),
      affectedPageIndexes,
      ...(evidence.length ? { evidence } : {}),
      ...(provenance ? { provenance: { ...provenance, findingId: finding.id,
        relatedPageIndexes: affectedPageIndexes.filter(index => index !== provenance.primaryPageIndex) } } : {}),
      guidance: [...new Set(observations.map(i => i.guidance))].join("\n") };
  });
}
