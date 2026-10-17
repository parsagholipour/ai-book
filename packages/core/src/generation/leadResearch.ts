import type { ResearchResult } from "../adapters/types.js";
import type { BookPlan, ResearchSource } from "../schemas/plan.js";
import { uniqueStrings } from "../collections.js";
import { RESEARCH_BRIEF_TITLE, RESEARCH_SOURCES_PER_QUERY } from "./planner.js";

/**
 * A sourced chapter's research notes are its leads' answers (H3b, 2026-10-16). The dossier searches each of
 * a chapter's leads once (`case-source-search`) for its documents, and that answer — paid for and thrown away
 * until then — is kept as the chapter's research note: one untitled brief per lead, opened by the lead's
 * title, beside the sources it cited. The chapter's own `chapter-research` search (`expandChapterResearch`)
 * is then made only for a chapter no lead answered for, and a plan research query only when it restates no
 * such chapter. Measured on four stored sourced books: grounded prompts 117 → 73 with the dossier unchanged,
 * and the writer's notes preferred blind (`.scratch/harness-redesign-2026-10-15/staging/H3b/`).
 */

/** What one lead's search returned, as the research adapter answers it. */
export type LeadSearchResult = Pick<ResearchResult, "query" | "summary" | "sources"> & { truncated?: boolean | undefined };
/** The chapter research an expansion still owes once the leads have answered: which chapters, which plan queries. */
export type ChapterResearchScope = { chapterIndexes: number[]; researchQueries: string[] };

const ADDRESS = String.raw`(?:https?:\/\/|www\.)[^\s<>()\[\]\x60"']+`;
const MARKDOWN_LINK = new RegExp(String.raw`\[([^\]\n]*)\]\(\s*<?${ADDRESS}>?\s*\)`, "giu");
const BARE_ADDRESS = new RegExp(String.raw`[<\x60]?${ADDRESS}[>\x60]?`, "giu");
const ADDRESS_ONLY = new RegExp(String.raw`^\s*[<\x60]?${ADDRESS}[>\x60]?\s*$`, "iu");
/** A label left with nothing to label once its address is gone ("URL:", "Direct link:"), on a line that held one. */
const EMPTY_LABEL = /(?:\*\*)?\b(?:urls?|links?|direct links?|source urls?|pdf|address)\b(?:\*\*)?\s*:\s*(?:\*\*)?(?=\s*(?:\(|$))/iu;

/**
 * A lead's answer as the writer is handed it: the lead's title, then the answer with every web address taken
 * out. The lead search is told to cite direct document URLs, and half its answers print them (15 of 30 logged);
 * a writer told never to name a website has no use for one, and a link is the shortest way to "available at …"
 * in prose. The title names the case the note is about, never a source, so the note reads like any other
 * `title: summary` row and keeps its label when the prompt budget shortens it.
 */
export function leadResearchNote(lead: string | undefined, answer: string): string {
  const text = answer
    .split(/\r?\n/u)
    .map((line) => {
      const stripped = line
        .replace(MARKDOWN_LINK, (_, label: string) => (ADDRESS_ONLY.test(label) ? "" : label))
        .replace(BARE_ADDRESS, "");
      return stripped === line ? line : stripped.replace(/\(\s*\)/gu, "").replace(EMPTY_LABEL, "").replace(/[ \t]+$/u, "");
    })
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .join("\n")
    .trim();
  if (!text) return "";
  const title = lead?.trim();
  return title ? `${title}: ${text}` : text;
}

/**
 * The research rows one lead's search leaves for its chapter: its answer as an untitled brief — none when the
 * answer was cut at its output budget, because a truncated answer keeps its sources and drops its text
 * (`RESEARCH_MAX_OUTPUT_TOKENS`) — then the sources it cited. The query carries the chapter's title, which is
 * how `loadResearchNotesForGeneration` ranks a chapter's own rows first and keeps every other chapter's briefs
 * out of it.
 */
export function leadResearchRows(options: { chapterTitle: string; lead?: string | undefined; result: LeadSearchResult }): ResearchSource[] {
  const query = `${options.chapterTitle}: ${options.result.query}`;
  const note = options.result.truncated ? "" : leadResearchNote(options.lead, options.result.summary);
  return [
    ...(note ? [{ query, title: RESEARCH_BRIEF_TITLE, summary: note }] : []),
    ...options.result.sources
      .filter((source) => Boolean(source.url))
      .slice(0, RESEARCH_SOURCES_PER_QUERY)
      .map((source) => ({ query, title: source.title, url: source.url, summary: source.summary, ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}) }))
  ];
}

/**
 * Collects every lead search a book's dossier makes, so each answer becomes its chapter's rows. `searchFor`
 * is the dossier's web discovery for one chapter, told which lead each query was searched for.
 */
export function createLeadResearch(search: (query: string) => Promise<LeadSearchResult>) {
  const answers: Array<{ chapterIndex: number; chapterTitle: string; lead: string | undefined; result: LeadSearchResult }> = [];
  const chapterRows = (index: number): ResearchSource[] => {
    const rows: ResearchSource[] = [];
    const seen = new Set<string>();
    for (const answer of answers.filter((entry) => entry.chapterIndex === index)) {
      for (const row of leadResearchRows(answer)) {
        if (row.url && seen.has(row.url)) continue;
        if (row.url) seen.add(row.url);
        rows.push(row);
      }
    }
    return rows;
  };
  return {
    searchFor(chapter: { index: number; title: string }) {
      return async (query: string, lead?: string | undefined): Promise<Array<{ title: string; url: string }>> => {
        const result = await search(query);
        answers.push({ chapterIndex: chapter.index, chapterTitle: chapter.title, lead, result });
        return result.sources.flatMap((source) => (source.url ? [{ title: source.title, url: source.url }] : []));
      };
    },
    /** Every chapter's rows in chapter order; a source two leads of one chapter cited is stored once. */
    rows(): ResearchSource[] {
      return [...new Set(answers.map((answer) => answer.chapterIndex))].sort((a, b) => a - b).flatMap((index) => chapterRows(index));
    },
    /** One chapter's rows, as `rows` writes them: what a chapter composed before the whole dossier settles reads. */
    rowsFor: (chapterIndex: number): ResearchSource[] => chapterRows(chapterIndex),
    report: () => ({
      answers: answers.length,
      truncated: answers.filter((answer) => answer.result.truncated).length,
      notes: answers.filter((answer) => !answer.result.truncated && leadResearchNote(answer.lead, answer.result.summary)).length
    })
  };
}

/**
 * What a chapter-research expansion still owes once `covered` chapters have their leads' answers: every other
 * chapter, and each plan research query that does not restate a covered chapter. A Balanced planner restated
 * all eight of its chapters as research queries, each another grounded prompt; and a query's brief never
 * reached a writer anyway, since its query names no chapter (`loadResearchNotesForGeneration`).
 */
export function researchScopeBeyondLeads(plan: Pick<BookPlan, "title" | "chapters" | "researchQueries">, covered: ReadonlySet<number>): ChapterResearchScope {
  const { byChapter, unmatched } = researchQueriesByChapter(plan);
  return {
    chapterIndexes: plan.chapters.filter((chapter) => !covered.has(chapter.index)).map((chapter) => chapter.index),
    researchQueries: [...unmatched, ...[...byChapter].flatMap(([index, queries]) => (covered.has(index) ? [] : queries))]
  };
}

/** The plan an expansion searches for `scope`: those chapters and those queries, nothing else changed. */
export function scopedResearchPlan<T extends Pick<BookPlan, "chapters" | "researchQueries">>(plan: T, scope: ChapterResearchScope): T {
  const chapters = new Set(scope.chapterIndexes);
  return { ...plan, chapters: plan.chapters.filter((chapter) => chapters.has(chapter.index)), researchQueries: [...scope.researchQueries] };
}

/**
 * The plan's research queries, each folded into the chapter whose title and summary share the most content
 * words with it (three at least; the plan title's own words do not count), or left `unmatched`.
 */
export function researchQueriesByChapter(plan: Pick<BookPlan, "title" | "chapters" | "researchQueries">): { byChapter: Map<number, string[]>; unmatched: string[] } {
  const titleWords = contentWords(plan.title);
  const chapters = plan.chapters.map((chapter) => ({ index: chapter.index, words: contentWords(`${chapter.title} ${chapter.summary}`, titleWords) }));
  const byChapter = new Map<number, string[]>();
  const unmatched: string[] = [];
  for (const query of uniqueStrings(plan.researchQueries)) {
    const words = contentWords(query, titleWords);
    let best: { index: number; shared: number } | undefined;
    for (const chapter of chapters) {
      let shared = 0;
      for (const word of words) if (chapter.words.has(word)) shared += 1;
      if (!best || shared > best.shared) best = { index: chapter.index, shared };
    }
    if (best && best.shared >= 3) byChapter.set(best.index, [...(byChapter.get(best.index) ?? []), query]);
    else unmatched.push(query);
  }
  return { byChapter, unmatched };
}

const STOPWORDS = new Set(
  ("about after also among because before being between both does each from have into many more most must only other over same some such than that their them " +
    "then there these they this those through under upon very what when where which while with within without would your using reliable current verified find " +
    "research check official sources source records record primary scholarly credible public include including clear clearly distinguish").split(" ")
);

function contentWords(text: string, exclude: ReadonlySet<string> = new Set()): Set<string> {
  const words = new Set<string>();
  for (const raw of text.normalize("NFKD").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    const word = raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (!exclude.has(word)) words.add(word);
  }
  return words;
}
