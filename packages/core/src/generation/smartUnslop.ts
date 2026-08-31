import type { PageQualityReport } from "../schemas/book.js";
import type { LocalPageReviewOptions } from "./pagesLocalQa.js";
import { skippedPageQualityReport } from "./pagesSkippedQualityReport.js";
import { countReadableWords, narrationOutsideQuotedSpeech } from "./proseShape.js";

/**
 * Deterministic evidence for the Smart unslop gate.
 *
 * One stock phrase is not a verdict. The gate rejects only a cluster spread
 * across more than one family, or the same conspicuous construction repeated
 * throughout the page. Quoted speech and code are removed before matching so
 * a character, citation, or passage discussing bad prose cannot spend a page's
 * rewrite budget.
 */

type SmartUnslopCategory = "framing" | "inflation" | "rhetoric" | "emphasis" | "coda";

type SmartUnslopRule = {
  id: string;
  category: SmartUnslopCategory;
  pattern: RegExp;
};

type SmartUnslopMatch = {
  ruleId: string;
  category: SmartUnslopCategory;
  start: number;
  end: number;
  excerpt: string;
};

const SMART_UNSLOP_RULES: readonly SmartUnslopRule[] = [
  {
    id: "reader-framing",
    category: "framing",
    pattern:
      /\b(?:here['’]s (?:the thing|the problem|the deal|what (?:you need to know|nobody tells you)|why)|let['’]s (?:dive (?:in|into)|delve into|unpack|explore|take a (?:closer )?look at)|it(?: is|['’]s) (?:worth|important) (?:noting|mentioning|remembering)(?: that)?|at (?:its|the) core|the reality is(?: that)?|what this means is|in today['’]s (?:fast[- ]paced|modern|digital|ever[- ]changing) (?:world|landscape))\b/giu
  },
  {
    id: "inflated-abstraction",
    category: "inflation",
    pattern:
      /\b(?:a testament to|serves? as (?:a )?(?:testament|reminder)|underscores? the (?:importance|need|significance)|pivotal role|crucial role|profound impact|transformative power|(?:intricate|rich) tapestry|intricate interplay|ever[- ]evolving landscape|beacon of (?:hope|innovation|progress)|unlock(?:ing|s)? (?:the|its|your|their) (?:full )?potential|navigat(?:e|es|ed|ing) the complexities of|delv(?:e|es|ed|ing) (?:deep )?into|deep dive into|sheds? light on)\b/giu
  },
  {
    id: "binary-reversal",
    category: "rhetoric",
    pattern:
      /\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t) (?:just|merely|simply)\b[^.!?؟\n]{0,90}[.,;:—–-]\s*(?:it|this|that|she|he|they|we)(?:['’](?:s|re)|\s+(?:is|was|are|were))\b/giu
  },
  {
    id: "binary-reversal",
    category: "rhetoric",
    pattern:
      /\b(?:is|are|was|were) not\b[^.!?؟\n]{1,90}[.!?؟]\s*(?:it|this|that|she|he|they|we)(?:['’](?:s|re)|\s+(?:is|was|are|were))\b/giu
  },
  {
    id: "performative-emphasis",
    category: "emphasis",
    pattern:
      /\b(?:make no mistake|let that sink in|read that again|this (?:cannot|can['’]t) be overstated|the (?:bottom line|key takeaway) is|here['’]s why (?:this|that) matters|this matters because|game[- ]changer|cutting[- ]edge|best[- ]in[- ]class|paradigm shift|food for thought)\b/giu
  },
  {
    id: "generic-coda",
    category: "coda",
    pattern:
      /\b(?:in conclusion|to sum up|all things considered|at the end of the day|moving forward|as we (?:move|look) (?:forward|ahead)|the (?:future|possibilities) (?:is|are) (?:bright|endless)|the journey (?:has only|is just) begun|only time will tell)\b/giu
  }
];

const LARGE_PAGE_WORDS = 600;
const NORMAL_MINIMUM_SIGNALS = 3;
const LARGE_PAGE_MINIMUM_SIGNALS = 4;
const MAX_REWRITE_EXCERPTS = 4;

export const SMART_UNSLOP_ISSUE_PREFIX = "Smart unslop candidate scan";

/** Whether this report carries deterministic candidates that still need contextual review. */
export function hasSmartUnslopCandidates(
  report: { issues?: readonly string[] | undefined }
): boolean {
  return report.issues?.some((issue) => issue.startsWith(SMART_UNSLOP_ISSUE_PREFIX)) ?? false;
}

/** Return a conditional rewrite request only when the scanner evidence is substantial. */
export function reviewPageDraftForSmartUnslop(options: LocalPageReviewOptions): PageQualityReport {
  const prose = smartUnslopReaderProse(options.draft.markdown);
  const matches = nonOverlappingMatches(prose);
  const minimumSignals =
    countReadableWords(prose) >= LARGE_PAGE_WORDS
      ? LARGE_PAGE_MINIMUM_SIGNALS
      : NORMAL_MINIMUM_SIGNALS;

  if (!isSignificantSmartUnslopCluster(matches, minimumSignals)) {
    return skippedPageQualityReport();
  }

  const excerpts = uniqueExcerpts(matches).slice(0, MAX_REWRITE_EXCERPTS);
  const quotedExcerpts = excerpts.map((excerpt) => `“${excerpt}”`).join(", ");
  const issue = `${SMART_UNSLOP_ISSUE_PREFIX} found ${matches.length} possible formulaic AI-writing signals in the page: ${quotedExcerpts}. These matches are candidates, not confirmed defects.`;
  const requiredRevision =
    `Contextually inspect the deterministic candidates (${quotedExcerpts}). They are not definite problems. ` +
    "Protect literal, domain-valid, quoted, attributed, accurately caveated, and genre-natural uses. " +
    "If no candidate is a clear defect, leave every candidate span unchanged; if the quality report names no separate issue, return the page exactly unchanged. Otherwise make the smallest repair only to confirmed spans, preserving every fact, name, quantity, citation, uncertainty, register, and meaning.";

  return {
    approved: false,
    score: 70,
    issues: [issue],
    requiredRevisions: [requiredRevision],
    notes: "Smart unslop found a significant candidate cluster that requires contextual review.",
    groundedOk: true,
    unsupportedClaims: [],
    checks: {
      placeholderFree: true,
      promptLeakFree: true,
      titleClean: true,
      repetitionOk: true,
      progressionOk: true,
      styleNatural: false
    }
  };
}

function smartUnslopReaderProse(markdown: string): string {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  return narrationOutsideQuotedSpeech(withoutCode).replace(/\s+/g, " ").trim();
}

function nonOverlappingMatches(prose: string): SmartUnslopMatch[] {
  const candidates = SMART_UNSLOP_RULES.flatMap((rule) =>
    [...prose.matchAll(rule.pattern)].map((match) => {
      const start = match.index ?? 0;
      const excerpt = compactExcerpt(match[0]);
      return {
        ruleId: rule.id,
        category: rule.category,
        start,
        end: start + match[0].length,
        excerpt
      };
    })
  ).sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start));

  const accepted: SmartUnslopMatch[] = [];
  for (const candidate of candidates) {
    if (accepted.some((match) => candidate.start < match.end && candidate.end > match.start)) {
      continue;
    }
    accepted.push(candidate);
  }
  return accepted;
}

function isSignificantSmartUnslopCluster(
  matches: readonly SmartUnslopMatch[],
  minimumSignals: number
): boolean {
  if (matches.length < minimumSignals) {
    return false;
  }
  const categories = new Set(matches.map((match) => match.category));
  if (categories.size >= 2) {
    return true;
  }
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.ruleId, (counts.get(match.ruleId) ?? 0) + 1);
  }
  return [...counts.values()].some((count) => count >= minimumSignals);
}

function uniqueExcerpts(matches: readonly SmartUnslopMatch[]): string[] {
  const seen = new Set<string>();
  const excerpts: string[] = [];
  for (const match of matches) {
    const key = match.excerpt.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    excerpts.push(match.excerpt);
  }
  return excerpts;
}

function compactExcerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 100 ? compact : `${compact.slice(0, 99).trimEnd()}…`;
}
