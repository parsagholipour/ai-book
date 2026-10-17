import { isStopOrAbortError } from "../../../../packages/core/src/adapters/retry.ts";
import type { ResearchAdapter, ResearchQuery, ResearchResult } from "../../../../packages/core/src/adapters/types.ts";
import { uniqueStrings } from "../../../../packages/core/src/collections.ts";
import type { BookPlan, ResearchSource } from "../../../../packages/core/src/index.ts";
import { RESEARCH_BRIEF_TITLE, RESEARCH_SOURCES_PER_QUERY } from "../../../../packages/core/src/generation/planner.ts";
import type { PrimarySourceSearch } from "../../../../packages/core/src/generation/primarySources.ts";
import { CHAPTER_MATERIAL_SEARCH_PURPOSE, type ChapterMaterialRequest, type MaterialWording } from "./chapterMaterialPrompt.ts";

/** The research adapter's query and answer as the shipped adapter would extend them. */
export type MaterialQuery = ResearchQuery & { material?: ChapterMaterialRequest | undefined };
export type MaterialResult = ResearchResult & { sections?: Array<{ key: string; text: string; sources: ResearchResult["sources"] }> | undefined };
export type MaterialResearch = { search(query: MaterialQuery): Promise<MaterialResult> };

/**
 * H3 prototype (not shipped): a chapter's grounded research in as few prompts as
 * yield allows (harness H3, 2026-10-16). A sourced book used to pay one grounded prompt for each
 * chapter's `chapter-research` brief and one for every dossier lead's
 * `case-source-search`, and kept only the titles and addresses of the second.
 * Here one `chapter-material-search` prompt carries the chapter's background
 * and two of its leads (`chapterMaterialPrompt.ts`): the dossier fetches each
 * lead's documents from the sources its own section cited, and every section's
 * text becomes a research brief the writer reads.
 *
 * A lead whose section cited nothing, or whose prompt failed, is searched on
 * its own as before (`case-source-search`); a chapter none of whose prompts
 * answered its background gets a plain `chapter-research` call. So the worst
 * case is today's calls plus the failed one, and the dossier never loses a
 * lead to the merge.
 */
export const LEADS_PER_MATERIAL_PROMPT = 2;

/** Per chapter, for the run log: what was asked and where it fell back. */
export type ChapterMaterialReport = {
  /** Material prompts sent. */
  prompts: number;
  /** Material prompts that failed (after the adapter's own retries). */
  failed: number;
  /** Material answers that cited no web source. */
  ungrounded: number;
  /** Leads searched on their own because their section cited nothing or their prompt failed. */
  leadFallbacks: number;
  /** A plain `chapter-research` call stood in for the background. */
  briefFallback: boolean;
  /** Sources each lead's own section cited, in the order the dossier asked. */
  perLead: Array<{ lead: string; sources: number }>;
};

export type ChapterMaterialSearch = {
  /**
   * The dossier's web discovery for one retrieval round of the chapter: the
   * round's leads go out in pairs, the chapter's first round carrying the
   * background in its first prompt, and each lead is answered from its own
   * section. A query that is not one of the round's leads is searched alone.
   */
  forRound(leads: readonly string[]): PrimarySourceSearch;
  /**
   * The chapter's research rows, under the chapter's research topic: each
   * answered section as a URL-less brief, then the cited sources. A chapter
   * whose background no material prompt answered is searched for it alone.
   */
  research(): Promise<ResearchSource[]>;
  report(): ChapterMaterialReport;
};

type WebSource = { title: string; url: string };

const webSources = (sources: ResearchResult["sources"]): WebSource[] =>
  sources.flatMap((source) => (source.url ? [{ title: source.title, url: source.url }] : []));

export function createChapterMaterialSearch(options: {
  research: MaterialResearch | ResearchAdapter;
  wording?: MaterialWording | undefined;
  /** The chapter's research topic (`chapterResearchQuery`): the background's subject and the rows' query. */
  topic: string;
  /** The plan's research queries folded into this chapter (`researchQueriesByChapter`). */
  alsoCover?: readonly string[] | undefined;
  projectId?: string | undefined;
}): ChapterMaterialSearch {
  const research = options.research as MaterialResearch;
  const { topic, projectId } = options;
  const alsoCover = uniqueStrings([...(options.alsoCover ?? [])]);
  type Prompt = { background: boolean; answer: Promise<MaterialResult | undefined> };
  const prompts: Prompt[] = [];
  const alone = new Map<string, Promise<WebSource[]>>();
  const report: ChapterMaterialReport = { prompts: 0, failed: 0, ungrounded: 0, leadFallbacks: 0, briefFallback: false, perLead: [] };
  let backgroundSent = false;

  const ask = (leads: string[], background: boolean): Prompt => {
    report.prompts += 1;
    const answer = research
      .search({
        query: topic,
        purpose: CHAPTER_MATERIAL_SEARCH_PURPOSE,
        ...(projectId ? { projectId } : {}),
        material: { ...(background ? { background: { alsoCover } } : {}), leads, ...(options.wording ? { wording: options.wording } : {}) }
      })
      .then(
        (result) => {
          if (webSources(result.sources).length === 0) report.ungrounded += 1;
          return result;
        },
        (error: unknown) => {
          if (isStopOrAbortError(error)) throw error;
          report.failed += 1;
          return undefined;
        }
      );
    // Awaited later; a stop that rejects it first is not an unhandled rejection.
    answer.catch(() => undefined);
    const prompt = { background, answer };
    prompts.push(prompt);
    return prompt;
  };

  const searchAlone = (query: string): Promise<WebSource[]> => {
    const key = query.trim();
    let found = alone.get(key);
    if (!found) {
      report.leadFallbacks += 1;
      found = research.search({ query: key, purpose: "case-source-search", ...(projectId ? { projectId } : {}) }).then((result) => webSources(result.sources));
      alone.set(key, found);
    }
    return found;
  };

  return {
    forRound(leads) {
      const round = uniqueStrings([...leads]);
      const owners = new Map<string, { prompt: Prompt; section: string }>();
      for (let start = 0; start < round.length; start += LEADS_PER_MATERIAL_PROMPT) {
        const group = round.slice(start, start + LEADS_PER_MATERIAL_PROMPT);
        const prompt = ask(group, !backgroundSent);
        backgroundSent = true;
        group.forEach((lead, position) => owners.set(lead, { prompt, section: `lead${position + 1}` }));
      }
      return async (query) => {
        const owner = owners.get(query.trim());
        if (!owner) return searchAlone(query);
        const answer = await owner.prompt.answer;
        const own = webSources(answer?.sections?.find((section) => section.key === owner.section)?.sources ?? []);
        report.perLead.push({ lead: query.trim(), sources: own.length });
        return own.length > 0 ? own : searchAlone(query);
      };
    },

    async research() {
      const answers = await Promise.all(prompts.map(async (prompt) => ({ prompt, result: await prompt.answer })));
      const rows: ResearchSource[] = [];
      const brief = (summary: string, query = topic) => rows.push({ query, title: RESEARCH_BRIEF_TITLE, summary });
      const seen = new Set<string>();
      const cite = (result: ResearchResult, query = topic) => {
        let kept = 0;
        for (const source of result.sources) {
          if (!source.url || seen.has(source.url) || kept >= RESEARCH_SOURCES_PER_QUERY) continue;
          seen.add(source.url);
          kept += 1;
          rows.push({ query, title: source.title, url: source.url, summary: source.summary, ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}) });
        }
      };
      const answeredBackground = answers.some(({ prompt, result }) => prompt.background && result?.sections?.some((section) => section.key === "background" && section.text.trim()));
      if (!answeredBackground) {
        // No material prompt carried the background, or its answer came back
        // empty: the chapter's own research as `chapter-research` asked it.
        report.briefFallback = true;
        const fallbacks = await Promise.allSettled([topic, ...alsoCover].map((query) => research.search({ query, purpose: "chapter-research", ...(projectId ? { projectId } : {}) })));
        for (const settled of fallbacks) {
          if (settled.status === "rejected") {
            if (isStopOrAbortError(settled.reason)) throw settled.reason;
            continue;
          }
          const summary = settled.value.summary.trim();
          if (summary) brief(summary, settled.value.query);
          cite(settled.value, settled.value.query);
        }
      }
      for (const { result } of answers) {
        for (const section of result?.sections ?? []) if (section.text.trim()) brief(section.text.trim());
      }
      for (const { result } of answers) if (result) cite(result);
      return rows;
    },

    report: () => ({ ...report, perLead: [...report.perLead] })
  };
}

/** A chapter's research topic, as `expandChapterResearch` builds it. */
export function chapterResearchQuery(plan: Pick<BookPlan, "title">, chapter: Pick<BookPlan["chapters"][number], "title" | "summary" | "keyBeats">): string {
  return [plan.title, chapter.title, chapter.summary, ...chapter.keyBeats.slice(0, 2)].filter(Boolean).join(" ");
}

/**
 * The plan's `researchQueries`, each folded into the chapter whose title and summary share the most content
 * words with it (three at least; the plan title's own words do not count), or left `unmatched`. A Balanced
 * planner restated its chapters as research queries — nine for an eight-chapter book — each another prompt.
 */
export function researchQueriesByChapter(plan: Pick<BookPlan, "title" | "chapters" | "researchQueries">): { byChapter: Map<number, string[]>; unmatched: string[] } {
  const titleWords = contentWords(plan.title);
  const chapters = plan.chapters.map((chapter) => ({ index: chapter.index, query: chapterResearchQuery(plan, chapter), words: contentWords(`${chapter.title} ${chapter.summary}`, titleWords) }));
  const chapterQueries = new Set(chapters.map((chapter) => chapter.query));
  const byChapter = new Map<number, string[]>();
  const unmatched: string[] = [];
  for (const query of uniqueStrings(plan.researchQueries)) {
    if (chapterQueries.has(query)) continue;
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
