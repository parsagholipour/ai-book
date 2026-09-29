import {
  isImportedManuscript,
  jsonRecord,
  manuscriptStyleProfileSchema,
  STUDIO_KINDS,
  STUDIO_LAYOUTS,
  studioSettingsFromMediaSettings,
  type ManuscriptStyleProfile,
  type StudioKind,
  type StudioLayout
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { z } from "zod";
import type { ManuscriptChapterStatus, ManuscriptVersionReason } from "./manuscriptDto.js";

/**
 * The Writing Studio's working copy as rows: the settings document, the chapter
 * rows, the version history, and the few predicates every other module in this
 * directory reads off them — which is why they live once, here.
 *
 * Lock order, for everything that writes: `Project` (publish only) →
 * `Manuscript` → `ManuscriptChapter`. Every writer opens by bumping
 * `Manuscript.revision` — the UPDATE is the manuscript row lock — so a chapter
 * save waits out a publish instead of interleaving with it. The other order
 * deadlocks: publish holds the manuscript and waits on a chapter row a save
 * locked first, while the save waits on the manuscript.
 */

export type ManuscriptDb = Prisma.TransactionClient | typeof prisma;

export type PublishedMeta = {
  title: string;
  subtitle: string | null;
  authorName: string | null;
  dedication: string | null;
  artStyle: string | null;
  layout: StudioLayout;
};

export type ManuscriptSettings = {
  layout: StudioLayout;
  kind: StudioKind;
  artStyle: string | null;
  goalWords: number | null;
  dedication: string | null;
  /**
   * The author's cast: library character ids, in the author's order (≤ 24).
   * Publish writes them into the plan's characters, and the assists read them
   * for names, looks and portraits. Ids only — the library row is the truth,
   * and a character deleted from the library simply drops out.
   */
  castCharacterIds: string[];
  /**
   * What the book said about itself at the last publish (or at derivation, for
   * an import). A title, subtitle, author, dedication, art style or layout
   * change is an unpublished change too — it reaches the PDF only through
   * Update book — and the title fields also decide whether a designed cover is
   * redrawn.
   */
  published: PublishedMeta | null;
};

const publishedMetaSchema = z.object({
  title: z.string(),
  subtitle: z.string().nullable(),
  authorName: z.string().nullable(),
  dedication: z.string().nullable(),
  artStyle: z.string().nullable(),
  layout: z.enum(STUDIO_LAYOUTS)
});

const settingsSchema = z.object({
  layout: z.enum(STUDIO_LAYOUTS).catch("flow"),
  kind: z.enum(STUDIO_KINDS).catch("other"),
  artStyle: z.string().nullable().optional().catch(null),
  goalWords: z.number().int().positive().nullable().optional().catch(null),
  dedication: z.string().nullable().optional().catch(null),
  castCharacterIds: z.array(z.string()).optional().catch([]),
  published: publishedMetaSchema.nullable().optional().catch(null)
});

/** The cast the settings route accepts at most; the worker reads the same bound. */
export const MANUSCRIPT_CAST_LIMIT = 24;

/** The settings document, tolerant of every older or partial shape. */
export function parseManuscriptSettings(raw: unknown): ManuscriptSettings {
  const parsed = settingsSchema.parse(jsonRecord(raw));
  return {
    layout: parsed.layout,
    kind: parsed.kind,
    artStyle: parsed.artStyle?.trim() || null,
    goalWords: parsed.goalWords ?? null,
    dedication: parsed.dedication?.trim() || null,
    castCharacterIds: uniqueIds(parsed.castCharacterIds ?? []).slice(0, MANUSCRIPT_CAST_LIMIT),
    published: parsed.published ?? null
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

export function settingsJson(settings: ManuscriptSettings): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue;
}

/** The book-level fields `PublishedMeta` snapshots, as they are right now. */
export function currentPublishedMeta(
  project: { title: string; subtitle: string | null; authorName: string | null },
  settings: ManuscriptSettings
): PublishedMeta {
  return {
    title: project.title,
    subtitle: project.subtitle ?? null,
    authorName: project.authorName ?? null,
    dedication: settings.dedication,
    artStyle: settings.artStyle,
    layout: settings.layout
  };
}

export function publishedMetaEqual(left: PublishedMeta | null, right: PublishedMeta): boolean {
  return (
    left !== null &&
    left.title === right.title &&
    left.subtitle === right.subtitle &&
    left.authorName === right.authorName &&
    left.dedication === right.dedication &&
    left.artStyle === right.artStyle &&
    left.layout === right.layout
  );
}

/** Whether the words on the cover changed — the only change that redraws a designed one. */
export function coverMetaChanged(left: PublishedMeta | null, right: PublishedMeta): boolean {
  return (
    left === null ||
    left.title !== right.title ||
    left.subtitle !== right.subtitle ||
    left.authorName !== right.authorName
  );
}

const STATUS_TO_WIRE: Record<string, ManuscriptChapterStatus> = {
  IDEA: "idea",
  DRAFTING: "drafting",
  REVISED: "revised",
  FINAL: "final"
};

export function chapterStatusToWire(status: string): ManuscriptChapterStatus {
  return STATUS_TO_WIRE[status] ?? "drafting";
}

export function chapterStatusFromWire(status: ManuscriptChapterStatus): string {
  return status.toUpperCase();
}

export function versionReasonToWire(reason: string): ManuscriptVersionReason {
  const lower = reason.toLowerCase();
  return lower === "before_ai" || lower === "restore" || lower === "publish" || lower === "conflict" ? lower : "auto";
}

/** The fields every predicate below reads, whichever query produced the row. */
export type ChapterFlags = {
  revision: number;
  publishedRevision: number | null;
  wordCount: number;
};

/**
 * Whether a chapter holds text the book does not show yet.
 *
 * A published chapter has them exactly when its revision moved past the one it
 * was published at. A never-published chapter has them unless it is still the
 * pristine empty chapter it was created as — revision 1 and no words — which is
 * the one test that needs no markdown, so the project *list* can ask it too.
 * A chapter that was added, deleted or moved since the last publish is the
 * book-level half of the question ({@link manuscriptHasUnpublishedChanges}).
 */
export function chapterHasUnpublishedChanges(chapter: ChapterFlags): boolean {
  if (chapter.publishedRevision === null) {
    return chapter.revision > 1 || chapter.wordCount > 0;
  }
  return chapter.publishedRevision !== chapter.revision;
}

/**
 * The book-level answer: a chapter with unpublished text, a chapter added,
 * deleted or moved since the last publish (the live order against
 * `publishedOrder`), or a changed book-level setting.
 *
 * `publishedOrder` records every live chapter at the last publish, the empty
 * ones included — an empty chapter prints nothing, but it is still in the order
 * the author left it — so the comparison needs no markdown either.
 */
export function manuscriptHasUnpublishedChanges(input: {
  liveChapters: ReadonlyArray<ChapterFlags & { id: string }>;
  publishedOrder: unknown;
  published: boolean;
  metaChanged: boolean;
}): boolean {
  if (input.liveChapters.some(chapterHasUnpublishedChanges)) {
    return true;
  }
  if (!input.published) {
    return false;
  }
  if (input.metaChanged) {
    return true;
  }
  const order = publishedOrderIds(input.publishedOrder);
  if (order === null) {
    return false;
  }
  return order.length !== input.liveChapters.length || order.some((id, index) => input.liveChapters[index]?.id !== id);
}

export function publishedOrderIds(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.every((entry) => typeof entry === "string") ? (raw as string[]) : null;
}

export type PublishedPageRef = { pageId: string; revision: number };

/** `ManuscriptChapter.publishedPages`, or null when it was never recorded. */
export function publishedPageRefs(raw: unknown): PublishedPageRef[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const refs: PublishedPageRef[] = [];
  for (const entry of raw) {
    const record = jsonRecord(entry);
    if (typeof record.pageId !== "string" || typeof record.revision !== "number") {
      return null;
    }
    refs.push({ pageId: record.pageId, revision: record.revision });
  }
  return refs;
}

export function samePageRefs(left: readonly PublishedPageRef[], right: readonly PublishedPageRef[]): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => ref.pageId === right[index]?.pageId && ref.revision === right[index]?.revision)
  );
}

/** Whether this book opens in the Studio as `source: "written"` or `"imported"`. */
export function manuscriptSource(mediaSettings: unknown): "written" | "imported" | null {
  if (isImportedManuscript(mediaSettings)) {
    return "imported";
  }
  return studioSettingsFromMediaSettings(mediaSettings) ? "written" : null;
}

/**
 * The voice this book has learned: the Studio's own profile (the STYLE_PROFILE
 * pass a publish queues) first, the import's second, each read through the
 * schema so a damaged document is no profile rather than a crash.
 */
export function styleProfileFromMediaSettings(mediaSettings: unknown): ManuscriptStyleProfile | null {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  for (const source of [jsonRecord(mobile.studio).styleProfile, jsonRecord(mobile.import).styleProfile]) {
    const parsed = manuscriptStyleProfileSchema.safeParse(source);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** A published book, from the Studio's side: every import, and a Studio book after its first publish. */
export function manuscriptIsPublished(mediaSettings: unknown, firstPublishedAt: Date | null): boolean {
  return isImportedManuscript(mediaSettings) || firstPublishedAt !== null;
}

/** The raw `mediaSettings.mobile.studio` document — every key, parsed or not. */
export function studioSettingsRecord(mediaSettings: unknown): Record<string, unknown> {
  return jsonRecord(jsonRecord(jsonRecord(mediaSettings).mobile).studio);
}

/**
 * `mediaSettings` with `patch` merged into `mobile.studio` — the raw document,
 * never a schema round-trip, so every other key on it (the app's presets, the
 * import record) survives.
 */
export function mediaSettingsWithStudio(mediaSettings: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const settings = jsonRecord(mediaSettings);
  const mobile = jsonRecord(settings.mobile);
  const studio = { ...jsonRecord(mobile.studio), ...patch };
  for (const [key, value] of Object.entries(studio)) {
    if (value === null || value === undefined) {
      delete studio[key];
    }
  }
  return JSON.parse(JSON.stringify({ ...settings, mobile: { ...mobile, studio } })) as Prisma.InputJsonValue;
}

/** The whole manuscript with every chapter, deleted ones included, by position. */
export async function loadManuscript(db: ManuscriptDb, projectId: string) {
  return db.manuscript.findUnique({
    where: { projectId },
    include: { chapters: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] } }
  });
}

export type LoadedManuscript = NonNullable<Awaited<ReturnType<typeof loadManuscript>>>;
export type ManuscriptChapterRow = LoadedManuscript["chapters"][number];

export function liveChapters<T extends { deletedAt: Date | null }>(chapters: readonly T[]): T[] {
  return chapters.filter((chapter) => chapter.deletedAt === null);
}

/** The manuscript row lock plus the revision bump every write owes. */
export async function claimManuscript(db: ManuscriptDb, manuscriptId: string): Promise<{ revision: number }> {
  return db.manuscript.update({
    where: { id: manuscriptId },
    data: { revision: { increment: 1 } },
    select: { revision: true }
  });
}

/** Autosave checkpoints kept per chapter; publish, AI and restore checkpoints are all kept. */
export const AUTO_VERSIONS_KEPT = 30;
const AUTO_VERSION_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_VERSION_CHANGE_RATIO = 0.2;

type VersionText = { title: string; markdown: string; wordCount: number };

/**
 * Whether an autosave should first keep the text it is about to replace.
 *
 * The version kept is the *previous* text — the state this save destroys — so
 * a paste over a whole chapter is always one tap from undone. It is kept when
 * the chapter has no version yet, when its newest is more than ten minutes
 * old, or when the new text is more than a fifth away from that newest one,
 * measured in words and in characters (either is enough: a rewrite can keep
 * its length).
 */
export function autoVersionDue(options: {
  previous: VersionText;
  next: VersionText;
  last: (VersionText & { createdAt: Date }) | null;
  now: Date;
}): boolean {
  const { previous, next, last, now } = options;
  // A chapter with no text yet has nothing a version could give back.
  if (!previous.markdown.trim()) {
    return false;
  }
  if (last && last.markdown === previous.markdown && last.title === previous.title) {
    return false;
  }
  if (!last || now.getTime() - last.createdAt.getTime() > AUTO_VERSION_INTERVAL_MS) {
    return true;
  }
  const wordDelta = Math.abs(next.wordCount - last.wordCount) / Math.max(last.wordCount, 1);
  const charDelta = Math.abs(next.markdown.length - last.markdown.length) / Math.max(last.markdown.length, 1);
  return wordDelta > AUTO_VERSION_CHANGE_RATIO || charDelta > AUTO_VERSION_CHANGE_RATIO;
}

export async function writeChapterVersion(
  db: ManuscriptDb,
  chapterId: string,
  reason: "AUTO" | "BEFORE_AI" | "RESTORE" | "PUBLISH" | "CONFLICT",
  text: VersionText
): Promise<void> {
  await db.manuscriptVersion.create({
    data: { chapterId, reason, title: text.title, markdown: text.markdown, wordCount: text.wordCount }
  });
  if (reason === "AUTO") {
    const surplus = await db.manuscriptVersion.findMany({
      where: { chapterId, reason: "AUTO" },
      orderBy: { createdAt: "desc" },
      skip: AUTO_VERSIONS_KEPT,
      select: { id: true }
    });
    if (surplus.length > 0) {
      await db.manuscriptVersion.deleteMany({ where: { id: { in: surplus.map((row) => row.id) } } });
    }
  }
}
