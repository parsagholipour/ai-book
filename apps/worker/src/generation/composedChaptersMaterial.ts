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
  type TextModelAdapter
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { updateJobProgress } from "../runtime/jobLifecycle.js";
import type { loadQualityContext } from "./qualitySettings.js";

/**
 * Material-first, the worker's half: the writer's contract and the book's
 * episodes and dossier, planned once per book and stored on the plan like
 * the arc, so a resumed run composes from the same material. Every failure
 * here degrades to composing without material; none fails the book. Split
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
  quality: Awaited<ReturnType<typeof loadQualityContext>>;
  generationJobId?: string | undefined;
}): Promise<BookMaterial> {
  const { projectId, planId, input, plan, stance, textModel, quality, generationJobId } = options;
  const contract: ComposeContract = quality.enabled("creativeContract") ? "creative" : "grounded";
  let episodes: BookEpisodes | undefined;
  let dossier: BookDossier | undefined;
  if (quality.enabled("materialFirst")) {
    episodes = planEpisodesFromPlan(plan);
    if (!episodes) {
      await updateJobProgress(generationJobId, { progress: 14, message: "Planning the book's episodes" });
      const planned = await planEpisodes({ input, plan, stance, textModel });
      if (planned.episodes) {
        episodes = planned.episodes;
        await persistPlanField(planId, "episodes", episodes, (value) => bookEpisodesSchema.safeParse(value).success);
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
        await updateJobProgress(generationJobId, { progress: 15, message: "Gathering primary sources for every chapter" });
        const plannedEpisodes = episodes;
        // The whole book's dossier gets a fixed budget; a slow repository
        // shortens the dossier, never the book's schedule.
        const dossierDeadline = Date.now() + DOSSIER_TIME_BUDGET_MS;
        const chapterDossiers = await mapWithConcurrency(plan.chapters, 3, (chapter) =>
          buildChapterDossier({
            input,
            chapter,
            episodes: episodesForChapter(plannedEpisodes, chapter.index),
            textModel,
            fetch: primarySourceFetch,
            deadline: dossierDeadline,
            log: (event, detail) => console.warn("Dossier step", { event: `generation.composed_chapters.${event}`, projectId, ...detail })
          })
        );
        dossier = {
          excerpts: chapterDossiers.flatMap((entry) => entry.excerpts),
          documents: chapterDossiers.flatMap((entry) => entry.documents)
        };
        await persistPlanField(planId, "dossier", dossier, (value) => bookDossierSchema.safeParse(value).success);
        await recordDossierSources(projectId, dossier);
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
async function recordDossierSources(projectId: string, dossier: BookDossier): Promise<void> {
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

/** The repositories are fetched with a timeout and an identifying agent; a non-200 is an empty text, never a throw the dossier has to catch. */
async function primarySourceFetch(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    // Wikimedia's policy: a user agent that says who is asking and how to reach them.
    headers: { "user-agent": "ai-book-maker/1.0 (https://ravanix.app; primary-source dossier of public-domain text; contact: 12parsaaa@gmail.com)" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    console.warn("Primary source request refused", { event: "generation.composed_chapters.dossier.http_status", status: response.status, url: url.slice(0, 120) });
  }
  return { status: response.status, text: response.ok ? await response.text() : "" };
}

