import {
  bookPlanSchema,
  includeCoverForSource,
  jsonRecord,
  libraryCharactersFromMediaSettings,
  type StudioKind,
  type StudioLayout
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { hasOpenProjectWork } from "../editOperations.js";
import { isPrismaUniqueConflict, jsonInputValue } from "../support.js";
import { newRowId } from "./manuscriptBook.js";
import type { ManuscriptProject } from "./manuscriptDerivation.js";
import { studioPrompt } from "./manuscriptProjects.js";
import { MANUSCRIPT_CAST_LIMIT, settingsJson, studioSettingsRecord, type ManuscriptSettings } from "./manuscriptStore.js";

/**
 * "I'll write it myself" (spec, Phase 3): a planned-but-unapproved generated
 * book becomes a Studio book whose chapters are the plan's, each carrying the
 * plan's summary and beats as its private notes and no text yet.
 *
 * Free — the plan was already paid for, and nothing is generated. The plan is
 * *superseded* and unlinked in the same commit, which is what keeps the plan
 * routes from approving it afterwards (they already refuse an author book, and
 * with no current plan there is nothing to name). Idempotent by `requestId`:
 * the Studio record remembers the request that made it, so a retry answers the
 * book the first attempt made.
 */

export class PlanConversionRefusal extends Error {
  readonly status = 409;
  readonly code = "PLAN_NOT_CONVERTIBLE";

  constructor() {
    super("This plan can’t become a book you write yourself any more.");
  }
}

/** A picture book is authored page by page only while it is short enough to be one. */
const PICTURE_LAYOUT_MAX_PAGES = 40;

export function studioShapeForPlan(project: { category: string; targetPages: number }): { kind: StudioKind; layout: StudioLayout } {
  const kind: StudioKind = project.category === "KIDS" ? "picture" : project.category === "STORY" ? "story" : "nonfiction";
  const layout: StudioLayout = project.category === "KIDS" && project.targetPages <= PICTURE_LAYOUT_MAX_PAGES ? "picture" : "flow";
  return { kind, layout };
}

/** A plan chapter's notes: its summary, then its beats as bullet lines. */
export function chapterNotesFromPlan(chapter: { summary: string; keyBeats: readonly string[] }): string {
  const beats = chapter.keyBeats.map((beat) => beat.trim()).filter(Boolean).map((beat) => `- ${beat}`);
  return [chapter.summary.trim(), beats.join("\n")].filter(Boolean).join("\n\n");
}

function convertedByRequest(mediaSettings: unknown, requestId: string): boolean {
  return studioSettingsRecord(mediaSettings).fromPlanRequestId === requestId;
}

/**
 * Converts the book, or answers `"replayed"` for a request that already did.
 * Throws `PlanConversionRefusal` for every other book.
 */
export async function convertPlanToManuscript(options: {
  project: ManuscriptProject;
  requestId: string;
}): Promise<"converted" | "replayed"> {
  const { project, requestId } = options;
  if (convertedByRequest(project.mediaSettings, requestId)) {
    return "replayed";
  }
  if (await hasOpenProjectWork(project.id)) {
    throw new PlanConversionRefusal();
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${project.id} FOR UPDATE`;
      const live = await tx.project.findUnique({
        where: { id: project.id },
        select: { status: true, currentPlanId: true, mediaSettings: true, category: true, targetPages: true, title: true }
      });
      if (live && convertedByRequest(live.mediaSettings, requestId)) {
        return "replayed" as const;
      }
      const mobile = jsonRecord(jsonRecord(live?.mediaSettings).mobile);
      if (!live?.currentPlanId || mobile.studio !== undefined || mobile.import !== undefined) {
        throw new PlanConversionRefusal();
      }
      const plan = await tx.planVersion.findUnique({
        where: { id: live.currentPlanId },
        select: { id: true, status: true, planningPackage: true }
      });
      const statusAllows = live.status === "PLAN_READY" || live.status === "DRAFT";
      const [pages, openOperations] = await Promise.all([
        tx.page.count({ where: { projectId: project.id } }),
        tx.bookEditOperation.count({ where: { projectId: project.id, status: { in: ["QUEUED", "ACTIVE"] } } })
      ]);
      if (!plan || plan.status !== "DRAFT" || !statusAllows || pages > 0 || openOperations > 0) {
        throw new PlanConversionRefusal();
      }
      const parsed = bookPlanSchema.safeParse(plan.planningPackage);
      const planChapters = parsed.success && parsed.data.chapters.length > 0
        ? parsed.data.chapters
        : [{ title: "Chapter 1", summary: "", keyBeats: [] as string[] }];
      const { kind, layout } = studioShapeForPlan(live);
      const now = new Date();
      const settings = jsonRecord(live.mediaSettings);
      const nextMediaSettings = {
        ...settings,
        fullIllustrations: false,
        illustrationCadence: "manual",
        coverArtSource: "design",
        includeCover: includeCoverForSource("design"),
        mobile: {
          ...mobile,
          imagesEnabled: false,
          coverEnabled: false,
          illustrationsEnabled: false,
          targetPages: 1,
          studio: {
            layout,
            kind,
            createdAt: now.toISOString(),
            fromPlanId: plan.id,
            fromPlanRequestId: requestId
          }
        }
      };
      await tx.planVersion.update({ where: { id: plan.id }, data: { status: "SUPERSEDED" } });
      await tx.project.update({
        where: { id: project.id },
        data: {
          status: "DRAFT",
          currentPlanId: null,
          targetPages: 1,
          prompt: studioPrompt(live.title),
          mediaSettings: jsonInputValue(nextMediaSettings)
        }
      });
      // The saved characters the book was planned with are its cast from the start.
      const castCharacterIds = libraryCharactersFromMediaSettings(live.mediaSettings)
        .map((character) => character.id)
        .filter((id, index, ids) => Boolean(id) && ids.indexOf(id) === index)
        .slice(0, MANUSCRIPT_CAST_LIMIT);
      const manuscriptSettings: ManuscriptSettings = {
        layout,
        kind,
        artStyle: null,
        goalWords: null,
        dedication: null,
        castCharacterIds,
        published: null
      };
      const manuscriptId = newRowId("ms");
      await tx.manuscript.create({ data: { id: manuscriptId, projectId: project.id, settings: settingsJson(manuscriptSettings) } });
      await tx.manuscriptChapter.createMany({
        data: planChapters.map((chapter, index) => ({
          id: newRowId("mc"),
          manuscriptId,
          position: index + 1,
          title: chapter.title.trim() || `Chapter ${index + 1}`,
          markdown: "",
          notes: chapterNotesFromPlan(chapter),
          status: "IDEA",
          wordCount: 0
        }))
      });
      return "converted" as const;
    });
  } catch (error) {
    // A working copy already exists: this was never a plan-only book.
    if (isPrismaUniqueConflict(error)) {
      throw new PlanConversionRefusal();
    }
    throw error;
  }
}
