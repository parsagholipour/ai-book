import {
  compactExcerpt,
  type ManuscriptIntegrityPage,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueEvidence,
  type ManuscriptQualityIssueMetrics
} from "./manuscriptQualityIssue.js";

/** Finding codes whose clusters may be sent for targeted structural adjudication. */
export const STRUCTURAL_REVIEW_CANDIDATE_CODES = ["RECAP_BACKTRACKING", "CROSS_CHAPTER_CONCEPT_REPETITION"] as const;

export const MANUSCRIPT_REVIEW_PACK_MAX_PAGES = 4;
export const MANUSCRIPT_REVIEW_PACKS_PER_CALL = 3;
export const MANUSCRIPT_REVIEW_MAX_CALLS = 2;
export const MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS = 4_000;
export const MANUSCRIPT_REVIEW_PACK_MAX_SUMMARY_CHARS = 280;
export const MANUSCRIPT_REVIEW_MAX_OUTPUT_TOKENS = 1_800;
export const MANUSCRIPT_REVIEW_TEMPERATURE = 0;

export type ManuscriptReviewPackLimits = {
  maxPagesPerPack: number;
  maxPacksPerCall: number;
  maxCallsPerBook: number;
  maxProseCharsPerPage: number;
  maxNeighborSummaryChars: number;
};

export const DEFAULT_MANUSCRIPT_REVIEW_PACK_LIMITS: ManuscriptReviewPackLimits = {
  maxPagesPerPack: MANUSCRIPT_REVIEW_PACK_MAX_PAGES,
  maxPacksPerCall: MANUSCRIPT_REVIEW_PACKS_PER_CALL,
  maxCallsPerBook: MANUSCRIPT_REVIEW_MAX_CALLS,
  maxProseCharsPerPage: MANUSCRIPT_REVIEW_PACK_MAX_PROSE_CHARS,
  maxNeighborSummaryChars: MANUSCRIPT_REVIEW_PACK_MAX_SUMMARY_CHARS
};

export type ReviewablePage = ManuscriptIntegrityPage & {
  summary?: string;
  chapterTitle?: string;
};

export type ManuscriptReviewContentKind = "prose" | "summary" | "detector_evidence";

export type ManuscriptReviewPackPage = {
  contentKind: "prose";
  pageIndex: number;
  title: string;
  prose: string;
  truncated: boolean;
};

export type ManuscriptReviewPackNeighbor = {
  contentKind: "summary";
  pageIndex: number;
  title: string;
  summary: string;
};

export type ManuscriptReviewPackEvidence = {
  contentKind: "detector_evidence";
  pageIndex: number;
  excerpt: string;
};

export type ManuscriptReviewPack = {
  id: string;
  findingCodes: string[];
  chapterIndex?: number;
  chapterTitle?: string;
  metrics: ManuscriptQualityIssueMetrics;
  pageIndexes: number[];
  pages: ManuscriptReviewPackPage[];
  neighbors: ManuscriptReviewPackNeighbor[];
  detectorEvidence: ManuscriptReviewPackEvidence[];
  question: string;
  wouldBlock: boolean;
};

export type ManuscriptReviewPackSelection = {
  packs: ManuscriptReviewPack[];
  unadjudicatedFindings: ManuscriptQualityIssue[];
};

const CANDIDATE_CODE_SET = new Set<string>(STRUCTURAL_REVIEW_CANDIDATE_CODES);

const STRUCTURAL_REVIEW_QUESTION =
  "Do the implicated pages repeat the same subject treatment, reuse materially the same evidence, and reach the same conclusion without advancing? If they do, name the strongest page as canonical and the rest as duplicates. If this is a legitimate recurring subject that later pages apply, challenge, or extend with new evidence, return no cluster for this pack.";

/**
 * Deterministic review packs from structural candidate findings.
 * Tests should assert selected pages and content labels, not token math.
 */
export function buildManuscriptReviewPacks(
  pages: ReviewablePage[],
  findings: readonly ManuscriptQualityIssue[],
  limits: ManuscriptReviewPackLimits = DEFAULT_MANUSCRIPT_REVIEW_PACK_LIMITS
): ManuscriptReviewPack[] {
  return selectManuscriptReviewPacks(pages, findings, limits).packs;
}

export function selectManuscriptReviewPacks(
  pages: ReviewablePage[],
  findings: readonly ManuscriptQualityIssue[],
  limits: ManuscriptReviewPackLimits = DEFAULT_MANUSCRIPT_REVIEW_PACK_LIMITS
): ManuscriptReviewPackSelection {
  const byIndex = new Map(pages.map((page) => [page.index, page]));
  const candidates = findings.filter(
    (finding) => CANDIDATE_CODE_SET.has(finding.code) && finding.affectedPageIndexes.length >= 2
  );
  if (candidates.length === 0) {
    return { packs: [], unadjudicatedFindings: [] };
  }

  const groups = mergeOverlappingFindings(candidates);
  const ranked = groups
    .map((group) => rankGroup(group))
    .sort((left, right) => right.score - left.score || left.pageIndexes[0]! - right.pageIndexes[0]!);

  const budget = limits.maxPacksPerCall * limits.maxCallsPerBook;
  const selected = ranked.slice(0, budget);
  const unadjudicated = ranked.slice(budget).flatMap((entry) => entry.findings);
  const packs = selected.map((entry) =>
    packFromGroup(entry, byIndex, pages, limits)
  );
  return { packs, unadjudicatedFindings: unadjudicated };
}

type RankedGroup = {
  findings: ManuscriptQualityIssue[];
  pageIndexes: number[];
  score: number;
  wouldBlock: boolean;
};

function mergeOverlappingFindings(findings: ManuscriptQualityIssue[]): ManuscriptQualityIssue[][] {
  const groups: ManuscriptQualityIssue[][] = [];
  for (const finding of findings) {
    const pages = new Set(finding.affectedPageIndexes);
    const hits: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index]!.some((entry) => entry.affectedPageIndexes.some((pageIndex) => pages.has(pageIndex)))) {
        hits.push(index);
      }
    }
    if (hits.length === 0) {
      groups.push([finding]);
      continue;
    }
    const merged = [...hits.flatMap((index) => groups[index]!), finding];
    const next = groups.filter((_, index) => !hits.includes(index));
    next.push(merged);
    groups.length = 0;
    groups.push(...next);
  }
  return groups;
}

function rankGroup(findings: ManuscriptQualityIssue[]): RankedGroup {
  const pageIndexes = [...new Set(findings.flatMap((finding) => finding.affectedPageIndexes))].sort(
    (left, right) => left - right
  );
  const wouldBlock = findings.some((finding) => finding.metrics?.wouldBlock === true);
  const occurrences = Math.max(
    ...findings.map((finding) => finding.metrics?.occurrences ?? finding.affectedPageIndexes.length),
    pageIndexes.length
  );
  const evidenceCount = findings.reduce((sum, finding) => sum + (finding.evidence?.length ?? 0), 0);
  return {
    findings,
    pageIndexes,
    wouldBlock,
    score:
      (wouldBlock ? 1_000_000 : 0) + pageIndexes.length * 1_000 + occurrences * 10 + evidenceCount
  };
}

function packFromGroup(
  group: RankedGroup,
  byIndex: Map<number, ReviewablePage>,
  allPages: ReviewablePage[],
  limits: ManuscriptReviewPackLimits
): ManuscriptReviewPack {
  const selectedIndexes = group.pageIndexes.slice(0, limits.maxPagesPerPack);
  const packPages = selectedIndexes.flatMap((pageIndex) => {
    const page = byIndex.get(pageIndex);
    if (!page) {
      return [];
    }
    const bounded = boundProse(page.markdown, limits.maxProseCharsPerPage);
    const packPage: ManuscriptReviewPackPage = {
      contentKind: "prose",
      pageIndex,
      title: page.title,
      prose: bounded.prose,
      truncated: bounded.truncated
    };
    return [packPage];
  });
  const findingCodes = [...new Set(group.findings.map((finding) => finding.code))].sort();
  const chapter = chapterForPages(selectedIndexes, byIndex);
  const neighbors = neighborSummaries(selectedIndexes, byIndex, allPages, limits.maxNeighborSummaryChars);
  const detectorEvidence = detectorEvidenceFor(group.findings, selectedIndexes);
  const metrics = mergedMetrics(group);
  const pack: ManuscriptReviewPack = {
    id: `structural:${findingCodes.join("+")}:${selectedIndexes.join("-")}`,
    findingCodes,
    metrics,
    pageIndexes: selectedIndexes,
    pages: packPages,
    neighbors,
    detectorEvidence,
    question: STRUCTURAL_REVIEW_QUESTION,
    wouldBlock: group.wouldBlock
  };
  return {
    ...pack,
    ...(chapter.chapterIndex !== undefined ? { chapterIndex: chapter.chapterIndex } : {}),
    ...(chapter.chapterTitle ? { chapterTitle: chapter.chapterTitle } : {})
  };
}

function chapterForPages(
  indexes: readonly number[],
  byIndex: Map<number, ReviewablePage>
): { chapterIndex?: number; chapterTitle?: string } {
  const counts = new Map<number, number>();
  for (const pageIndex of indexes) {
    const chapterIndex = byIndex.get(pageIndex)?.chapterIndex;
    if (chapterIndex === undefined) {
      continue;
    }
    counts.set(chapterIndex, (counts.get(chapterIndex) ?? 0) + 1);
  }
  let chapterIndex: number | undefined;
  let best = 0;
  for (const [index, count] of counts) {
    if (count > best || (count === best && (chapterIndex === undefined || index < chapterIndex))) {
      chapterIndex = index;
      best = count;
    }
  }
  const titled = indexes
    .map((pageIndex) => byIndex.get(pageIndex))
    .find((page): page is ReviewablePage => Boolean(page && page.chapterIndex === chapterIndex && page.chapterTitle));
  return {
    ...(chapterIndex !== undefined ? { chapterIndex } : {}),
    ...(titled?.chapterTitle ? { chapterTitle: titled.chapterTitle } : {})
  };
}

function neighborSummaries(
  packIndexes: readonly number[],
  byIndex: Map<number, ReviewablePage>,
  allPages: ReviewablePage[],
  maxChars: number
): ManuscriptReviewPackNeighbor[] {
  if (packIndexes.length === 0) {
    return [];
  }
  const packSet = new Set(packIndexes);
  const first = packIndexes[0]!;
  const last = packIndexes[packIndexes.length - 1]!;
  const candidates = [first - 1, last + 1].filter((pageIndex) => !packSet.has(pageIndex));
  return candidates.flatMap((pageIndex) => {
    const page = byIndex.get(pageIndex) ?? allPages.find((entry) => entry.index === pageIndex);
    if (!page) {
      return [];
    }
    const summarySource = page.summary?.trim() || compactExcerpt(page.markdown.replace(/\s+/g, " ").trim(), maxChars);
    const neighbor: ManuscriptReviewPackNeighbor = {
      contentKind: "summary",
      pageIndex,
      title: page.title,
      summary: compactExcerpt(summarySource, maxChars)
    };
    return [neighbor];
  });
}

function detectorEvidenceFor(
  findings: readonly ManuscriptQualityIssue[],
  packIndexes: readonly number[]
): ManuscriptReviewPackEvidence[] {
  const packSet = new Set(packIndexes);
  const seen = new Set<string>();
  const evidence: ManuscriptReviewPackEvidence[] = [];
  for (const finding of findings) {
    for (const entry of finding.evidence ?? []) {
      if (!packSet.has(entry.pageIndex)) {
        continue;
      }
      const key = `${entry.pageIndex}:${entry.excerpt}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      evidence.push({
        contentKind: "detector_evidence",
        pageIndex: entry.pageIndex,
        excerpt: entry.excerpt
      });
    }
  }
  return evidence;
}

function mergedMetrics(group: RankedGroup): ManuscriptQualityIssueMetrics {
  const occurrences = Math.max(
    ...group.findings.map((finding) => finding.metrics?.occurrences ?? finding.affectedPageIndexes.length)
  );
  const chaptersSpanned = Math.max(0, ...group.findings.map((finding) => finding.metrics?.chaptersSpanned ?? 0));
  const clusterCount = group.findings.reduce(
    (sum, finding) => sum + (finding.metrics?.clusterCount ?? 1),
    0
  );
  const metrics: ManuscriptQualityIssueMetrics = {
    occurrences,
    clusterCount,
    wouldBlock: group.wouldBlock
  };
  const ratio = group.findings.find((finding) => finding.metrics?.affectedPageRatio !== undefined)?.metrics
    ?.affectedPageRatio;
  return {
    ...metrics,
    ...(ratio !== undefined ? { affectedPageRatio: ratio } : {}),
    ...(chaptersSpanned > 0 ? { chaptersSpanned } : {})
  };
}

function boundProse(markdown: string, maxChars: number): { prose: string; truncated: boolean } {
  const compact = markdown.trim();
  if (compact.length <= maxChars) {
    return { prose: compact, truncated: false };
  }
  const marker = "\n…\n";
  const budget = Math.max(2, maxChars - marker.length);
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);
  return {
    prose: `${compact.slice(0, headLen).trimEnd()}${marker}${compact.slice(compact.length - tailLen).trimStart()}`,
    truncated: true
  };
}

/** Split selected packs into provider-call groups. Already budget-capped by `selectManuscriptReviewPacks`. */
export function groupPacksForCalls(
  packs: readonly ManuscriptReviewPack[],
  limits: ManuscriptReviewPackLimits = DEFAULT_MANUSCRIPT_REVIEW_PACK_LIMITS
): ManuscriptReviewPack[][] {
  const groups: ManuscriptReviewPack[][] = [];
  for (let index = 0; index < packs.length; index += limits.maxPacksPerCall) {
    groups.push(packs.slice(index, index + limits.maxPacksPerCall));
  }
  return groups.slice(0, limits.maxCallsPerBook);
}

export function isStructuralReviewCandidate(finding: Pick<ManuscriptQualityIssue, "code">): boolean {
  return CANDIDATE_CODE_SET.has(finding.code);
}

export function evidenceLabel(entry: ManuscriptQualityIssueEvidence): ManuscriptReviewPackEvidence {
  return { contentKind: "detector_evidence", pageIndex: entry.pageIndex, excerpt: entry.excerpt };
}
