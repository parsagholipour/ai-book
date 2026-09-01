import type { ChapterBrief, PageProductionBeat } from "../schemas/book.js";
import type { WritingMode } from "../schemas/styleContract.js";
import { writingModeUsesEvidenceLedger } from "./evidenceLedger.js";
import { foldCharacterName } from "./libraryCharacters.js";
import { tokenSet } from "./manuscriptSignatures.js";
import type { ProductionMapFinding } from "./productionMapAudit.js";

/**
 * The evidence-anchor half of the production-map audit: whether two pages of
 * one chapter were assigned the same evidence, and which analytical pages were
 * assigned none.
 *
 * Anchors are short noun phrases a model wrote twice — "the Treaty of
 * Versailles" on one page, "Versailles treaty (1919)" on the next — so they are
 * compared folded (`foldCharacterName`: NFD, optional marks, Arabic kaf/yeh,
 * Arabic-Indic digits, case) with punctuation stripped, on whole-phrase
 * equality or on token containment. Containment needs at least two tokens on
 * the smaller side: a one-token anchor such as "indus" is contained by every
 * sibling that names the river.
 *
 * Both findings are deliberately **non-blocking**. A shared anchor is repaired
 * through the same bounded rewrite call a near-duplicate beat takes
 * (`productionMapAudit.ts` routes it as a sparse finding carrying its own
 * `beatFinding`, so the rewrite is briefed against the colliding sibling and not
 * the nearest substantive predecessor), and one that survives the repair cycles
 * drafts with its distinctness note rather than failing the book. A missing
 * anchor list is diagnostic only: the page drafts without a ledger, which is
 * what every page did before the field existed.
 */

/** Share of the smaller anchor's tokens the larger must hold to be the same anchor. */
export const ANCHOR_TOKEN_CONTAINMENT_THRESHOLD = 0.8;
/** Tokens the smaller anchor needs before containment means anything. */
export const ANCHOR_MIN_TOKENS_FOR_CONTAINMENT = 2;

export type EvidenceAnchor = {
  raw: string;
  folded: string;
  tokens: Set<string>;
};

export type EvidenceAnchorOverlap = {
  shared: string[];
  collides: boolean;
};

export function foldEvidenceAnchor(anchor: string): string {
  return foldCharacterName(anchor)
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseEvidenceAnchor(raw: string): EvidenceAnchor {
  const folded = foldEvidenceAnchor(raw);
  return { raw, folded, tokens: tokenSet(folded) };
}

export function anchorsMatch(left: EvidenceAnchor, right: EvidenceAnchor): boolean {
  if (!left.folded || !right.folded) {
    return false;
  }
  if (left.folded === right.folded) {
    return true;
  }
  const [smaller, larger] = left.tokens.size <= right.tokens.size ? [left.tokens, right.tokens] : [right.tokens, left.tokens];
  if (smaller.size < ANCHOR_MIN_TOKENS_FOR_CONTAINMENT) {
    return false;
  }
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) {
      shared += 1;
    }
  }
  return shared / smaller.size >= ANCHOR_TOKEN_CONTAINMENT_THRESHOLD;
}

/** The anchors of `left` that `right` also carries, in `left`'s own spelling. */
export function sharedEvidenceAnchors(left: readonly string[], right: readonly string[]): string[] {
  const rights = right.map(parseEvidenceAnchor);
  return left
    .map(parseEvidenceAnchor)
    .filter((anchor) => rights.some((candidate) => anchorsMatch(anchor, candidate)))
    .map((anchor) => anchor.raw);
}

/**
 * Two anchor lists collide on two shared anchors, or on one when either list
 * is short enough that one anchor is half of what the page argues from.
 */
export function evidenceAnchorsCollide(left: readonly string[], right: readonly string[]): EvidenceAnchorOverlap {
  const shared = sharedEvidenceAnchors(left, right);
  const smaller = Math.min(left.length, right.length);
  return { shared, collides: shared.length >= 2 || (shared.length >= 1 && smaller <= 2) };
}

function anchored(page: PageProductionBeat): page is PageProductionBeat & { evidenceAnchors: string[] } {
  return (page.evidenceAnchors?.length ?? 0) > 0;
}

/**
 * One finding per later page whose anchors an earlier page of the same chapter
 * already owns, briefed against the sibling it shares the most with.
 */
export function evidenceAnchorCollisionFindings(briefs: readonly ChapterBrief[]): ProductionMapFinding[] {
  const findings: ProductionMapFinding[] = [];
  for (const brief of briefs) {
    const pages = [...brief.pages].sort((left, right) => left.pageIndex - right.pageIndex).filter(anchored);
    for (let later = 1; later < pages.length; later += 1) {
      const page = pages[later]!;
      let best: { earlier: PageProductionBeat; shared: string[] } | undefined;
      for (let position = 0; position < later; position += 1) {
        const earlier = pages[position]!;
        const overlap = evidenceAnchorsCollide(page.evidenceAnchors, earlier.evidenceAnchors);
        if (overlap.collides && (best === undefined || overlap.shared.length > best.shared.length)) {
          best = { earlier, shared: overlap.shared };
        }
      }
      if (!best) {
        continue;
      }
      const evidence =
        `Page ${page.pageIndex} shares evidence anchors (${best.shared.join(", ")}) with page ${best.earlier.pageIndex}.`;
      findings.push({
        code: "SHARED_EVIDENCE_ANCHORS",
        chapterIndexes: [brief.chapterIndex],
        pageIndexes: [page.pageIndex],
        evidence,
        beatFinding: {
          pageIndex: page.pageIndex,
          duplicateOfPageIndex: best.earlier.pageIndex,
          earlierText: `${best.earlier.purpose} ${best.earlier.beat}`.trim(),
          reason: evidence
        }
      });
    }
  }
  return findings;
}

/** One diagnostic finding per chapter naming the ledger-mode pages assigned no anchors. */
export function missingEvidenceAnchorFindings(
  briefs: readonly ChapterBrief[],
  writingMode: WritingMode | undefined
): ProductionMapFinding[] {
  if (!writingModeUsesEvidenceLedger(writingMode)) {
    return [];
  }
  const findings: ProductionMapFinding[] = [];
  for (const brief of briefs) {
    const missing = brief.pages
      .filter((page) => !anchored(page))
      .map((page) => page.pageIndex)
      .sort((left, right) => left - right);
    if (missing.length === 0) {
      continue;
    }
    findings.push({
      code: "MISSING_EVIDENCE_ANCHORS",
      chapterIndexes: [brief.chapterIndex],
      pageIndexes: missing,
      evidence: `Chapter ${brief.chapterIndex} assigned no evidence anchors to page${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`
    });
  }
  return findings;
}
