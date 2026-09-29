import {
  createProjectSchema,
  includeCoverForSource,
  mediaSettingsSchema,
  STUDIO_KIND_CATEGORY,
  type StudioKind,
  type StudioLayout
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { MOBILE_PRODUCT_PRESETS } from "../schemas.js";
import { isPrismaUniqueConflict } from "../support.js";
import { newRowId, requestScopedId } from "./manuscriptBook.js";
import { assertCastBelongsToUser, UnknownCastCharacterError } from "./manuscriptCast.js";
import { ManuscriptWriteRefusal } from "./manuscriptChapters.js";
import type { ManuscriptProject } from "./manuscriptDerivation.js";
import type { ManuscriptSettingsBody } from "./manuscriptSchemas.js";
import {
  claimManuscript,
  manuscriptSource,
  mediaSettingsWithStudio,
  parseManuscriptSettings,
  settingsJson,
  type ManuscriptSettings
} from "./manuscriptStore.js";

/**
 * Creating a Studio book, and the book-level settings the Studio edits.
 */

export const UNTITLED_STUDIO_TITLE = "Untitled book";

/** What the worker is told this book is about; it plans nothing from it. */
export function studioPrompt(title: string): string {
  return `Author-written manuscript: ${title}`;
}

function studioLayoutForKind(kind: StudioKind): StudioLayout {
  return kind === "picture" ? "picture" : "flow";
}

/**
 * A never-published Studio book is a DRAFT project with no plan, and it still
 * has to pass `createProjectSchema`: the worker parses every project through it
 * (`apps/worker/src/generation/projectInput.ts`), a compile included. Hence a
 * real prompt, `targetPages` 1 until the first publish sets the true count, and
 * the flags that keep the pipeline's hands off the author's text — no final
 * review, no generated illustrations, a designed cover (free) rather than none.
 */
export function studioProjectInput(options: { title: string; kind: StudioKind; language: string; createdAt: Date }) {
  const quality = MOBILE_PRODUCT_PRESETS.balanced;
  const layout = studioLayoutForKind(options.kind);
  const mediaSettings = mediaSettingsSchema.parse({
    fullIllustrations: false,
    illustrationCadence: "manual",
    includeCover: includeCoverForSource("design"),
    coverArtSource: "design",
    coverTemplate: "auto",
    finalReview: false,
    toneProfile: "neutral",
    modelTier: quality.modelTier,
    mobile: {
      bookType: "custom",
      bookTypeChoice: "auto",
      lengthPreset: "custom",
      qualityPreset: "balanced",
      imagesEnabled: false,
      coverEnabled: false,
      illustrationsEnabled: false,
      pageCountMode: "custom",
      targetPages: 1,
      pageCountSource: "settings",
      studio: { layout, kind: options.kind, createdAt: options.createdAt.toISOString() }
    }
  });
  return createProjectSchema.parse({
    title: options.title,
    prompt: studioPrompt(options.title),
    category: STUDIO_KIND_CATEGORY[options.kind],
    targetPages: 1,
    complexity: quality.complexity,
    temperature: quality.temperature,
    language: options.language,
    mediaSettings
  });
}

/**
 * The project, its working copy and its first empty chapter, in one commit.
 *
 * Idempotent by `requestId` with no column to hold it: the project id is minted
 * from the account and the requestId, so a retry finds the book the first
 * attempt made, and two racing attempts meet the primary key rather than
 * making two books.
 */
export async function createStudioProject(
  userId: string,
  body: { title?: string | undefined; kind: StudioKind; language?: string | undefined; requestId: string }
): Promise<{ projectId: string; created: boolean }> {
  const projectId = requestScopedId("studio_", userId, body.requestId);
  const existing = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  if (existing) {
    return { projectId, created: false };
  }
  const title = body.title?.trim() || UNTITLED_STUDIO_TITLE;
  const now = new Date();
  const input = studioProjectInput({ title, kind: body.kind, language: body.language ?? "en", createdAt: now });
  const layout = studioLayoutForKind(body.kind);
  const settings: ManuscriptSettings = {
    layout,
    kind: body.kind,
    artStyle: null,
    goalWords: null,
    dedication: null,
    castCharacterIds: [],
    published: null
  };
  const manuscriptId = newRowId("ms");
  try {
    await prisma.$transaction(async (tx) => {
      await tx.project.create({
        data: {
          id: projectId,
          userId,
          title,
          prompt: input.prompt,
          category: input.category,
          targetPages: input.targetPages,
          complexity: input.complexity,
          temperature: input.temperature,
          language: input.language,
          mediaSettings: JSON.parse(JSON.stringify(input.mediaSettings)) as Prisma.InputJsonValue,
          status: "DRAFT"
        }
      });
      await tx.manuscript.create({ data: { id: manuscriptId, projectId, settings: settingsJson(settings) } });
      await tx.manuscriptChapter.create({
        data: {
          id: newRowId("mc"),
          manuscriptId,
          position: 1,
          title: layout === "picture" ? "Your story" : "Chapter 1",
          markdown: "",
          wordCount: 0
        }
      });
    });
  } catch (error) {
    if (isPrismaUniqueConflict(error)) {
      return { projectId, created: false };
    }
    throw error;
  }
  return { projectId, created: true };
}

function uniqueCastIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/**
 * Book-level settings. Title, subtitle and author are the `Project` columns
 * every surface already reads, so they are written through at once — the
 * library card renames immediately — and reach the PDF and the cover at the
 * next Update book, which is why the published snapshot tracks them.
 */
export async function updateManuscriptSettings(
  project: ManuscriptProject,
  manuscriptId: string,
  body: ManuscriptSettingsBody
): Promise<void> {
  const source = manuscriptSource(project.mediaSettings);
  if (body.castCharacterIds !== undefined) {
    // Outside the transaction: a library read holds no manuscript lock, and a
    // character deleted between here and the write only drops out of the cast
    // at every later read (`loadCastCharacters`) rather than breaking anything.
    try {
      await assertCastBelongsToUser(project.userId, uniqueCastIds(body.castCharacterIds));
    } catch (error) {
      if (error instanceof UnknownCastCharacterError) {
        throw new ManuscriptWriteRefusal(400, "UNKNOWN_CHARACTER", "Choose characters from your own library.");
      }
      throw error;
    }
  }
  await prisma.$transaction(async (tx) => {
    await claimManuscript(tx, manuscriptId);
    const manuscript = await tx.manuscript.findUnique({ where: { id: manuscriptId }, select: { settings: true } });
    const settings = parseManuscriptSettings(manuscript?.settings);
    if (body.layout && body.layout !== settings.layout && source !== "written") {
      throw new ManuscriptWriteRefusal(400, "LAYOUT_FIXED", "An imported book keeps the page layout it was imported with.");
    }
    const next: ManuscriptSettings = {
      ...settings,
      ...(body.castCharacterIds !== undefined ? { castCharacterIds: uniqueCastIds(body.castCharacterIds) } : {}),
      ...(body.dedication !== undefined ? { dedication: body.dedication || null } : {}),
      ...(body.artStyle !== undefined ? { artStyle: body.artStyle || null } : {}),
      ...(body.goalWords !== undefined ? { goalWords: body.goalWords } : {}),
      ...(body.layout ? { layout: body.layout } : {})
    };
    await tx.manuscript.update({ where: { id: manuscriptId }, data: { settings: settingsJson(next) } });
    // The Studio record on the project is what the compile reads (through the
    // plan snapshot publish writes), so the settings that change the printed
    // book ride it too. `Project` has no dedication column; this is its home.
    const studioPatch =
      source === "written" &&
      (next.artStyle !== settings.artStyle || next.layout !== settings.layout || next.dedication !== settings.dedication)
        ? { artStyle: next.artStyle, layout: next.layout, dedication: next.dedication }
        : null;
    // Merged onto the document as it is inside this transaction, not the copy
    // the route read: a presentation edit may have written another key of it.
    const liveMediaSettings = studioPatch
      ? (await tx.project.findUnique({ where: { id: project.id }, select: { mediaSettings: true } }))?.mediaSettings
      : undefined;
    const projectData = {
      ...(body.title ? { title: body.title, ...(source === "written" ? { prompt: studioPrompt(body.title) } : {}) } : {}),
      ...(body.subtitle !== undefined ? { subtitle: body.subtitle || null } : {}),
      ...(body.authorName !== undefined ? { authorName: body.authorName || null } : {}),
      ...(studioPatch ? { mediaSettings: mediaSettingsWithStudio(liveMediaSettings ?? project.mediaSettings, studioPatch) } : {})
    };
    if (Object.keys(projectData).length > 0) {
      await tx.project.update({ where: { id: project.id }, data: projectData });
    }
  });
}
