import { isStopRequestedError, type ChapterSetup } from "../runtime/jobTypes.js";
import { retrieveSemanticResearchNotes } from "./researchMemory.js";
import { settleIndependentLoads } from "./independentLoads.js";
import {
  urlBackedResearchNotes,
  urlBackedResearchSources,
  validateSemanticResearchNotes
} from "./researchSources.js";
import {
  CONTINUITY_NOTE_PROMPT_LIMITS,
  type BookGenerationStrategy,
  type ChapterPlan,
  type EmbeddingAdapter
} from "@book-maker/core";
import {
  degradeRetrievalArm,
  PAGE_SCOPE_PREFIX,
  prisma,
  retrieveLexicalContinuityNotes,
  type LexicalContinuityNote
} from "@book-maker/db";

/**
 * Assembles the continuity and research context handed to the model for a page.
 */

/**
 * How many notes one load returns: the producer's side of the contract whose
 * consumer side is `CONTINUITY_NOTE_PROMPT_LIMITS` (`@book-maker/core`).
 *
 * Derived from that record rather than restated beside it, because the
 * hungriest prompt is what sets this budget. Load fewer notes than a consumer
 * keeps and that prompt is quietly starved — `continuityNotesForPrompt` takes
 * the tail of whatever it is handed and cannot tell a short load from a short
 * book — while loading more only reads rows every one of them then trims. So it
 * is the maximum over the record, not `.draft` by name (28 today, and the
 * largest), so that raising any prompt's budget carries this one with it.
 *
 * This direction is the only one that compiles: `packages/core` is the leaf, so
 * the worker may import the prompts' number and core may not import the
 * producer's.
 */
const CONTINUITY_NOTE_LIMIT = Math.max(...Object.values(CONTINUITY_NOTE_PROMPT_LIMITS));

/**
 * Continuity notes for a page draft.
 *
 * Without query terms this is pure recency (the newest notes). With them — the
 * entity names the page's brief mentions — notes naming those entities get up
 * to half the budget, ranked by trigram needle score, and the newest notes
 * fill the rest. Recency alone drops a setup planted forty pages ago long
 * before its payoff; the relevance share keeps the notes about this page's own
 * cast in reach, and trigram matching does it script-agnostically without
 * embedding the notes.
 *
 * The needles must be distinctive terms, never the composed brief: ranked by
 * symmetric `similarity()` against a ~300-char brief, almost every
 * same-language note cleared the old floor on shared stop-word trigrams alone
 * and unrelated notes outranked related ones — the relevance half filled with
 * noise and displaced half the recency window to do it. A needle below
 * `LEXICAL_SIMILARITY_FLOOR` (measured, see `@book-maker/db`) now returns
 * nothing, and only actual hits displace recency slots.
 *
 * A lexical failure (for example `pg_trgm` not applied) degrades to recency-only
 * rather than failing the page job. Recency/`findMany` failures still throw.
 *
 * **Both arms stop at `beforePageIndex`**, which every caller states — see the
 * parameter. Neither the newest notes nor the best-scoring ones are a prefix of
 * the manuscript once a page is redrafted into a finished book.
 *
 * **The result is ordered by ascending priority: the note the page most needs
 * is last.** Recency runs oldest to newest, then the relevance hits, best score
 * last of all. Every prompt truncates with `continuityNotesForPrompt`
 * (`@book-maker/core`), which keeps the tail — the same end `trimToBudget`
 * keeps when the context pack overflows, and the end nearest the model's
 * attention. The ranking used to be emitted descending instead, which meant a
 * reviewer taking 20 of these 28 threw away all eight top-scoring lexical hits
 * and kept the recency window the relevance arm was added to reach past. If you
 * change either end, change both: `CONTINUITY_NOTE_PROMPT_LIMITS` holds the
 * consumers' side of the contract and this suite asserts the two against each
 * other.
 */
export async function loadContinuityNotes(
  projectId: string,
  options: {
    /**
     * Exclusive upper bound in *model* page index — `Page.index`, never a
     * printed page number — or `null` for a load that deliberately spans the
     * whole book.
     *
     * Required, not defaulted, for the reason `retrieveSemanticPageMemory`'s
     * copy is (`semanticRecall.ts`): the `ContinuityNote` table is not a prefix
     * of the manuscript. Pages generate in waves up to `MAX_PARALLEL_PAGE_JOBS`
     * and a FAILED_QA page is redrafted long after its successors are COMPLETED
     * and have written notes of their own, so "everything stored so far" and
     * "everything before this page" are different sets on exactly the path that
     * matters. Unbounded, a page-30 redraft in a finished 60-page book is
     * handed the notes pages 41-60 wrote about that page's own cast — they name
     * it most, so they score highest — at the end of the list, which is the end
     * `continuityNotesForPrompt` keeps.
     *
     * `null` is a claim, not an opt-out: the reviewer, the whole-book passes, a
     * replan and a page inserted into finished prose are all judging a draft
     * against what the book *now* holds, including the pages after it — the
     * insert path passes `nextPages` for the same reason.
     */
    beforePageIndex: number | null;
    queryTerms?: string[] | undefined;
  }
): Promise<string[]> {
  // Page-scoped rows that remain unowned cannot safely be matched back from
  // `page:<index>`: an older structural edit may already have reused that index.
  // Keep genuinely project-scoped legacy notes, but do not let ambiguous
  // deleted-page prose enter a generation prompt.
  const ownershipFilter = { NOT: { pageId: null, scope: { startsWith: PAGE_SCOPE_PREFIX } } } as const;
  // The page bound, in both arms and in whichever query language each speaks —
  // one arm that stops at the page being drafted while the other keeps ranking
  // the future in is worse than either alone, because the leak survives and the
  // guarantee reads as if it does not.
  //
  // Through the `pageId` foreign key rather than the `page:<index>` scope: the
  // schema calls the scope display text and refuses it as identity, and an
  // edit's notes are scoped `page:<index>:edit:<operationId>`, which no
  // `^page:([0-9]+)$` reader can place at all. A surviving note with no page is
  // project-scoped — the ownership filter above has already dropped the
  // ambiguous page-scoped ones — and nothing bounds a note that belongs to no
  // page. `projectId` is repeated inside the relation so the lookup resolves
  // through `Page_projectId_index_key`.
  const pageBound =
    options.beforePageIndex === null
      ? {}
      : { OR: [{ pageId: null }, { page: { projectId, index: { lt: options.beforePageIndex } } }] };
  // Both branches take the same recency window, so it is issued once here and
  // cannot drift apart. The projection is the part that matters: the terms
  // branch concatenates these rows with the lexical arm's and dedupes the two by
  // `id`, so both sides have to be one `LexicalContinuityNote` shape — the
  // return annotation is what fails the build if this projection stops carrying
  // it. Nothing beyond `body` ever leaves this function, which returns
  // `string[]`; the no-terms branch had no `select` at all, so it hydrated
  // `scope`, `tags`, `pageId` and `createdAt` for 28 rows to read one column.
  const recentNotes = (): Promise<LexicalContinuityNote[]> =>
    prisma.continuityNote.findMany({
      where: { projectId, ...ownershipFilter, ...pageBound },
      orderBy: { createdAt: "desc" },
      take: CONTINUITY_NOTE_LIMIT,
      select: { id: true, body: true }
    });
  const queryTerms = (options.queryTerms ?? []).filter((term) => term.trim().length > 0);

  if (queryTerms.length === 0) {
    const continuity = await recentNotes();
    // `createdAt: desc` selects the newest of them; reversing then leaves the
    // newest last, where a truncating prompt keeps it.
    return continuity.map((note) => note.body).reverse();
  }

  // The recency fetch takes the full budget so a thin relevance result backfills
  // completely instead of wasting slots. The lexical arm is optional enrichment:
  // wrap only that promise so a missing pg_trgm (or similar) cannot fail a
  // charged page job, while a real recency/findMany failure still throws.
  // `degradeRetrievalArm` is that policy, shared with both arms of
  // `retrieveHybridEmbeddings` — same wording, and one report per distinct
  // failure per process rather than one per page job. It is exported rather
  // than hand-rolled because the hybrid retrieval failed whole for want of the
  // wrap that already lived here.
  const lexicalPromise = retrieveLexicalContinuityNotes({
    projectId,
    queryTerms,
    topK: Math.floor(CONTINUITY_NOTE_LIMIT / 2),
    // In the arm's own SQL, ahead of its `LIMIT`, so the bound narrows what the
    // top-K is cut from. Dropping later notes from the returned rows instead
    // would leave a redrafted page with whatever few of its fourteen slots
    // happened to hold the past.
    beforePageIndex: options.beforePageIndex
  }).catch((error: unknown) =>
    degradeRetrievalArm<LexicalContinuityNote[]>({
      arm: "Lexical continuity retrieval",
      projectId,
      error,
      fallback: [],
      rethrowIf: isStopRequestedError
    })
  );
  const [recency, lexical] = await Promise.all([recentNotes(), lexicalPromise]);

  // Selection runs best-first — a relevance hit outranks a recency slot, which
  // is what "only actual hits displace recency slots" means — and the result is
  // then reversed into the ascending order every prompt truncates from.
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const note of [...lexical, ...recency]) {
    if (seen.has(note.id)) {
      continue;
    }
    seen.add(note.id);
    ranked.push(note.body);
    if (ranked.length >= CONTINUITY_NOTE_LIMIT) {
      break;
    }
  }
  return ranked.reverse();
}

export async function loadResearchNotesForGeneration(
  projectId: string,
  strategy: BookGenerationStrategy,
  chapter?: ChapterPlan | undefined,
  semantic?: { embedding: EmbeddingAdapter; queryText: string; vector?: number[] | undefined } | undefined
): Promise<string[]> {
  const take = strategy.researchDepth ? strategy.researchDepth + 12 : 12;
  const [retrieved, storedSources] = await settleIndependentLoads([
    semantic
      ? retrieveSemanticResearchNotes({
          projectId,
          queryText: semantic.queryText,
          embedding: semantic.embedding,
          topK: take,
          ...(semantic.vector ? { vector: semantic.vector } : {})
        })
      : Promise.resolve([]),
    prisma.researchSource.findMany({
      // With a chapter to match against, every row of the project is read:
      // each chapter's query stored its own brief and sources, and a recency
      // window over ~150 rows (with createMany's one timestamp) is arbitrary.
      where: chapter ? { projectId } : { projectId, url: { not: null } },
      orderBy: { createdAt: "desc" },
      // Semantic hits may point beyond the recency window; load the URL-backed
      // identity set needed to validate those hits, then return only topK.
      ...(semantic || chapter ? {} : { take })
    })
  ]);
  // The Sources back matter can cite only rows with a real URL. Keep the
  // generation contract on the same boundary: URL-less grounding/bootstrap
  // summaries are useful planner context, but cannot satisfy a request to name
  // a diary, dispatch, archive, or testimony in reader-facing prose.
  const sources = urlBackedResearchSources(storedSources);
  const notes = urlBackedResearchNotes(sources);
  const citeableRetrieved = validateSemanticResearchNotes(retrieved, notes);
  if (citeableRetrieved.length > 0) {
    return citeableRetrieved;
  }
  if (!strategy.researchDepth || !chapter) {
    return notes;
  }

  const chapterTerms = searchableTerms(`${chapter.title} ${chapter.summary} ${chapter.keyBeats.join(" ")}`);
  // A chapter's own query carries its title, so its rows outrank every other
  // chapter's; within a rank the brief comes first, then by shared terms. Word
  // overlap alone put three chapters' briefs ahead of chapter 1's own.
  // Another chapter's brief is 900 words of another chapter; with a flat
  // bonus every brief outranked the chapter's own sources and each writer
  // read sixteen briefs and no sources (composed-22, 14.7k words a payload).
  const isBrief = (source: (typeof storedSources)[number]) => source.title === "Research brief";
  const score = (source: (typeof storedSources)[number]): number => {
    const own = source.query.includes(chapter.title);
    const terms = searchableTerms(`${source.query} ${source.title} ${source.summary}`);
    let shared = 0;
    for (const term of chapterTerms) if (terms.has(term)) shared += 1;
    if (own) return 1000 + (isBrief(source) ? 100 : 0) + shared;
    return isBrief(source) ? -1 : shared;
  };
  const matching = storedSources
    .filter((source) => hasSharedSearchTerm(chapterTerms, `${source.query} ${source.title} ${source.summary}`))
    .map((source) => ({ source, score: score(source) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    // The brief goes in untitled: titled "Research brief" it was cited in the
    // prose ("according to the research brief", composed-22).
    .map(({ source }) => (isBrief(source) ? source.summary : `${source.title}: ${source.summary}`));
  const general = notes.filter((note) => !matching.includes(note)).slice(0, 4);
  return [...matching, ...general].slice(0, strategy.researchDepth + 4);
}

export function chapterSetupForPage(chapterSetups: ChapterSetup[], pageIndex: number): ChapterSetup | undefined {
  return chapterSetups.find((setup) => pageIndex >= setup.startPage && pageIndex <= setup.endPage);
}

export function searchableTerms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((term) => term.length > 4)
  );
}

export function hasSharedSearchTerm(terms: Set<string>, value: string): boolean {
  const target = searchableTerms(value);
  for (const term of terms) {
    if (target.has(term)) {
      return true;
    }
  }
  return false;
}
