import { range } from "../collections.js";
import type { ChapterBrief, PageProductionBeat } from "../schemas/book.js";
import { isSubstantivePageAssignment } from "./generatedChapterBriefAcceptance.js";
import {
  MAX_BEAT_DEDUP_FINDINGS,
  findDuplicatePageBeats,
  fingerprint,
  type DuplicateBeatFinding
} from "./pageBeatDedupDetect.js";

/**
 * Full-map production-map audit: exact coverage, generic assignments, duplicate
 * fingerprints, and near-duplicate beats, classified into sparse page repair vs
 * dense chapter regeneration.
 *
 * Detection always scans the complete map. `MAX_BEAT_DEDUP_FINDINGS` is a bound
 * on one rewrite call, never on this audit — the detector is asked with
 * `rewriteSlotLimit: 0` so every collision is a first-class finding.
 *
 * Async because `findDuplicatePageBeats` yields the event loop on large maps.
 */

export const PRODUCTION_MAP_AUDIT_VERSION = "production-map-audit-v1";

/** Affected-page ratio at which a chapter is regenerated rather than patched. */
export const PRODUCTION_MAP_DENSE_CORRUPTION_THRESHOLD = 0.25;

/** Full audit-repair-reaudit loops `prepareChapterSetups` may spend. */
export const PRODUCTION_MAP_REPAIR_CYCLE_LIMIT = 2;

export const PRODUCTION_MAP_FINDING_CODES = [
  "PAGE_COVERAGE_MISSING",
  "PAGE_COVERAGE_EXTRA",
  "PAGE_COVERAGE_DUPLICATE",
  "PAGE_COVERAGE_OUT_OF_ORDER",
  "CHAPTER_COVERAGE_MISSING",
  "CHAPTER_COVERAGE_UNEXPECTED",
  "GENERIC_ASSIGNMENT",
  "DUPLICATE_ASSIGNMENT_FINGERPRINT",
  "NEAR_DUPLICATE_BEAT"
] as const;

export type ProductionMapFindingCode = (typeof PRODUCTION_MAP_FINDING_CODES)[number];

export type ProductionMapChapterRange = {
  chapterIndex: number;
  startPage: number;
  endPage: number;
};

export type ProductionMapContract = {
  targetPages: number;
  chapters: ProductionMapChapterRange[];
};

export type ProductionMapFinding = {
  code: ProductionMapFindingCode;
  chapterIndexes: number[];
  pageIndexes: number[];
  evidence: string;
  beatFinding?: DuplicateBeatFinding;
};

export type ChapterCorruptionClass = "clean" | "sparse" | "dense";

export type ChapterCorruptionClassification = {
  chapterIndex: number;
  pageCount: number;
  affectedPageCount: number;
  affectedRatio: number;
  coverageValid: boolean;
  classification: ChapterCorruptionClass;
};

export type ProductionMapAudit = {
  version: typeof PRODUCTION_MAP_AUDIT_VERSION;
  blocking: boolean;
  findings: ProductionMapFinding[];
  chapterClassifications: ChapterCorruptionClassification[];
  sparseFindings: ProductionMapFinding[];
  denseChapterIndexes: number[];
};

const COVERAGE_CODES = new Set<ProductionMapFindingCode>([
  "PAGE_COVERAGE_MISSING",
  "PAGE_COVERAGE_EXTRA",
  "PAGE_COVERAGE_DUPLICATE",
  "PAGE_COVERAGE_OUT_OF_ORDER",
  "CHAPTER_COVERAGE_MISSING",
  "CHAPTER_COVERAGE_UNEXPECTED"
]);

const ASSIGNMENT_CODES = new Set<ProductionMapFindingCode>([
  "GENERIC_ASSIGNMENT",
  "DUPLICATE_ASSIGNMENT_FINGERPRINT",
  "NEAR_DUPLICATE_BEAT"
]);

export function productionMapContractFromRanges(
  targetPages: number,
  chapters: ProductionMapChapterRange[]
): ProductionMapContract {
  return { targetPages, chapters };
}

/**
 * Classify one chapter's corruption. Dense when coverage is invalid, when the
 * unrewritable opening page is affected, or when at least 25% of the chapter's
 * pages are affected. Sparse when some later pages are affected below that bar.
 */
export function classifyChapterCorruption(input: {
  chapterIndex: number;
  pageCount: number;
  affectedPageIndexes: readonly number[];
  coverageValid: boolean;
}): ChapterCorruptionClassification {
  const uniqueAffected = [...new Set(input.affectedPageIndexes)].sort((left, right) => left - right);
  const affectedPageCount = uniqueAffected.length;
  const affectedRatio = input.pageCount === 0 ? 1 : affectedPageCount / input.pageCount;
  const coverageValid = input.coverageValid && input.pageCount > 0;
  let classification: ChapterCorruptionClass = "clean";
  if (!coverageValid || uniqueAffected.includes(1)) {
    classification = "dense";
  } else if (affectedPageCount === 0) {
    classification = "clean";
  } else if (affectedRatio >= PRODUCTION_MAP_DENSE_CORRUPTION_THRESHOLD) {
    classification = "dense";
  } else {
    classification = "sparse";
  }
  return {
    chapterIndex: input.chapterIndex,
    pageCount: input.pageCount,
    affectedPageCount,
    affectedRatio,
    coverageValid,
    classification
  };
}

export async function auditProductionMap(
  briefs: ChapterBrief[],
  contract: ProductionMapContract
): Promise<ProductionMapAudit> {
  const pageChapter = pageChapterIndex(briefs);
  const coverage = coverageFindings(briefs, contract);
  const generic = genericAssignmentFindings(briefs);
  const fingerprints = duplicateFingerprintFindings(briefs);
  const nearDuplicates = (await findDuplicatePageBeats(briefs, { rewriteSlotLimit: 0 })).map((finding) =>
    nearDuplicateFinding(finding, pageChapter)
  );
  const findings = [...coverage, ...generic, ...fingerprints, ...nearDuplicates];
  const byChapter = findingsByChapter(findings);
  const chapterClassifications = contract.chapters.map((chapter) => {
    const chapterFindings = byChapter.get(chapter.chapterIndex) ?? [];
    const inChapter = (pageIndex: number) => pageIndex >= chapter.startPage && pageIndex <= chapter.endPage;
    return classifyChapterCorruption({
      chapterIndex: chapter.chapterIndex,
      pageCount: chapter.endPage - chapter.startPage + 1,
      affectedPageIndexes: assignmentPageIndexes(chapterFindings).filter(inChapter),
      coverageValid: chapterFindings.every((finding) => !COVERAGE_CODES.has(finding.code))
    });
  });
  for (const brief of briefs) {
    if (contract.chapters.some((chapter) => chapter.chapterIndex === brief.chapterIndex)) {
      continue;
    }
    chapterClassifications.push(
      classifyChapterCorruption({
        chapterIndex: brief.chapterIndex,
        pageCount: brief.pages.length,
        affectedPageIndexes: assignmentPageIndexes(byChapter.get(brief.chapterIndex) ?? []),
        coverageValid: false
      })
    );
  }
  const denseChapterIndexes = [
    ...new Set(
      chapterClassifications
        .filter((entry) => entry.classification === "dense")
        .map((entry) => entry.chapterIndex)
    )
  ].sort((left, right) => left - right);
  const denseChapters = new Set(denseChapterIndexes);
  const sparseFindings = findings.filter((finding) => {
    if (!ASSIGNMENT_CODES.has(finding.code)) {
      return false;
    }
    const repairChapter = finding.chapterIndexes[0];
    return repairChapter !== undefined && !denseChapters.has(repairChapter);
  });
  return {
    version: PRODUCTION_MAP_AUDIT_VERSION,
    blocking: findings.length > 0,
    findings,
    chapterClassifications,
    sparseFindings,
    denseChapterIndexes
  };
}

export function groupSparseFindingsByChapter(
  findings: ProductionMapFinding[]
): Array<{ chapterIndex: number; findings: ProductionMapFinding[] }> {
  const grouped = new Map<number, ProductionMapFinding[]>();
  for (const finding of findings) {
    const chapterIndex = finding.chapterIndexes[0];
    if (chapterIndex === undefined) {
      continue;
    }
    const existing = grouped.get(chapterIndex) ?? [];
    existing.push(finding);
    grouped.set(chapterIndex, existing);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([chapterIndex, chapterFindings]) => ({
      chapterIndex,
      findings: [...chapterFindings].sort(compareFindings)
    }));
}

/**
 * Rewrite findings for one sparse pass, in chapter-then-page order, unique by
 * later page. Near-duplicate evidence is preferred; generic and fingerprint
 * findings are synthesized against the nearest earlier substantive page.
 */
export function sparseRewriteFindingsFromAudit(
  audit: ProductionMapAudit,
  briefs: ChapterBrief[]
): DuplicateBeatFinding[] {
  const pages = briefs.flatMap((brief) => brief.pages).sort((left, right) => left.pageIndex - right.pageIndex);
  const selected = new Map<number, DuplicateBeatFinding>();
  for (const group of groupSparseFindingsByChapter(audit.sparseFindings)) {
    for (const finding of group.findings) {
      const pageIndex = finding.pageIndexes[0];
      if (pageIndex === undefined || pageIndex <= 1 || selected.has(pageIndex)) {
        continue;
      }
      const beatFinding = finding.beatFinding ?? synthesizeRewriteFinding(finding, pages);
      if (beatFinding) {
        selected.set(pageIndex, beatFinding);
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.pageIndex - right.pageIndex);
}

export function chunkFindingsForRewriteCalls(
  findings: DuplicateBeatFinding[],
  limit = MAX_BEAT_DEDUP_FINDINGS
): DuplicateBeatFinding[][] {
  const batches: DuplicateBeatFinding[][] = [];
  for (let index = 0; index < findings.length; index += limit) {
    batches.push(findings.slice(index, index + limit));
  }
  return batches;
}

export class PageMapIntegrityUnresolvedError extends Error {
  readonly code = "PAGE_MAP_INTEGRITY_UNRESOLVED" as const;

  constructor(
    readonly cycleCount: number,
    readonly audit: ProductionMapAudit
  ) {
    const codes = [...new Set(audit.findings.map((finding) => finding.code))];
    const pages = [...new Set(audit.findings.flatMap((finding) => finding.pageIndexes))].sort(
      (left, right) => left - right
    );
    const chapters = [
      ...new Set([
        ...audit.denseChapterIndexes,
        ...audit.findings.flatMap((finding) => finding.chapterIndexes)
      ])
    ].sort((left, right) => left - right);
    super(
      `Production map integrity unresolved after ${cycleCount} repair cycle(s)` +
        `${codes.length > 0 ? ` (${codes.join(", ")})` : ""}.`
    );
    this.name = "PageMapIntegrityUnresolvedError";
    this.findingCodes = codes;
    this.affectedPageIndexes = pages;
    this.affectedChapterIndexes = chapters;
  }

  readonly findingCodes: ProductionMapFindingCode[];
  readonly affectedPageIndexes: number[];
  readonly affectedChapterIndexes: number[];
}

export function isPageMapIntegrityUnresolvedError(error: unknown): error is PageMapIntegrityUnresolvedError {
  return error instanceof PageMapIntegrityUnresolvedError;
}

function coverageFindings(briefs: ChapterBrief[], contract: ProductionMapContract): ProductionMapFinding[] {
  const findings: ProductionMapFinding[] = [];
  const expectedChapters = new Set(contract.chapters.map((chapter) => chapter.chapterIndex));
  const briefByChapter = new Map(briefs.map((brief) => [brief.chapterIndex, brief]));

  for (const brief of briefs) {
    if (expectedChapters.has(brief.chapterIndex)) {
      continue;
    }
    findings.push({
      code: "CHAPTER_COVERAGE_UNEXPECTED",
      chapterIndexes: [brief.chapterIndex],
      pageIndexes: brief.pages.map((page) => page.pageIndex),
      evidence: `Chapter ${brief.chapterIndex} is not in the production-map contract.`
    });
  }

  for (const chapter of contract.chapters) {
    if (briefByChapter.has(chapter.chapterIndex)) {
      continue;
    }
    findings.push({
      code: "CHAPTER_COVERAGE_MISSING",
      chapterIndexes: [chapter.chapterIndex],
      pageIndexes: range(chapter.startPage, chapter.endPage),
      evidence: `Chapter ${chapter.chapterIndex} has no brief for pages ${chapter.startPage}-${chapter.endPage}.`
    });
  }

  const actualIndexes = briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex));
  const counts = new Map<number, number>();
  for (const pageIndex of actualIndexes) {
    counts.set(pageIndex, (counts.get(pageIndex) ?? 0) + 1);
  }
  const expectedPages = range(1, contract.targetPages);
  const missing = expectedPages.filter((pageIndex) => !counts.has(pageIndex));
  if (missing.length > 0) {
    findings.push({
      code: "PAGE_COVERAGE_MISSING",
      chapterIndexes: chaptersForPages(contract, missing),
      pageIndexes: missing,
      evidence: `Missing page indexes: ${missing.join(", ")}.`
    });
  }
  const extra = [...counts.keys()].filter((pageIndex) => pageIndex < 1 || pageIndex > contract.targetPages).sort(
    (left, right) => left - right
  );
  if (extra.length > 0) {
    findings.push({
      code: "PAGE_COVERAGE_EXTRA",
      chapterIndexes: chaptersForPages(contract, extra),
      pageIndexes: extra,
      evidence: `Page indexes outside 1..${contract.targetPages}: ${extra.join(", ")}.`
    });
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([pageIndex]) => pageIndex)
    .sort((left, right) => left - right);
  if (duplicates.length > 0) {
    findings.push({
      code: "PAGE_COVERAGE_DUPLICATE",
      chapterIndexes: chaptersForPages(contract, duplicates),
      pageIndexes: duplicates,
      evidence: `Duplicated page indexes: ${duplicates.join(", ")}.`
    });
  }

  for (const chapter of contract.chapters) {
    const brief = briefByChapter.get(chapter.chapterIndex);
    if (!brief) {
      continue;
    }
    const expected = range(chapter.startPage, chapter.endPage);
    const actual = brief.pages.map((page) => page.pageIndex);
    if (actual.length === expected.length && actual.every((pageIndex, index) => pageIndex === expected[index])) {
      continue;
    }
    findings.push({
      code: "PAGE_COVERAGE_OUT_OF_ORDER",
      chapterIndexes: [chapter.chapterIndex],
      pageIndexes: actual,
      evidence:
        `Chapter ${chapter.chapterIndex} pages [${actual.join(", ")}] do not match ${chapter.startPage}-${chapter.endPage}.`
    });
  }
  return findings;
}

function genericAssignmentFindings(briefs: ChapterBrief[]): ProductionMapFinding[] {
  const findings: ProductionMapFinding[] = [];
  for (const brief of briefs) {
    for (const page of brief.pages) {
      const fields = genericFields(page);
      if (fields.length === 0) {
        continue;
      }
      findings.push({
        code: "GENERIC_ASSIGNMENT",
        chapterIndexes: [page.chapterIndex],
        pageIndexes: [page.pageIndex],
        evidence: `Page ${page.pageIndex} ${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} generic or metadata-only.`
      });
    }
  }
  return findings;
}

function duplicateFingerprintFindings(briefs: ChapterBrief[]): ProductionMapFinding[] {
  const pages = briefs.flatMap((brief) => brief.pages).sort((left, right) => left.pageIndex - right.pageIndex);
  const firstByFingerprint = new Map<string, PageProductionBeat>();
  const findings: ProductionMapFinding[] = [];
  for (const page of pages) {
    const key = fingerprint({ purpose: page.purpose, beat: page.beat }).normalized;
    if (!key) {
      continue;
    }
    const earlier = firstByFingerprint.get(key);
    if (!earlier) {
      firstByFingerprint.set(key, page);
      continue;
    }
    findings.push({
      code: "DUPLICATE_ASSIGNMENT_FINGERPRINT",
      chapterIndexes: repairChapterIndexes(page.chapterIndex, earlier.chapterIndex),
      pageIndexes: [page.pageIndex],
      evidence: `Page ${page.pageIndex} repeats page ${earlier.pageIndex}'s assignment fingerprint.`
    });
  }
  return findings;
}

function nearDuplicateFinding(
  finding: DuplicateBeatFinding,
  pageChapter: Map<number, number>
): ProductionMapFinding {
  const laterChapter = pageChapter.get(finding.pageIndex);
  const earlierChapter = pageChapter.get(finding.duplicateOfPageIndex);
  return {
    code: "NEAR_DUPLICATE_BEAT",
    chapterIndexes: repairChapterIndexes(laterChapter ?? 0, earlierChapter ?? 0).filter((index) => index > 0),
    pageIndexes: [finding.pageIndex],
    evidence: finding.reason,
    beatFinding: finding
  };
}

function findingsByChapter(findings: ProductionMapFinding[]): Map<number, ProductionMapFinding[]> {
  const byChapter = new Map<number, ProductionMapFinding[]>();
  const attach = (chapterIndex: number, finding: ProductionMapFinding) => {
    const existing = byChapter.get(chapterIndex) ?? [];
    existing.push(finding);
    byChapter.set(chapterIndex, existing);
  };
  for (const finding of findings) {
    if (COVERAGE_CODES.has(finding.code)) {
      for (const chapterIndex of finding.chapterIndexes) {
        attach(chapterIndex, finding);
      }
      continue;
    }
    const repairChapter = finding.chapterIndexes[0];
    if (repairChapter !== undefined) {
      attach(repairChapter, finding);
    }
  }
  return byChapter;
}

function pageChapterIndex(briefs: ChapterBrief[]): Map<number, number> {
  const pageChapter = new Map<number, number>();
  for (const brief of briefs) {
    for (const page of brief.pages) {
      pageChapter.set(page.pageIndex, page.chapterIndex);
    }
  }
  return pageChapter;
}

function repairChapterIndexes(repairChapter: number, relatedChapter: number): number[] {
  return relatedChapter === repairChapter || relatedChapter === 0
    ? [repairChapter]
    : [repairChapter, relatedChapter];
}

function assignmentPageIndexes(findings: ProductionMapFinding[]): number[] {
  return findings.filter((finding) => ASSIGNMENT_CODES.has(finding.code)).flatMap((finding) => finding.pageIndexes);
}

function genericFields(page: PageProductionBeat): string[] {
  const fields: string[] = [];
  if (!isSubstantivePageAssignment(page.purpose)) {
    fields.push("purpose");
  }
  if (!isSubstantivePageAssignment(page.beat)) {
    fields.push("beat");
  }
  if (!isSubstantivePageAssignment(page.endingPressure)) {
    fields.push("endingPressure");
  }
  return fields;
}

function synthesizeRewriteFinding(
  finding: ProductionMapFinding,
  pages: PageProductionBeat[]
): DuplicateBeatFinding | undefined {
  const pageIndex = finding.pageIndexes[0];
  if (pageIndex === undefined || pageIndex <= 1) {
    return undefined;
  }
  const page = pages.find((candidate) => candidate.pageIndex === pageIndex);
  const earlier =
    [...pages]
      .reverse()
      .find(
        (candidate) =>
          candidate.pageIndex < pageIndex &&
          isSubstantivePageAssignment(candidate.purpose) &&
          isSubstantivePageAssignment(candidate.beat)
      ) ?? pages.find((candidate) => candidate.pageIndex === 1);
  if (!page || !earlier) {
    return undefined;
  }
  return {
    pageIndex,
    duplicateOfPageIndex: earlier.pageIndex,
    earlierText: `${earlier.purpose} ${earlier.beat}`.trim(),
    reason: finding.evidence
  };
}

function chaptersForPages(contract: ProductionMapContract, pageIndexes: number[]): number[] {
  return uniqueSorted(
    pageIndexes.flatMap((pageIndex) => {
      const chapter = contract.chapters.find(
        (candidate) => pageIndex >= candidate.startPage && pageIndex <= candidate.endPage
      );
      return chapter ? [chapter.chapterIndex] : [];
    })
  );
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function compareFindings(left: ProductionMapFinding, right: ProductionMapFinding): number {
  const leftPage = left.pageIndexes[0] ?? 0;
  const rightPage = right.pageIndexes[0] ?? 0;
  if (leftPage !== rightPage) {
    return leftPage - rightPage;
  }
  return left.code.localeCompare(right.code);
}
