import {
  evidenceForPages,
  manuscriptWarning,
  ratio,
  type ManuscriptIntegrityPage,
  type ManuscriptQualityIssue,
  type ManuscriptQualityIssueMetrics
} from "./manuscriptQualityIssue.js";
import {
  chaptersSpannedBy,
  dominantParagraphRole,
  type CachedManuscriptPage
} from "./manuscriptSignatures.js";

type StructuralPage = {
  page: ManuscriptIntegrityPage;
  markdown: string;
  plain: string;
  lower: string;
  words: Set<string>;
};

type RepeatedGrid = {
  labels: string[];
  owners: number[];
};

const SENTENCE_SPLIT = /(?<=[.!?])\s+|[;\n]+/u;
const ENGLISH_WORD = /[a-z][a-z'’-]*/g;

/**
 * Deterministic whole-manuscript signals for structural AI prose. These are
 * warnings rather than rewrite licences: recurrence supplies the evidence, but
 * genre and authorial intent still decide whether the pattern is a defect.
 *
 * English phrase families (grids, hedges, research-meta, generic placeholders)
 * run only when the orchestrator has classified the manuscript as English.
 * Cross-chapter concept comparison stays on for every language.
 */
export function structuralSlopIssues(
  cached: readonly CachedManuscriptPage[],
  options: { englishPhraseDetectors: boolean }
): ManuscriptQualityIssue[] {
  const contexts = cached.map(
    (page): StructuralPage => ({
      page: page.page,
      markdown: page.markdown,
      plain: page.plain,
      lower: page.plain.toLowerCase(),
      words: new Set(page.plain.toLowerCase().match(ENGLISH_WORD) ?? [])
    })
  );
  if (contexts.length === 0) {
    return [];
  }

  const english = options.englishPhraseDetectors
    ? englishStructuralIssues(contexts, cached)
    : [];
  return [...english, ...crossChapterConceptRepetitionIssues(contexts, cached)];
}

function englishStructuralIssues(
  contexts: StructuralPage[],
  cached: readonly CachedManuscriptPage[]
): ManuscriptQualityIssue[] {
  const grids = repeatedAnalyticalGrids(contexts);
  return [
    ...gridIssues(grids, cached),
    ...frameworkSaturationIssues(contexts, grids, cached),
    ...symmetricalHedgingIssues(contexts, cached),
    ...genericHistoricalPlaceholderIssues(contexts, cached),
    ...researchMetaFramingIssues(contexts, cached)
  ];
}

function repeatedAnalyticalGrids(pages: StructuralPage[]): RepeatedGrid[] {
  const ownersByGrid = new Map<string, { labels: string[]; owners: Set<number> }>();
  for (const { page, plain } of pages) {
    for (const labels of analyticalGridLabels(plain)) {
      const key = labels.join("|");
      const entry = ownersByGrid.get(key) ?? { labels, owners: new Set<number>() };
      entry.owners.add(page.index);
      ownersByGrid.set(key, entry);
    }
  }
  const minPages = recurringPageFloor(pages.length, 3, 0.05);
  return [...ownersByGrid.values()]
    .filter(({ owners }) => owners.size >= minPages)
    .map(({ labels, owners }) => ({ labels, owners: [...owners].sort((a, b) => a - b) }))
    .sort((left, right) => right.owners.length - left.owners.length)
    .slice(0, 2);
}

function analyticalGridLabels(text: string): string[][] {
  const grids: string[][] = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const commaParts = sentence.split(/\s*,\s*/u);
    if (commaParts.length < 5 || commaParts.length > 12) {
      continue;
    }
    const labels = commaParts
      .flatMap((part, index) => gridLabelsFromPart(part, index, commaParts.length))
      .map(normalizeGridLabel)
      .filter((label): label is string => Boolean(label));
    const distinct = [...new Set(labels)];
    if (distinct.length >= 5 && distinct.length <= 10) {
      grids.push(distinct.sort());
    }
  }
  return grids;
}

function gridLabelsFromPart(part: string, index: number, partCount: number): string[] {
  const cleaned = part
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:before|after|when|while|because|so that|in order to|rather than)\b.*$/u, " ")
    .trim();
  const andParts = cleaned.split(/\s+(?:and|or)\s+/u).filter(Boolean);
  if (andParts.length > 1) {
    return andParts.map((value) => terminalLabel(value));
  }
  return [index === 0 ? terminalLabel(cleaned) : index === partCount - 1 ? leadingLabel(cleaned) : terminalLabel(cleaned)];
}

function terminalLabel(value: string): string {
  const words = value.match(ENGLISH_WORD) ?? [];
  return words.at(-1) ?? "";
}

function leadingLabel(value: string): string {
  const words = value.match(ENGLISH_WORD) ?? [];
  const first = words.find((word) => !GRID_JOINERS.has(word));
  return first ?? "";
}

const GRID_JOINERS = new Set(["and", "or", "the", "a", "an"]);

function normalizeGridLabel(value: string): string {
  const singular = value.endsWith("ies") && value.length > 4
    ? `${value.slice(0, -3)}y`
    : value.endsWith("s") && !value.endsWith("ss") && value.length > 3
      ? value.slice(0, -1)
      : value;
  return GRID_LABEL_ALIASES[singular] ?? singular;
}

const GRID_LABEL_ALIASES: Record<string, string> = {
  aim: "goal",
  objective: "goal",
  actor: "actor",
  participant: "actor",
  context: "setting",
  environment: "setting",
  custom: "norm",
  convention: "norm",
  tool: "technology",
  source: "evidence",
  record: "evidence",
  organization: "institution"
};

function gridIssues(grids: RepeatedGrid[], cached: readonly CachedManuscriptPage[]): ManuscriptQualityIssue[] {
  return grids.map(({ labels, owners }) =>
    slopWarning(
      cached,
      "REPEATED_ANALYTICAL_GRID",
      `The same ${labels.length}-field analytical grid recurs on ${owners.length} pages (${labels.join(", ")}).`,
      "Keep the complete grid only where it adds a new comparison; let other sections follow the evidence's natural shape.",
      owners,
      { occurrences: owners.length }
    )
  );
}

function frameworkSaturationIssues(
  pages: StructuralPage[],
  grids: RepeatedGrid[],
  cached: readonly CachedManuscriptPage[]
): ManuscriptQualityIssue[] {
  const cuePages = pages
    .filter(({ lower }) => countPatternFamilies(lower, FRAMEWORK_CUE_PATTERNS) >= 3)
    .map(({ page }) => page.index);
  const cueThreshold = recurringPageFloor(pages.length, 4, 0.2);
  const candidates: number[][] = cuePages.length >= cueThreshold ? [cuePages] : [];

  for (const grid of grids) {
    const requiredLabels = Math.max(3, Math.ceil(grid.labels.length * 0.5));
    const partialGridPages = pages
      .filter(({ words }) => grid.labels.filter((label) => words.has(label) || words.has(`${label}s`)).length >= requiredLabels)
      .map(({ page }) => page.index);
    const saturationThreshold = recurringPageFloor(pages.length, 6, 0.25);
    if (partialGridPages.length >= saturationThreshold && partialGridPages.length > grid.owners.length) {
      candidates.push(partialGridPages);
    }
  }

  const affected = largestDistinctPageSet(candidates);
  if (affected.length === 0) {
    return [];
  }
  const occurrences = pages
    .filter(({ page }) => affected.includes(page.index))
    .reduce((sum, { lower }) => sum + countPatternOccurrences(lower, FRAMEWORK_CUE_PATTERNS), 0);
  return [
    slopWarning(
      cached,
      "FRAMEWORK_SATURATION",
      `Framework and checklist language dominates ${affected.length} pages across the manuscript.`,
      "Reserve the framework for synthesis points and replace repeated diagnostics with concrete argument, evidence, or narrative movement.",
      affected,
      { occurrences: Math.max(occurrences, affected.length) }
    )
  ];
}

const FRAMEWORK_CUE_PATTERNS = [
  /\b(?:use|apply|return to|through)\s+(?:the|this|our|a)\s+(?:comparison\s+)?(?:framework|grid|checklist|diagnostic|lens)\b/gu,
  /\bask whether\b/gu,
  /\bthe decisive question\b/gu,
  /\b(?:comparison|diagnostic)\s+(?:question|check|tool)\b/gu,
  /\b(?:useful|practical)\s+(?:framework|checklist|diagnostic|lens|grid|comparison|test|audit|inventory|protocol)\b/gu,
  /\b(?:ask|asks)\s+(?:three|four|five|six|seven|eight|nine|ten|\d+)\s+questions\b/gu,
  /\b(?:identify|record|label)\s+the\s+(?:actors|setting|goals|resources|institutions|norms|technology|evidence)\b/gu
] as const;

function symmetricalHedgingIssues(
  pages: StructuralPage[],
  cached: readonly CachedManuscriptPage[]
): ManuscriptQualityIssue[] {
  const hits = pages
    .map((page) => ({ page, count: countPatternOccurrences(page.lower, SYMMETRICAL_HEDGE_PATTERNS) }))
    .filter(({ count }) => count > 0);
  const affected = hits.map(({ page }) => page.page.index);
  if (affected.length < recurringPageFloor(pages.length, 4, 0.05)) {
    return [];
  }
  const sameParagraphRole = sameParagraphRoleAcross(
    pages.filter(({ page }) => affected.includes(page.index)),
    (lower) => countPatternFamilies(lower, SYMMETRICAL_HEDGE_PATTERNS) > 0
  );
  return [
    slopWarning(
      cached,
      "SYMMETRICAL_HEDGING",
      `${affected.length} pages rely on the same symmetrical hedge or balanced reversal.`,
      "Keep the contrast only where both sides are analytically necessary; state the supported claim directly elsewhere.",
      affected,
      {
        occurrences: hits.reduce((sum, { count }) => sum + count, 0),
        ...(sameParagraphRole !== undefined ? { sameParagraphRole } : {})
      }
    )
  ];
}

const SYMMETRICAL_HEDGE_PATTERNS = [
  /\bneither\b[^.!?\n]{2,180}\bnor\b/gu,
  /\bnot\s+(?:merely|simply|only|just|purely)\b[^.!?\n]{2,180}\bbut\s+(?:also|rather)\b/gu,
  /\bon the one hand\b[^.!?\n]{2,220}\bon the other(?: hand)?\b/gu,
  /\b(?:cannot|can't|could not|should not)\s+be\s+reduced\s+to\b[^.!?\n]{2,180}\b(?:nor|neither|but)\b/gu,
  /\bnot\b[^.!?\n]{2,140}\bby itself\b/gu,
  /\b(?:may|can)\b[^.!?\n]{2,120}\bwhile\b[^.!?\n]{2,120}\b(?:may|can)\b/gu,
  /\b(?:does not|cannot|can't)\s+(?:by itself\s+)?(?:dictate|determine|prove|establish|select|explain|mean|guarantee|settle)\b/gu,
  /\b(?:may|can)\b[^.!?\n]{2,140}\b(?:restrain|limit|reduce|prevent)\b[^.!?\n]{0,140}\b(?:or|and|while|but)\b[^.!?\n]{0,140}\b(?:enable|authorize|expand|increase|organize|intensify)\b/gu
] as const;

function genericHistoricalPlaceholderIssues(
  pages: StructuralPage[],
  cached: readonly CachedManuscriptPage[]
): ManuscriptQualityIssue[] {
  const affected = pages
    .filter(({ plain }) => {
      const sentences = plain.split(SENTENCE_SPLIT);
      const genericSentences = sentences
        .filter((sentence) => GENERIC_HISTORY_PATTERNS.some((pattern) => pattern.test(sentence)))
        .filter((sentence) => !hasHistoricalAnchor(sentence));
      const anchoredSentences = sentences.filter(hasHistoricalAnchor).length;
      return genericSentences.length >= 2 && genericSentences.length >= anchoredSentences + 2;
    })
    .map(({ page }) => page.index);
  return affected.length >= recurringPageFloor(pages.length, 3, 0.1)
    ? [
        slopWarning(
          cached,
          "GENERIC_HISTORICAL_PLACEHOLDERS",
          `${affected.length} pages substitute generic rulers, polities, or societies for named historical examples.`,
          "Replace hypothetical historical placeholders with named events, people, institutions, dates, or explicitly marked abstractions.",
          affected,
          { occurrences: affected.length }
        )
      ]
    : [];
}

const HISTORICAL_SUBJECT = "(?:ruler|leader|king|queen|polity|kingdom|empire|state|society|community|court|army|institution|region|people|group|settlement|storehouse|crossing|well|household|council|neighboring community|disputed resource)s?";
const GENERIC_HISTORY_PATTERNS = [
  new RegExp(`\\bconsider\\s+(?:a|an|one|some)\\s+${HISTORICAL_SUBJECT}\\b`, "iu"),
  new RegExp(`\\bin\\s+(?:one|some|many|another)\\s+${HISTORICAL_SUBJECT}\\b`, "iu"),
  new RegExp(`\\b(?:some|many|one|a|an)\\s+${HISTORICAL_SUBJECT}\\s+(?:may|might|could|would)\\b`, "iu"),
  new RegExp(`\\b(?:a|an|one|some|the)\\s+${HISTORICAL_SUBJECT}\\b[^.!?\\n]{0,160}\\b(?:may|might|could|would|can)\\b`, "iu"),
  /\b(?:in one case|in another case|at another point|across many societies)\b/iu
] as const;

function hasHistoricalAnchor(sentence: string): boolean {
  if (/\b(?:[1-9]\d{2,3}|\d{1,2}(?:st|nd|rd|th)\s+century)\s*(?:bce|ce|bc|ad)?\b/iu.test(sentence)) {
    return true;
  }
  const withoutOpening = sentence.trim().replace(/^["'“‘(]*[A-Z][a-z]+\b/u, "");
  return /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/u.test(withoutOpening);
}

function researchMetaFramingIssues(
  pages: StructuralPage[],
  cached: readonly CachedManuscriptPage[]
): ManuscriptQualityIssue[] {
  const hits = pages.filter(
    ({ page, lower }) =>
      !/^(?:sources|references|bibliography|methodology|notes)$/iu.test(page.title.trim()) &&
      countPatternFamilies(lower, RESEARCH_META_PATTERNS) > 0
  );
  const affected = hits.map(({ page }) => page.index);
  return affected.length >= recurringPageFloor(pages.length, 3, 0.05)
    ? [
        slopWarning(
          cached,
          "RESEARCH_META_FRAMING",
          `${affected.length} pages refer to supplied or provided research instead of presenting the evidence directly.`,
          "Name and cite the source or state the evidence-bound claim; remove internal descriptions of how research reached the writer.",
          affected,
          {
            occurrences: hits.reduce((sum, { lower }) => sum + countPatternOccurrences(lower, RESEARCH_META_PATTERNS), 0)
          }
        )
      ]
    : [];
}

const RESEARCH_META_PATTERNS = [
  /\b(?:the\s+)?supplied research\b/gu,
  /\b(?:the\s+)?provided research\b/gu,
  /\b(?:the\s+)?available research\b/gu,
  /\bresearch (?:supplied|provided)\b/gu,
  /\b(?:the\s+)?supplied (?:sources|materials|evidence)\b/gu,
  /\b(?:the\s+)?research (?:summary|summaries|note|notes)\b/gu
] as const;

function crossChapterConceptRepetitionIssues(
  pages: StructuralPage[],
  cached: readonly CachedManuscriptPage[]
): ManuscriptQualityIssue[] {
  const signatures = pages.map((page) => ({
    page,
    modules: conceptModules(page.plain),
    pageConcepts: conceptTerms(page.plain)
  }));
  const repeatedPages = new Set<number>();
  for (let left = 0; left < signatures.length; left += 1) {
    for (let right = left + 1; right < signatures.length; right += 1) {
      const leftEntry = signatures[left]!;
      const rightEntry = signatures[right]!;
      if (!differentChapter(leftEntry.page.page, rightEntry.page.page)) {
        continue;
      }
      if (
        modulesOverlap(leftEntry.modules, rightEntry.modules) ||
        pageConceptsOverlap(leftEntry.pageConcepts, rightEntry.pageConcepts)
      ) {
        repeatedPages.add(leftEntry.page.page.index);
        repeatedPages.add(rightEntry.page.page.index);
      }
    }
  }
  const affected = [...repeatedPages].sort((a, b) => a - b);
  return affected.length >= 2
    ? [
        slopWarning(
          cached,
          "CROSS_CHAPTER_CONCEPT_REPETITION",
          `${affected.length} pages in different chapters contain conceptually overlapping explanatory modules.`,
          "Keep the strongest treatment and make later chapters advance, challenge, or apply it rather than restating the same causal module.",
          affected,
          { occurrences: affected.length, clusterCount: 1 }
        )
      ]
    : [];
}

function conceptModules(text: string): Set<string>[] {
  const sentences = text.split(SENTENCE_SPLIT).map((sentence) => sentence.trim()).filter(Boolean);
  const modules: Set<string>[] = [];
  for (let start = 0; start < sentences.length; start += 1) {
    for (const width of [3, 4]) {
      const block = sentences.slice(start, start + width);
      if (block.length !== width) {
        continue;
      }
      const terms = conceptTerms(block.join(" "));
      if (terms.size >= 12) {
        modules.push(terms);
      }
    }
    if (modules.length >= 12) {
      break;
    }
  }
  return modules;
}

function conceptTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().match(ENGLISH_WORD) ?? []) {
    const normalized = normalizeConcept(raw);
    if (normalized.length >= 3 && !CONCEPT_STOP_WORDS.has(normalized)) {
      terms.add(normalized);
    }
  }
  return terms;
}

function normalizeConcept(raw: string): string {
  const depossessed = raw.replace(/['’]s$/u, "");
  const direct = CONCEPT_ALIASES[depossessed];
  if (direct) {
    return direct;
  }
  const stemmed = depossessed.endsWith("ies") && depossessed.length > 5
    ? `${depossessed.slice(0, -3)}y`
    : depossessed.endsWith("ing") && depossessed.length > 6
      ? depossessed.slice(0, -3)
      : depossessed.endsWith("ed") && depossessed.length > 5
        ? depossessed.slice(0, -2)
        : depossessed.endsWith("s") && depossessed.length > 4
          ? depossessed.slice(0, -1)
          : depossessed;
  return CONCEPT_ALIASES[stemmed] ?? stemmed;
}

const CONCEPT_ALIASES: Record<string, string> = {
  scarce: "scarcity",
  shortages: "scarcity",
  shortage: "scarcity",
  narrowed: "limit",
  limited: "limit",
  ruler: "actor",
  leader: "actor",
  choices: "choice",
  institutional: "institution",
  institutions: "institution",
  organizational: "institution",
  organization: "institution",
  rules: "institution",
  redirected: "redirect",
  aristocratic: "elite",
  incentives: "incentive",
  motives: "incentive",
  cultural: "culture",
  social: "culture",
  norms: "norm",
  customs: "norm",
  legitimized: "legitimize",
  legitimised: "legitimize",
  tools: "technology",
  increased: "expand",
  expanded: "expand",
  records: "evidence",
  documentary: "evidence",
  capacity: "resource",
  resources: "resource",
  combined: "combine",
  interacted: "combine"
};

const CONCEPT_STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "into", "then", "than", "while", "where", "which", "who",
  "their", "there", "these", "those", "through", "toward", "towards", "under", "over", "before", "after", "between",
  "also", "therefore", "thus", "however", "rather", "only", "same", "case", "page", "chapter", "possible", "available",
  "show", "shows", "showed", "about", "because", "during", "when", "what", "were", "was", "are", "is", "been", "being",
  "have", "has", "had", "could", "would", "might", "may", "can", "must", "should", "not", "but", "for", "of", "to", "in",
  "on", "at", "by", "as", "an", "a", "or", "its"
]);

function modulesOverlap(leftModules: Set<string>[], rightModules: Set<string>[]): boolean {
  for (const left of leftModules) {
    for (const right of rightModules) {
      const smaller = left.size <= right.size ? left : right;
      const larger = smaller === left ? right : left;
      if (smaller.size / larger.size < 0.62) {
        continue;
      }
      let intersection = 0;
      for (const term of smaller) {
        if (larger.has(term)) {
          intersection += 1;
        }
      }
      const union = left.size + right.size - intersection;
      if (intersection >= 12 && union > 0 && intersection / union >= 0.62) {
        return true;
      }
    }
  }
  return false;
}

function pageConceptsOverlap(left: Set<string>, right: Set<string>): boolean {
  if (left.size < 45 || right.size < 45) {
    return false;
  }
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (smaller.size / larger.size < 0.55) {
    return false;
  }
  let intersection = 0;
  for (const term of smaller) {
    if (larger.has(term)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return intersection >= 30 && union > 0 && intersection / union >= 0.28;
}

function differentChapter(left: ManuscriptIntegrityPage, right: ManuscriptIntegrityPage): boolean {
  if (left.chapterIndex !== undefined && right.chapterIndex !== undefined) {
    return left.chapterIndex !== right.chapterIndex;
  }
  return Math.abs(left.index - right.index) >= 5;
}

function countPatternFamilies(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      count += 1;
    }
  }
  return count;
}

function countPatternOccurrences(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    count += text.match(pattern)?.length ?? 0;
  }
  return count;
}

function recurringPageFloor(pageCount: number, floor: number, fraction: number): number {
  return Math.max(floor, Math.ceil(pageCount * fraction));
}

function largestDistinctPageSet(candidates: number[][]): number[] {
  const distinct = new Map<string, number[]>();
  for (const candidate of candidates) {
    const sorted = [...new Set(candidate)].sort((a, b) => a - b);
    if (sorted.length > 0) {
      distinct.set(sorted.join(","), sorted);
    }
  }
  return [...distinct.values()].sort((left, right) => right.length - left.length)[0] ?? [];
}

function sameParagraphRoleAcross(pages: StructuralPage[], test: (lower: string) => boolean): boolean | undefined {
  const roles = new Set(
    pages.flatMap((page) => {
      const role = dominantParagraphRole(page.markdown, (paragraph) => test(paragraph.toLowerCase()));
      return role ? [role] : [];
    })
  );
  return roles.size === 0 ? undefined : roles.size === 1;
}

function slopWarning(
  cached: readonly CachedManuscriptPage[],
  code: string,
  message: string,
  guidance: string,
  affected: number[],
  extras: {
    occurrences: number;
    clusterCount?: number;
    sameParagraphRole?: boolean;
  }
): ManuscriptQualityIssue {
  const metrics: ManuscriptQualityIssueMetrics = {
    occurrences: extras.occurrences,
    affectedPageRatio: ratio(affected.length, cached.length),
    chaptersSpanned: chaptersSpannedBy(cached, affected),
    ...(extras.clusterCount !== undefined ? { clusterCount: extras.clusterCount } : {}),
    ...(extras.sameParagraphRole !== undefined ? { sameParagraphRole: extras.sameParagraphRole } : {})
  };
  return manuscriptWarning(code, message, guidance, affected, {
    metrics,
    evidence: evidenceForPages(
      cached.map((page) => ({ index: page.page.index, plain: page.plain })),
      affected
    )
  });
}
