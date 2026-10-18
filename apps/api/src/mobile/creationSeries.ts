import {
  bookPlanSchema,
  bookSeriesFromMediaSettings,
  buildBookSeriesSnapshot,
  coverArtSourceFor,
  isAuthorManuscript,
  isSeriesChoiceMode,
  jsonRecord,
  seriesPromptLine,
  storyPageDesignFor,
  type BookSeriesMode,
  type BookSeriesSnapshot,
  type MediaSettings,
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

import { linearizeCreationMessages } from "../creationChatTree.js";
import type { MobileCreationMessage, MobileCreationPresetsInput } from "../mobileCreationSchemas.js";
import type { MobileCreationSeriesBookDto, MobileCreationSeriesDto } from "./creationSeriesDto.js";
import type { MobileCreateProjectInput, MobileMediaMetadata } from "./recordTypes.js";
import { remixPresetsForProject } from "./shares/shareRemix.js";
import { jsonValue } from "./support.js";

/**
 * A creation chat's link to one of the reader's finished books — the
 * continuation of it, or a new story inspired by it — and the copy Build makes
 * of what the new book needs from it (core `bookSeries.ts`).
 *
 * The offer is derived, never stored: it is the reader's finished books that
 * already carry a library character this chat's active thread @-mentions,
 * found from the copy every book keeps of the characters it was built with
 * (`mediaSettings.mobile.characters[].id`, the library row's id). Only the
 * answer is stored, on the draft (`seriesMode`, `seriesSourceProjectId`), so a
 * branch switch, a reload or an edited-away mention changes the offer and
 * never the answer the reader already gave.
 */

/**
 * The statuses of a book that is finished enough to be continued. EDITING is
 * one: only a finished book is edited, and a chat edit or recompile of the
 * earlier book must not silently unlink a sequel being built while it runs.
 */
const SERIES_SOURCE_STATUSES = ["COMPLETE", "REVIEW_REQUIRED", "EDITING"] as const;

/** How many books one offer lists, newest first. */
export const SERIES_OFFER_BOOK_LIMIT = 5;

export type SeriesDraft = {
  createdProjectId: string | null;
  seriesMode?: string | null;
  seriesSourceProjectId?: string | null;
};

/**
 * The series state the session DTO carries, or null when there is nothing to
 * show: no answer and no book to offer, or a chat that has already built its
 * book, after which the link is the book's and no longer the chat's.
 */
export async function creationSeriesState(
  userId: string,
  draft: SeriesDraft,
  tree: readonly MobileCreationMessage[]
): Promise<MobileCreationSeriesDto | null> {
  if (draft.createdProjectId) return null;
  const stored = await storedChoice(userId, draft);
  const characterIds = activeThreadCharacterIds(tree);
  const found = characterIds.length > 0 ? await seriesBooksForCharacters(userId, characterIds) : [];
  // The linked book is always on offer, mentioned or not: a "Write the next
  // book" chat names no character, and a branch switch can take the mention
  // away, and either way the reader must still be able to change the answer.
  const linked = stored?.book;
  const books = linked && !found.some((book) => book.projectId === linked.projectId) ? [linked, ...found] : found;
  const choice = stored?.choice ?? null;
  if (!choice && books.length === 0) return null;
  return { books, choice };
}

/** The library characters the active thread's own messages tapped, in first-mention order. */
export function activeThreadCharacterIds(tree: readonly MobileCreationMessage[]): string[] {
  const ids: string[] = [];
  for (const message of linearizeCreationMessages([...tree]).active) {
    if (message.role !== "user") continue;
    for (const ref of message.characters ?? []) {
      if (!ids.includes(ref.id)) ids.push(ref.id);
    }
  }
  return ids;
}

async function storedChoice(
  userId: string,
  draft: SeriesDraft
): Promise<{ choice: NonNullable<MobileCreationSeriesDto["choice"]>; book?: MobileCreationSeriesBookDto } | null> {
  if (!isSeriesChoiceMode(draft.seriesMode)) return null;
  if (draft.seriesMode === "standalone" || !draft.seriesSourceProjectId) {
    return { choice: { mode: "standalone", projectId: null, title: null } };
  }
  const source = await prisma.project.findFirst({
    where: { id: draft.seriesSourceProjectId, userId },
    select: { id: true, title: true, updatedAt: true }
  });
  // A linked book deleted since is an answer Build will skip; the chat says so
  // by offering again rather than naming a book that is gone.
  if (!source) return null;
  return {
    choice: { mode: draft.seriesMode, projectId: source.id, title: source.title },
    book: { projectId: source.id, title: source.title, characterNames: [], updatedAt: new Date(source.updatedAt).toISOString() }
  };
}

type SeriesBookRow = {
  id: string;
  title: string;
  updatedAt: Date;
  characters: unknown;
  importRecord: unknown;
  studioRecord: unknown;
};

/**
 * The reader's finished, generated books whose character copy names any of
 * `characterIds`. One indexed read on the owner, with the JSON test in SQL so
 * no book's whole `mediaSettings` (which carries its creation transcript) is
 * shipped to find out. An author's own book is left out: its plan is a
 * synthesis of text a model never wrote, and a sequel is planned from the plan.
 */
async function seriesBooksForCharacters(userId: string, characterIds: string[]): Promise<MobileCreationSeriesBookDto[]> {
  const rows = await prisma.$queryRaw<SeriesBookRow[]>`
    SELECT p."id", p."title", p."updatedAt",
      p."mediaSettings"->'mobile'->'characters' AS "characters",
      p."mediaSettings"->'mobile'->'import' AS "importRecord",
      p."mediaSettings"->'mobile'->'studio' AS "studioRecord"
    FROM "Project" p
    WHERE p."userId" = ${userId}
      AND p."status"::text = ANY(${[...SERIES_SOURCE_STATUSES]}::text[])
      -- An author's own book, ahead of the LIMIT so a run of imports cannot
      -- crowd the generated books out; the exact test is applied below.
      AND (COALESCE(jsonb_typeof(p."mediaSettings"->'mobile'->'import'), '') <> 'object'
        OR p."mediaSettings"->'mobile'->'import' = '{}'::jsonb)
      AND COALESCE(jsonb_typeof(p."mediaSettings"->'mobile'->'studio'), '') <> 'object'
      AND jsonb_typeof(p."mediaSettings"->'mobile'->'characters') = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p."mediaSettings"->'mobile'->'characters') AS c
        WHERE c->>'id' = ANY(${characterIds}::text[])
      )
    ORDER BY p."updatedAt" DESC
    LIMIT ${SERIES_OFFER_BOOK_LIMIT * 2}`;
  return (rows ?? [])
    .filter((row) => !isAuthorManuscript({ mobile: { import: row.importRecord, studio: row.studioRecord } }))
    .slice(0, SERIES_OFFER_BOOK_LIMIT)
    .map((row) => ({
      projectId: row.id,
      title: row.title,
      characterNames: namesFor(row.characters, characterIds),
      updatedAt: new Date(row.updatedAt).toISOString()
    }));
}

function namesFor(characters: unknown, characterIds: readonly string[]): string[] {
  if (!Array.isArray(characters)) return [];
  const names: string[] = [];
  for (const entry of characters) {
    const record = jsonRecord(entry);
    if (typeof record.id === "string" && characterIds.includes(record.id) && typeof record.name === "string" && !names.includes(record.name)) {
      names.push(record.name);
    }
  }
  return names;
}

/**
 * A book the reader may link a new one to: theirs, finished, and generated.
 * The one check both the choice and the "write the next book" start make, so
 * neither can link to a book the other would refuse.
 */
export async function seriesSourceBook(userId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId, status: { in: [...SERIES_SOURCE_STATUSES] } },
    select: { id: true, title: true, category: true, subcategory: true, targetPages: true, mediaSettings: true }
  });
  return project && !isAuthorManuscript(project.mediaSettings) ? project : null;
}

/**
 * The earlier book's format, offered to the new chat so a series reads as one —
 * the remix's rule, on the reader's own book. The app applies it only to the
 * settings the reader has not chosen; it never rides a turn's presets.
 */
export function seriesPresetsFor(source: NonNullable<Awaited<ReturnType<typeof seriesSourceBook>>>): MobileCreationPresetsInput {
  return remixPresetsForProject(source);
}

export const SERIES_BOOK_UNAVAILABLE_MESSAGE = "That book can't be continued. Choose one of your finished books.";
export const SERIES_LOCKED_MESSAGE = "This chat has already built its book, so its series link can't change.";

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * The draft's answer as Build's request fingerprint names it: the link the
 * reader chose, which cannot change once the chat has built, and nothing for
 * a draft that links no book, so its fingerprint is the one it always had.
 */
export function seriesLinkFingerprint(draft: SeriesDraft): { series?: { mode: string; sourceProjectId: string } } {
  const mode = draft.seriesMode;
  if ((mode !== "continuation" && mode !== "inspired") || !draft.seriesSourceProjectId) return {};
  return { series: { mode, sourceProjectId: draft.seriesSourceProjectId } };
}

/**
 * The copy Build makes of the earlier book, or undefined when the draft links
 * none or the book can no longer be read — deleted, no longer finished, or a
 * plan that does not parse. Undefined builds the book unlinked: a series link
 * is an enhancement to a book the reader is paying for, never a reason to
 * refuse to build it.
 */
export async function seriesSnapshotForDraft(userId: string, draft: SeriesDraft): Promise<BookSeriesSnapshot | undefined> {
  const mode = draft.seriesMode;
  if ((mode !== "continuation" && mode !== "inspired") || !draft.seriesSourceProjectId) return undefined;
  // The answer was given for the chat's first book. A later build from the
  // same chat (a fork, another output) is a book the reader was never asked
  // about and can no longer see the link for, so it is built unlinked.
  if (draft.createdProjectId) return undefined;
  try {
    return await loadSeriesSnapshot(userId, draft.seriesSourceProjectId, mode);
  } catch (error) {
    console.warn(`[series] snapshot failed for draft source ${draft.seriesSourceProjectId}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function loadSeriesSnapshot(userId: string, projectId: string, mode: BookSeriesMode): Promise<BookSeriesSnapshot | undefined> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId, status: { in: [...SERIES_SOURCE_STATUSES] } },
    select: {
      id: true,
      title: true,
      category: true,
      prompt: true,
      mediaSettings: true,
      currentPlan: { select: { planningPackage: true } },
      chapters: { orderBy: { index: "asc" }, select: { id: true, title: true, summary: true, productionBrief: true } },
      pages: { orderBy: { index: "asc" }, select: { markdown: true, chapterId: true } },
      images: { where: { type: "COVER" }, orderBy: { createdAt: "desc" }, take: 1, select: { metadata: true } }
    }
  });
  if (!project || isAuthorManuscript(project.mediaSettings)) return undefined;
  const plan = bookPlanSchema.safeParse(project.currentPlan?.planningPackage);
  if (!plan.success) return undefined;
  const settings = jsonRecord(project.mediaSettings);
  const coverSource = coverArtSourceFor({
    includeCover: settings.includeCover !== false,
    ...(typeof settings.coverArtSource === "string" ? { coverArtSource: settings.coverArtSource as MediaSettings["coverArtSource"] } : {})
  });
  const cover = jsonRecord(project.images[0]?.metadata);
  const lastChapterId = project.chapters.at(-1)?.id;
  return buildBookSeriesSnapshot({
    projectId: project.id,
    title: project.title,
    mode,
    sourceSeries: bookSeriesFromMediaSettings(project.mediaSettings),
    plan: plan.data,
    drewPictures: coverSource === "ai" || settings.fullIllustrations === true,
    chapters: project.chapters.map((chapter) => ({
      title: chapter.title,
      summary: chapter.summary,
      facts: jsonRecord(jsonRecord(chapter.productionBrief).report).facts
    })),
    pages: project.pages.map((page) => page.markdown),
    ...(lastChapterId && project.chapters.length > 1
      ? { finalChapterPages: project.pages.filter((page) => page.chapterId === lastChapterId).map((page) => page.markdown) }
      : {}),
    storyPageDesign: storyPageDesignFor({ mediaSettings: project.mediaSettings, category: project.category, prompt: project.prompt, plan: plan.data }),
    ...(cover.coverArtSource === "design" && typeof cover.coverDesignId === "string" ? { coverDesignId: cover.coverDesignId } : {})
  });
}

/**
 * The new book's input with its series copy: the record itself under
 * `mobile.series`, the earlier book's page design pinned on the row (the
 * compile reads it there), and the one prompt line every writer reads.
 */
export function withBookSeries(input: MobileCreateProjectInput, series: BookSeriesSnapshot | undefined): MobileCreateProjectInput {
  if (!series) return input;
  const mobile: MobileMediaMetadata = input.mediaSettings.mobile;
  return {
    ...input,
    prompt: `${input.prompt}\n\n${seriesPromptLine(series)}`,
    mediaSettings: {
      ...input.mediaSettings,
      ...(series.storyPageDesign ? { storyPageDesign: series.storyPageDesign } : {}),
      mobile: { ...mobile, series: jsonValue(series) }
    }
  };
}
