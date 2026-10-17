import {
  bookDossierSchema,
  bookEpisodesSchema,
  sourceResearchFits,
  supportsBookDevelopment,
  chapterEpisodeSchema,
  createLeadResearch,
  episodesForChapter,
  instructionalSettingSchema,
  mapWithConcurrency,
  planDossierFromPlan,
  planEpisodes,
  planEpisodesFromPlan,
  researchScopeBeyondLeads,
  isRecord,
  type AuthorStance,
  type BookDossier,
  type BookEpisodes,
  type BookPlan,
  type ChapterResearchScope,
  type ComposeContract,
  type InstructionalSetting,
  type CreateProjectInput,
  type LeadSearchResult,
  type ResearchSource,
  type TextModelAdapter,
  type PrimarySourceSearch
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { fetchSourceDocument as primarySourceFetch } from "./sourceDocumentFetch.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import type { loadQualityContext } from "./qualitySettings.js";
import { config } from "../runtime/config.js";
import type { RunLogger } from "../providers/runLogging.js";
import { mergeSourceDossiers, retrieveChapterSources } from "./sourceDossier.js";
import { SOURCE_CLAIM_REVIEW } from "./sourceClaimState.js";

/**
 * Material-first, the worker's half: the writer's contract and the book's
 * episodes and dossier, planned once per book and stored on the plan like
 * the arc, so a resumed run composes from the same material. Legacy failures degrade to composing without material; the evidence-required
 * caller rejects an insufficient dossier before drafting. Split
 * from `composedChaptersPass.ts` for the 900-line budget.
 */
export type BookMaterial = {
  contract: ComposeContract;
  episodes: BookEpisodes | undefined;
  dossier: BookDossier | undefined;
};

type MaterialOptions = {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  stance: AuthorStance;
  textModel: TextModelAdapter;
  searchSources?: PrimarySourceSearch | undefined;
  quality: Awaited<ReturnType<typeof loadQualityContext>>;
  generationJobId?: string | undefined;
  /** A new development run gathers material even when the legacy experiment flag is off. */
  evidenceRequired?: boolean | undefined;
  persist?: boolean | undefined;
  /**
   * Called once the episodes are settled and before any source is gathered: what the form plan waits for.
   * A practical guide's or a workbook's research leads come with the country its rules belong to.
   */
  onEpisodes?: ((episodes: BookEpisodes | undefined, setting?: InstructionalSetting | undefined) => void) | undefined;
  /**
   * The dossier's lead search with its answer, for a book whose strategy expands chapter research: each answer
   * becomes its chapter's research note (core `leadResearch.ts`), written with the dossier's rows, in place of
   * that chapter's own `chapter-research` search. Without it the dossier searches through `searchSources`.
   */
  leadResearch?: ((query: string) => Promise<LeadSearchResult>) | undefined;
  /**
   * Called exactly once, before any source is gathered, with the chapter research the leads leave owing —
   * `undefined` when no chapter will have lead notes this run, which is the whole expansion.
   */
  onResearchScope?: ((scope: ChapterResearchScope | undefined) => void) | undefined;
  /** Set once the pass is writing chapters: a chapter still gathering must not move the bar back to "gathering sources". */
  progress?: { muted: boolean } | undefined;
  runLog?: Pick<RunLogger, "append"> | undefined;
};

/** The episodes a composed book is written from, settled before any source is gathered. */
export type SettledEpisodes = {
  contract: ComposeContract;
  /** Whether this book gathers sources at all (`sourceResearchFits` and the gates), and whether it is written from them. */
  gather: boolean;
  sourceResearch: boolean;
  /** What the form plan and the dossier read: stored or planned, with a stand-in for every chapter a sourced book planned no lead for. */
  episodes: BookEpisodes | undefined;
  /** Chapters the planner gave leads, before the stand-ins. */
  plannedLeads: ReadonlySet<number>;
  setting: InstructionalSetting | undefined;
  /** `planned` this call, `stored` by an earlier run or the prep, `none` when the book plans none, `failed` when the planner returned none. */
  outcome: "planned" | "stored" | "none" | "failed";
};

/**
 * The episodes half of the material, on its own so the speculative prep
 * (`composedSpeculativePrep.ts`) plans exactly what a book run would: the same
 * decision about gathering, the same planner call, the same stand-ins. A run
 * that plans them stores the episodes and the setting they came with, so a
 * later run plans its forms from the same setting; `writeEpisodes` replaces
 * that store for the prep, whose writes are fenced.
 */
export async function settleBookEpisodes(options: Pick<MaterialOptions, "projectId" | "planId" | "input" | "plan" | "stance" | "textModel" | "quality" | "generationJobId" | "evidenceRequired" | "persist"> & {
  writeEpisodes?: ((episodes: BookEpisodes, setting: InstructionalSetting | undefined) => Promise<void>) | undefined;
}): Promise<SettledEpisodes> {
  const { projectId, planId, input, plan, stance, textModel, quality, generationJobId } = options;
  // A book written from sources gathers an evidence dossier on every tier,
  // the claim review or not: Quick Draft without one lost 12 of 12 blind
  // readings (2026-09-30), its readers missing exactly the figures,
  // quotations and named studies the passages had carried. Which book that
  // is, the stance says (`sourceResearchFits`): a novel gathers nothing, on
  // any tier and under materialFirst too, and a true story filed under Story
  // gathers like a history. It was held to the grounded contract only because
  // the review checked its prose; with the review off (SOURCE_CLAIM_REVIEW)
  // the creativeContract gate decides for every book.
  const fits = sourceResearchFits(input, plan, stance);
  const sourceResearch = !config.MOCK_AI && fits;
  const contract: ComposeContract = sourceResearch && SOURCE_CLAIM_REVIEW && supportsBookDevelopment(input, plan) ? "grounded" : quality.enabled("creativeContract") ? "creative" : "grounded";
  // Episodes an earlier run stored stay in use, whatever a regenerated stance says on resume.
  let episodes: BookEpisodes | undefined = planEpisodesFromPlan(plan);
  let setting: InstructionalSetting | undefined = episodes ? plan.instructionalSetting : undefined;
  const gather = (quality.enabled("materialFirst") && fits) || Boolean(options.evidenceRequired) || sourceResearch;
  let outcome: SettledEpisodes["outcome"] = episodes ? "stored" : "none";
  if (!episodes && gather) {
    await advanceJobStep(generationJobId, "briefs", 14, "Planning the book's episodes", { phase: "episodes" });
    // The chapter focus is the `chapterFocus` gate's: off, the episodes
    // carry no question and the chapter composes from the stance.
    const planned = await planEpisodes({ input, plan, stance, textModel, evidenceRequired: options.evidenceRequired || sourceResearch, focus: quality.enabled("chapterFocus") });
    if (planned.contract) {
      console.warn("Episode plan contract", {
        event: "generation.composed_chapters.focus_contract",
        projectId,
        ...planned.contract
      });
    }
    if (planned.episodes) {
      // Read the way a stored copy is read back, so a run composing from these and one composing from the
      // stored ones hand every prompt the same object.
      episodes = planEpisodesFromPlan({ episodes: planned.episodes } as BookPlan) ?? planned.episodes;
      setting = planned.setting;
      outcome = "planned";
      if (options.writeEpisodes) {
        await options.writeEpisodes(episodes, setting);
      } else if (options.persist !== false) {
        await persistPlanField(planId, "episodes", episodes, (value) => bookEpisodesSchema.safeParse(value).success);
        if (setting) await persistPlanField(planId, "instructionalSetting", setting, (value) => instructionalSettingSchema.safeParse(value).success);
      }
    } else {
      outcome = "failed";
      console.warn("Episodes not produced; composing without material", {
        event: "generation.composed_chapters.episodes_not_produced",
        projectId,
        reason: planned.failure
      });
    }
  }
  // Planned leads only: a chapter given the stand-in below still owes its own chapter research.
  const plannedLeads = new Set((episodes?.chapters ?? []).filter((entry) => entry.episodes.length > 0).map((entry) => entry.index));
  if ((episodes || gather) && sourceResearch) {
    // A missing episode proposal must not silently disable factual retrieval for a chapter.
    episodes = { chapters: plan.chapters.map((chapter) => {
      const stored = episodes?.chapters.find((entry) => entry.index === chapter.index);
      return stored?.episodes.length ? stored : { ...stored, index: chapter.index, episodes: [chapterEpisodeSchema.parse({
        title: chapter.title, kind: "document", why: chapter.summary,
        searchQueries: [chapter.title + " " + chapter.keyBeats.join(" "), `${plan.title} ${chapter.title} original source documentation`]
      })] };
    }) };
  }
  return { contract, gather, sourceResearch, episodes, plannedLeads, setting, outcome };
}

/**
 * The material a pass composes from, handed over as soon as the episodes are
 * settled and the gathering has started, so each chapter waits for its own
 * dossier and lead notes rather than every chapter's (harness redesign H4).
 */
export type StartedBookMaterial = {
  contract: ComposeContract;
  episodes: BookEpisodes | undefined;
  /** The dossier the plan stored before this run gathered anything (its case packets included). */
  storedDossier: BookDossier | undefined;
  /**
   * Chapter N's dossier: the stored one with what this run gathered for N merged in. Every excerpt and
   * document is keyed by its chapter, so its chapter-N entries are exactly the whole dossier's.
   */
  dossierFor(chapterIndex: number): Promise<BookDossier | undefined>;
  /** Every chapter gathered, the dossier persisted and its rows written: what `prepareBookMaterial` returns. */
  whole: Promise<BookDossier | undefined>;
  /** Rows of the chapters gathered so far that are not in the table yet (their lead notes and documents), for the writer's notes. */
  pendingRows(): ResearchSource[];
};

export async function prepareBookMaterial(options: MaterialOptions): Promise<BookMaterial> {
  const started = await startBookMaterial(options);
  const dossier = await started.whole;
  return { contract: started.contract, episodes: started.episodes, dossier };
}

export async function startBookMaterial(options: MaterialOptions): Promise<StartedBookMaterial> {
  const { projectId, planId, input, plan, textModel, quality, generationJobId } = options;
  const settled = await settleBookEpisodes(options);
  const { contract, episodes, gather, sourceResearch, plannedLeads, setting } = settled;
  let researchScoped = false;
  const scopeResearch = (covered: ReadonlySet<number>) => {
    if (researchScoped) return;
    researchScoped = true;
    const scope = covered.size > 0 ? researchScopeBeyondLeads(plan, covered) : undefined;
    options.onResearchScope?.(scope);
    // A trace never decides the run, and this one is written from a synchronous callback.
    try {
      void Promise.resolve(options.runLog?.append("generation.composed_chapters.research_scope", {
        projectId, leadNoteChapters: [...covered], chapterResearch: scope ? scope.chapterIndexes : "all", researchQueries: scope ? scope.researchQueries.length : plan.researchQueries.length
      })).catch(() => undefined);
    } catch { /* see above */ }
  };
  if (episodes || gather) options.onEpisodes?.(episodes, setting);
  const storedDossier = episodes ? planDossierFromPlan(plan) : undefined;
  const nothingGathered = (dossier: BookDossier | undefined): StartedBookMaterial => {
    scopeResearch(new Set());
    return { contract, episodes, storedDossier: dossier, dossierFor: async () => dossier, whole: Promise.resolve(dossier), pendingRows: () => [] };
  };
  if (!episodes) return nothingGathered(undefined);
  const missing = !gather ? [] : plan.chapters.filter((chapter) => !storedDossier || (sourceResearch &&
    !storedDossier.excerpts.some((excerpt) => excerpt.chapterIndex === chapter.index && excerpt.provenanceVerified) &&
    !storedDossier.researchedChapters?.includes(chapter.index)));
  // Lead notes are written with the dossier's rows, so only a run that gathers and persists keeps them.
  const leadNotes = missing.length && options.leadResearch && options.persist !== false ? createLeadResearch(options.leadResearch) : undefined;
  scopeResearch(new Set(leadNotes ? missing.filter((chapter) => plannedLeads.has(chapter.index)).map((chapter) => chapter.index) : []));
  if (!missing.length) return nothingGathered(storedDossier);
  await advanceJobStep(generationJobId, "briefs", 15, "Gathering primary sources for every chapter", {
    phase: "sources",
    total: plan.chapters.length
  });
  const plannedEpisodes = episodes;
  // One deferred per chapter gathered, settled the moment its retrieval is.
  const gathering = new Map(missing.map((chapter) => [chapter.index, deferred<BookDossier>()]));
  const gathered = new Map<number, BookDossier>();
  // The whole book's dossier gets a fixed budget; a slow repository
  // shortens the dossier, never the book's schedule.
  const dossierDeadline = Date.now() + DOSSIER_TIME_BUDGET_MS;
  let written = false;
  const whole = (async () => {
    const chapterDossiers = await mapWithConcurrency(missing, quality.enabled("wideSourceGathering") ? WIDE_DOSSIER_CHAPTER_CONCURRENCY : DOSSIER_CHAPTER_CONCURRENCY, async (chapter) => {
      if (!options.progress?.muted) {
        await advanceJobStep(generationJobId, "briefs", 15, "Gathering primary sources for every chapter", {
          phase: "sources",
          chapterIndex: chapter.index,
          total: plan.chapters.length
        });
      }
      const result = await retrieveChapterSources({
        projectId,
        input,
        chapter,
        episodes: episodesForChapter(plannedEpisodes, chapter.index),
        textModel,
        fetch: primarySourceFetch,
        searchSources: options.searchSources,
        ...(leadNotes ? { leadSearch: leadNotes.searchFor(chapter) } : {}),
        deadline: dossierDeadline,
        evidence: options.evidenceRequired || sourceResearch,
        runLog: options.runLog
      });
      gathered.set(chapter.index, result);
      gathering.get(chapter.index)?.resolve(result);
      return result;
    });
    const merged = mergeSourceDossiers(...(storedDossier ? [storedDossier] : []), ...chapterDossiers);
    const dossier: BookDossier = { ...storedDossier, ...merged,
      researchedChapters: [...new Set([...(storedDossier?.researchedChapters ?? []), ...missing.map((chapter) => chapter.index)])],
      researchGaps: plan.chapters.filter((chapter) => !merged.excerpts.some((excerpt) => excerpt.chapterIndex === chapter.index))
        .map((chapter) => ({ chapterIndex: chapter.index, reason: "No supporting source passages after bounded retrieval." }))
    };
    if (options.persist !== false) await persistPlanField(planId, "dossier", dossier, (value) => {
      const saved = bookDossierSchema.safeParse(value);
      return saved.success && missing.every((chapter) => saved.data.researchedChapters?.includes(chapter.index));
    });
    if (leadNotes) await options.runLog?.append("generation.composed_chapters.lead_notes", { projectId, ...leadNotes.report() });
    if (options.persist !== false) await recordDossierSources(projectId, dossier, leadNotes?.rows());
    written = true;
    return dossier;
  })();
  // A chapter not yet gathered when the gathering fails waits for nothing: it fails with it.
  whole.catch((error: unknown) => {
    for (const pending of gathering.values()) pending.reject(error);
  });
  for (const pending of gathering.values()) pending.promise.catch(() => undefined);
  return {
    contract,
    episodes,
    storedDossier,
    dossierFor: async (chapterIndex) => {
      const pending = gathering.get(chapterIndex);
      if (!pending) return storedDossier;
      const result = await pending.promise;
      return { ...storedDossier, ...mergeSourceDossiers(...(storedDossier ? [storedDossier] : []), result) };
    },
    whole,
    pendingRows: () => (written || options.persist === false ? [] : pendingResearchRows(projectId, missing.map((chapter) => chapter.index).filter((index) => gathered.has(index)), gathered, leadNotes))
  };
}

/** What `recordDossierSources` will write for the chapters gathered so far, in its order: lead notes, then documents. */
function pendingResearchRows(projectId: string, chapterIndexes: readonly number[], gathered: ReadonlyMap<number, BookDossier>, leadNotes: ReturnType<typeof createLeadResearch> | undefined): ResearchSource[] {
  const leadRows = leadNotes ? chapterIndexes.flatMap((index) => leadNotes.rowsFor(index)) : [];
  const documents = dossierSourceRows(projectId, mergeSourceDossiers(...chapterIndexes.flatMap((index) => gathered.get(index) ?? [])));
  return [...leadRows, ...documents.map((row) => ({ query: row.query, title: row.title, url: row.url ?? undefined, summary: row.summary }))];
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A plan field written once: the stored value stands when it parses, so a
 * retry reuses it rather than re-planning; a value that does not parse is
 * replaced. The same shape as `persistBookArc`, for the episodes, the dossier
 * and the brief's requirement inventory (`composedBriefInventory.ts`).
 */
export async function persistPlanField(planId: string, field: "episodes" | "instructionalSetting" | "dossier" | "requirementInventory" | "exampleCast" | "toolkit" | "authorStance", value: unknown, parses: (stored: unknown) => boolean): Promise<void> {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
      if (!row || !isRecord(row.planningPackage) || parses(row.planningPackage[field])) return;
      const written = await prisma.planVersion.updateMany({
        where: { id: planId, planningPackage: { equals: row.planningPackage as Prisma.InputJsonValue } },
        data: { planningPackage: { ...row.planningPackage, [field]: value } as unknown as Prisma.InputJsonValue }
      });
      if (written.count === 1) return;
    }
    throw new Error(`Plan ${field} changed repeatedly during persistence.`);
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    console.warn(`Plan ${field} were not persisted onto the plan`, { event: `generation.composed_chapters.${field}_not_persisted`, planId, error });
  }
}

/**
 * The dossier's documents as research rows, so the Sources list can cite them; the summary is the document's
 * own first excerpt. `leadRows` are the leads' answers and cited sources (`createLeadResearch`), written in the
 * same statement so a resumed run finds both or neither.
 */
export async function recordDossierSources(projectId: string, dossier: BookDossier, leadRows: readonly ResearchSource[] = []): Promise<void> {
  const rows = [
    ...leadRows.map((row) => ({ projectId, query: row.query, title: row.title, url: row.url ?? null, summary: row.summary, publishedAt: row.publishedAt ? new Date(row.publishedAt) : null })),
    ...dossierSourceRows(projectId, dossier)
  ];
  if (rows.length === 0) return;
  try {
    await prisma.researchSource.createMany({ data: rows });
  } catch (error) {
    if (error instanceof Error && /stop/i.test(error.name)) {
      throw error;
    }
    console.warn("Dossier sources were not recorded", { event: "generation.composed_chapters.dossier_sources_not_recorded", projectId, error });
  }
}

/** A dossier's documents as `primary-source:` rows, each URL once, summarised by its first excerpt. */
function dossierSourceRows(projectId: string, dossier: Pick<BookDossier, "documents" | "excerpts">) {
  const seen = new Set<string>();
  return dossier.documents.flatMap((document) => {
    if (!document.url || seen.has(document.url)) return [];
    seen.add(document.url);
    const excerpt = dossier.excerpts.find((entry) => entry.documentUrl === document.url);
    return [{ projectId, query: `primary-source: ${document.title}`, title: document.title, url: document.url, summary: excerpt ? excerpt.text.slice(0, 400) : document.title }];
  });
}

/** Ten minutes for a whole book's dossier: past it, chapters still waiting get what was found and no more. */
const DOSSIER_TIME_BUDGET_MS = 10 * 60 * 1000;

/**
 * Chapters gathered at once. Six was tried (2026-09-30) and started the first
 * chapter 20–60 s sooner, but Wikisource stopped answering in every round
 * after it, at six and back at three, so its cost to the catalogue hosts was
 * never measured. Three is the value the good dossiers were gathered at.
 */
const DOSSIER_CHAPTER_CONCURRENCY = 3;
/** The `wideSourceGathering` gate (Quick Draft): six at once, 20–60 s sooner to the first chapter. */
const WIDE_DOSSIER_CHAPTER_CONCURRENCY = 6;

/** Append newly retrieved support without replacing plan edits or existing case packets. */
export async function persistDossierSupplement(planId: string, supplement: BookDossier): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    if (!row || !isRecord(row.planningPackage)) return;
    const saved = bookDossierSchema.safeParse(row.planningPackage.dossier);
    const dossier = saved.success ? saved.data : { excerpts: [], documents: [] };
    const merged = mergeSourceDossiers(dossier, supplement);
    const next = { ...dossier, ...merged, researchGaps: dossier.researchGaps?.filter((gap) => !merged.excerpts.some((excerpt) => excerpt.chapterIndex === gap.chapterIndex)) };
    const written = await prisma.planVersion.updateMany({ where: { id: planId, planningPackage: { equals: row.planningPackage as Prisma.InputJsonValue } },
      data: { planningPackage: { ...row.planningPackage, dossier: next } as unknown as Prisma.InputJsonValue } });
    if (written.count) return;
  }
  throw new Error("The source dossier changed repeatedly while adding retrieved passages.");
}

/** The same bounded reader handles repository APIs, public HTML records, and source PDFs. */
export { fetchSourceDocument as primarySourceFetch } from "./sourceDocumentFetch.js";
