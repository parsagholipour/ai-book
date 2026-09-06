import {
  bookDossierSchema,
  bookEpisodesSchema,
  buildChapterDossier,
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
}): Promise<BookMaterial> {
  const { projectId, planId, input, plan, stance, textModel, quality, generationJobId } = options;
  const contract: ComposeContract = quality.enabled("creativeContract") ? "creative" : "grounded";
  let episodes: BookEpisodes | undefined;
  let dossier: BookDossier | undefined;
  if (quality.enabled("materialFirst") || options.evidenceRequired) {
    episodes = planEpisodesFromPlan(plan);
    if (!episodes) {
      await advanceJobStep(generationJobId, "briefs", 14, "Planning the book's episodes", { phase: "episodes" });
      // The chapter focus is the `chapterFocus` gate's: off, the episodes
      // carry no question and the chapter composes from the stance.
      const planned = await planEpisodes({ input, plan, stance, textModel, evidenceRequired: options.evidenceRequired, focus: quality.enabled("chapterFocus") });
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
    if (episodes) {
      dossier = planDossierFromPlan(plan);
      if (!dossier) {
        await advanceJobStep(generationJobId, "briefs", 15, "Gathering primary sources for every chapter", {
          phase: "sources",
          total: plan.chapters.length
        });
        const plannedEpisodes = episodes;
        // The whole book's dossier gets a fixed budget; a slow repository
        // shortens the dossier, never the book's schedule.
        const dossierDeadline = Date.now() + DOSSIER_TIME_BUDGET_MS;
        const chapterDossiers = await mapWithConcurrency(plan.chapters, 3, async (chapter) => {
          await advanceJobStep(generationJobId, "briefs", 15, "Gathering primary sources for every chapter", {
            phase: "sources",
            chapterIndex: chapter.index,
            total: plan.chapters.length
          });
          return buildChapterDossier({
            input,
            chapter,
            episodes: episodesForChapter(plannedEpisodes, chapter.index),
            textModel,
            fetch: primarySourceFetch,
            searchSources: options.searchSources,
            deadline: dossierDeadline,
            evidence: options.evidenceRequired,
            log: (event, detail) => console.warn("Dossier step", { event: `generation.composed_chapters.${event}`, projectId, ...detail })
          });
        });
        dossier = {
          excerpts: chapterDossiers.flatMap((entry) => entry.excerpts),
          documents: chapterDossiers.flatMap((entry) => entry.documents)
        };
        if (options.persist !== false) await persistPlanField(planId, "dossier", dossier, (value) => bookDossierSchema.safeParse(value).success);
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
    const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    if (!row || !isRecord(row.planningPackage) || parses(row.planningPackage[field])) {
      return;
    }
    await prisma.planVersion.update({
      where: { id: planId },
      data: { planningPackage: { ...row.planningPackage, [field]: value } as unknown as Prisma.InputJsonValue }
    });
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

/** Eight minutes for a whole book's dossier: past it, chapters still waiting get what was found and no more. */
const DOSSIER_TIME_BUDGET_MS = 10 * 60 * 1000;

/** The same bounded reader handles repository APIs, public HTML records, and source PDFs. */
export { fetchSourceDocument as primarySourceFetch } from "./sourceDocumentFetch.js";
