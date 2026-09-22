import {
  bookDossierSchema,
  bookEpisodesSchema,
  supportsBookDevelopment,
  chapterEpisodeSchema,
  episodesForChapter,
  mapWithConcurrency,
  planDossierFromPlan,
  planEpisodes,
  planEpisodesFromPlan,
  isRecord,
  type AuthorStance,
  type BookDossier,
  type BookEpisodes,
  type BookPlan,
  type ComposeContract,
  type CreateProjectInput,
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

export async function prepareBookMaterial(options: {
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
  runLog?: Pick<RunLogger, "append"> | undefined;
}): Promise<BookMaterial> {
  const { projectId, planId, input, plan, stance, textModel, quality, generationJobId } = options;
  const sourceResearch = !config.MOCK_AI && supportsBookDevelopment(input, plan);
  const contract: ComposeContract = sourceResearch ? "grounded" : quality.enabled("creativeContract") ? "creative" : "grounded";
  let episodes: BookEpisodes | undefined;
  let dossier: BookDossier | undefined;
  if (quality.enabled("materialFirst") || options.evidenceRequired || sourceResearch) {
    episodes = planEpisodesFromPlan(plan);
    if (!episodes) {
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
        episodes = planned.episodes;
        if (options.persist !== false) await persistPlanField(planId, "episodes", episodes, (value) => bookEpisodesSchema.safeParse(value).success);
      } else {
        console.warn("Episodes not produced; composing without material", {
          event: "generation.composed_chapters.episodes_not_produced",
          projectId,
          reason: planned.failure
        });
      }
    }
    if (sourceResearch) {
      // A missing episode proposal must not silently disable factual retrieval for a chapter.
      episodes = { chapters: plan.chapters.map((chapter) => {
        const stored = episodes?.chapters.find((entry) => entry.index === chapter.index);
        return stored?.episodes.length ? stored : { ...stored, index: chapter.index, episodes: [chapterEpisodeSchema.parse({
          title: chapter.title, kind: "document", why: chapter.summary,
          searchQueries: [chapter.title + " " + chapter.keyBeats.join(" "), `${plan.title} ${chapter.title} original source documentation`]
        })] };
      }) };
    }
    if (episodes) {
      dossier = planDossierFromPlan(plan);
      const missing = plan.chapters.filter((chapter) => !dossier || (sourceResearch &&
        !dossier.excerpts.some((excerpt) => excerpt.chapterIndex === chapter.index && excerpt.provenanceVerified) &&
        !dossier.researchedChapters?.includes(chapter.index)));
      if (missing.length) {
        await advanceJobStep(generationJobId, "briefs", 15, "Gathering primary sources for every chapter", {
          phase: "sources",
          total: plan.chapters.length
        });
        const plannedEpisodes = episodes;
        // The whole book's dossier gets a fixed budget; a slow repository
        // shortens the dossier, never the book's schedule.
        const dossierDeadline = Date.now() + DOSSIER_TIME_BUDGET_MS;
        const chapterDossiers = await mapWithConcurrency(missing, 3, async (chapter) => {
          await advanceJobStep(generationJobId, "briefs", 15, "Gathering primary sources for every chapter", {
            phase: "sources",
            chapterIndex: chapter.index,
            total: plan.chapters.length
          });
          return retrieveChapterSources({
            projectId,
            input,
            chapter,
            episodes: episodesForChapter(plannedEpisodes, chapter.index),
            textModel,
            fetch: primarySourceFetch,
            searchSources: options.searchSources,
            deadline: dossierDeadline,
            evidence: options.evidenceRequired || sourceResearch,
            runLog: options.runLog
          });
        });
        const merged = mergeSourceDossiers(...(dossier ? [dossier] : []), ...chapterDossiers);
        dossier = { ...dossier, ...merged,
          researchedChapters: [...new Set([...(dossier?.researchedChapters ?? []), ...missing.map((chapter) => chapter.index)])],
          researchGaps: plan.chapters.filter((chapter) => !merged.excerpts.some((excerpt) => excerpt.chapterIndex === chapter.index))
            .map((chapter) => ({ chapterIndex: chapter.index, reason: "No supporting source passages after bounded retrieval." }))
        };
        if (options.persist !== false) await persistPlanField(planId, "dossier", dossier, (value) => {
          const saved = bookDossierSchema.safeParse(value);
          return saved.success && missing.every((chapter) => saved.data.researchedChapters?.includes(chapter.index));
        });
        if (options.persist !== false) await recordDossierSources(projectId, dossier);
      }
    }
  }
  return { contract, episodes, dossier };
}

/**
 * A plan field written once: the stored value stands when it parses, so a
 * retry reuses it rather than re-planning; a value that does not parse is
 * replaced. The same shape as `persistBookArc`, for the episodes and the dossier.
 */
async function persistPlanField(planId: string, field: "episodes" | "dossier", value: unknown, parses: (stored: unknown) => boolean): Promise<void> {
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

/** The dossier's documents as research rows, so the Sources list can cite them; the summary is the document's own first excerpt. */
export async function recordDossierSources(projectId: string, dossier: BookDossier): Promise<void> {
  const seen = new Set<string>();
  const rows = dossier.documents.flatMap((document) => {
    if (!document.url || seen.has(document.url)) return [];
    seen.add(document.url);
    const excerpt = dossier.excerpts.find((entry) => entry.documentUrl === document.url);
    return [{ projectId, query: `primary-source: ${document.title}`, title: document.title, url: document.url, summary: excerpt ? excerpt.text.slice(0, 400) : document.title }];
  });
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

/** Ten minutes for a whole book's dossier: past it, chapters still waiting get what was found and no more. */
const DOSSIER_TIME_BUDGET_MS = 10 * 60 * 1000;

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
