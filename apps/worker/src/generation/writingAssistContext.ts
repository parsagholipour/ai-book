import {
  jsonRecord,
  libraryCharacterRelativeFile,
  libraryCharactersFromMediaSettings,
  manuscriptStyleProfileSchema,
  STUDIO_KINDS,
  STUDIO_LAYOUTS,
  studioSettingsFromMediaSettings,
  type AuthorAssistBook,
  type LibraryCharacterField,
  type LibraryCharacterSnapshot,
  type ManuscriptStyleProfile,
  type StudioKind,
  type StudioLayout
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { generationDescription, libraryMentionInclude } from "@book-maker/db/libraryMentions";

/**
 * What a Writing Studio assist knows about the book it is helping with: the
 * working copy (`Manuscript` + live `ManuscriptChapter` rows), the settings
 * the author chose, the cast they named, and the voice the book has learned.
 *
 * The working copy, never the published `Page` rows: an assist answers the
 * text the author is editing, which is ahead of the book whenever there are
 * unpublished changes.
 */

/** The cast is bounded where the settings route bounds it (spec: ≤ 24). */
const MAX_CAST = 24;

export type AssistManuscriptSettings = {
  layout: StudioLayout;
  kind: StudioKind;
  artStyle: string | null;
  castCharacterIds: string[];
};

export type AssistChapter = {
  id: string;
  position: number;
  title: string;
  markdown: string;
  notes: string;
};

export type WritingAssistManuscript = {
  id: string;
  settings: AssistManuscriptSettings;
  /** Live chapters (not soft-deleted), by position. */
  chapters: AssistChapter[];
};

/**
 * The settings document, tolerant of every older or partial shape, falling
 * back to the Studio provenance and then to neutral defaults. An imported
 * book's working copy may carry no kind at all; it reads as "other".
 */
export function assistManuscriptSettings(raw: unknown, mediaSettings: unknown): AssistManuscriptSettings {
  const record = jsonRecord(raw);
  const studio = studioSettingsFromMediaSettings(mediaSettings);
  const kind = (STUDIO_KINDS as readonly string[]).includes(String(record.kind))
    ? (record.kind as StudioKind)
    : (studio?.kind ?? "other");
  const layout = (STUDIO_LAYOUTS as readonly string[]).includes(String(record.layout))
    ? (record.layout as StudioLayout)
    : (studio?.layout ?? (kind === "picture" ? "picture" : "flow"));
  const artStyle =
    (typeof record.artStyle === "string" && record.artStyle.trim()) || studio?.artStyle?.trim() || null;
  return { layout, kind, artStyle, castCharacterIds: castCharacterIdsFromSettings(record) };
}

/** `settings.castCharacterIds`: unique, non-empty ids in the author's order. */
export function castCharacterIdsFromSettings(settings: Record<string, unknown>): string[] {
  const raw = settings.castCharacterIds;
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
    if (ids.length >= MAX_CAST) {
      break;
    }
  }
  return ids;
}

export async function loadWritingAssistManuscript(
  projectId: string,
  mediaSettings: unknown
): Promise<WritingAssistManuscript | null> {
  const manuscript = await prisma.manuscript.findUnique({
    where: { projectId },
    select: {
      id: true,
      settings: true,
      chapters: {
        where: { deletedAt: null },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true, position: true, title: true, markdown: true, notes: true }
      }
    }
  });
  if (!manuscript) {
    return null;
  }
  return {
    id: manuscript.id,
    settings: assistManuscriptSettings(manuscript.settings, mediaSettings),
    chapters: manuscript.chapters
  };
}

/**
 * The cast the author named in the Studio, as portrait-seedable snapshots in
 * the author's order. Only the book owner's own characters: the ids are
 * settings JSON a client wrote, so a foreign id resolves to nothing. The
 * snapshot is built exactly as the creation build builds one — the portrait
 * only when it is READY, its provenance carried — so the ownership trio in
 * `resolveLibraryPortraitSeed` reads it the same way.
 */
export async function loadCastCharacters(
  userId: string | null,
  ids: readonly string[]
): Promise<LibraryCharacterSnapshot[]> {
  if (!userId || ids.length === 0) {
    return [];
  }
  const rows = await prisma.libraryCharacter.findMany({
    where: { id: { in: [...ids] }, userId },
    include: libraryMentionInclude
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) {
      return [];
    }
    const appearance = row.appearance?.trim();
    return [
      {
        id: row.id,
        name: row.name,
        description: generationDescription(row),
        ...(appearance ? { appearance } : {}),
        fields: characterFields(row.fields),
        ...(row.portraitStatus === "READY" && row.portraitPath
          ? {
              portraitFile: libraryCharacterRelativeFile(userId, row.portraitPath),
              portraitSource: row.portraitSource === "ADOPTED_UPLOAD" ? ("adopted_upload" as const) : ("generated" as const)
            }
          : {})
      }
    ];
  });
}

function characterFields(value: unknown): LibraryCharacterField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = jsonRecord(entry);
    return typeof record.key === "string" && typeof record.value === "string"
      ? [{ key: record.key, value: record.value }]
      : [];
  });
}

/**
 * The voice this book has learned: the Studio's profile (written by the
 * STYLE_PROFILE pass) first, the import's second. Either one is read through
 * the profile schema, so a hand-damaged document is no profile rather than a
 * crash.
 */
export function authorStyleProfile(mediaSettings: unknown): ManuscriptStyleProfile | null {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  for (const source of [mobile.studio, mobile.import]) {
    const parsed = manuscriptStyleProfileSchema.safeParse(jsonRecord(source).styleProfile);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

/**
 * The book as the core runners see it. The characters are the cast plus any
 * saved character the book was built with, each once, described by who they
 * are and — when one is recorded — how they look.
 */
export function authorAssistBook(options: {
  project: { title: string; language: string; mediaSettings: unknown };
  settings: AssistManuscriptSettings;
  cast: readonly LibraryCharacterSnapshot[];
}): AuthorAssistBook {
  const seen = new Set<string>();
  const characters = [...options.cast, ...libraryCharactersFromMediaSettings(options.project.mediaSettings)].flatMap(
    (character) => {
      const key = character.name.trim().toLowerCase();
      if (!key || seen.has(key)) {
        return [];
      }
      seen.add(key);
      const description = [character.description.trim(), character.appearance?.trim() ?? ""].filter(Boolean).join(" ");
      return [{ name: character.name, description }];
    }
  );
  return {
    title: options.project.title,
    kind: options.settings.kind,
    language: options.project.language,
    styleProfile: authorStyleProfile(options.project.mediaSettings),
    ...(characters.length > 0 ? { characters } : {}),
    layout: options.settings.layout
  };
}

/**
 * The last `maxChars` of a chapter, cut at a paragraph (or, failing that, a
 * sentence) boundary so the draft is shown a clean ending rather than half a
 * word.
 */
export function chapterEnding(markdown: string, maxChars = 1500): string {
  const text = markdown.trim();
  if (text.length <= maxChars) {
    return text;
  }
  const tail = text.slice(text.length - maxChars);
  const paragraph = tail.indexOf("\n\n");
  if (paragraph >= 0 && paragraph < maxChars / 2) {
    return tail.slice(paragraph).trim();
  }
  const sentence = tail.search(/[.!?…。؟]\s/u);
  return (sentence >= 0 && sentence < maxChars / 2 ? tail.slice(sentence + 1) : tail).trim();
}

/** Every chapter before `chapterId` in the working copy's order, nearest last. */
export function previousChapter(
  chapters: readonly AssistChapter[],
  chapterId: string
): AssistChapter | null {
  const index = chapters.findIndex((chapter) => chapter.id === chapterId);
  return index > 0 ? (chapters[index - 1] ?? null) : null;
}
