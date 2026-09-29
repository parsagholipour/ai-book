import { manuscriptExcerpt } from "@book-maker/core";
import type {
  ManuscriptChapterDto,
  ManuscriptChapterSummaryDto,
  ManuscriptCoverDto,
  ManuscriptDto,
  ManuscriptPublishBlockedReason,
  ManuscriptSummaryDto,
  ManuscriptVersionDto,
  ManuscriptVersionSummaryDto
} from "./manuscriptDto.js";
import {
  chapterHasUnpublishedChanges,
  chapterStatusToWire,
  currentPublishedMeta,
  liveChapters,
  manuscriptHasUnpublishedChanges,
  manuscriptIsPublished,
  manuscriptSource,
  parseManuscriptSettings,
  publishedMetaEqual,
  versionReasonToWire,
  type ManuscriptSettings
} from "./manuscriptStore.js";

/**
 * Rows → the Studio's wire DTOs. Every field is named here rather than spread
 * off a row, which is what keeps `publishedPages`, `conflictTitle` and the rest
 * of the bookkeeping server-side.
 */

type ChapterRowForWire = {
  id: string;
  position: number;
  title: string;
  markdown: string;
  notes: string;
  status: string;
  wordCount: number;
  revision: number;
  publishedRevision: number | null;
  publishedChapterId: string | null;
  conflictTitle: string | null;
  conflictMarkdown: string | null;
  conflictDetectedAt: Date | null;
  updatedAt: Date;
};

export function serializeChapterSummary(chapter: ChapterRowForWire): ManuscriptChapterSummaryDto {
  return {
    id: chapter.id,
    position: chapter.position,
    title: chapter.title,
    status: chapterStatusToWire(chapter.status),
    wordCount: chapter.wordCount,
    revision: chapter.revision,
    excerpt: manuscriptExcerpt(chapter.markdown),
    hasUnpublishedChanges: chapterHasUnpublishedChanges(chapter),
    hasConflict: chapter.conflictDetectedAt !== null,
    bookChapterId: chapter.publishedChapterId,
    updatedAt: chapter.updatedAt.toISOString()
  };
}

export function serializeChapter(chapter: ChapterRowForWire): ManuscriptChapterDto {
  return {
    ...serializeChapterSummary(chapter),
    markdown: chapter.markdown,
    notes: chapter.notes,
    conflict:
      chapter.conflictDetectedAt !== null
        ? {
            title: chapter.conflictTitle ?? chapter.title,
            markdown: chapter.conflictMarkdown ?? "",
            detectedAt: chapter.conflictDetectedAt.toISOString()
          }
        : null
  };
}

type ProjectForManuscript = {
  id: string;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  language: string;
  mediaSettings: unknown;
};

type ManuscriptForWire = {
  revision: number;
  settings: unknown;
  publishedOrder: unknown;
  firstPublishedAt: Date | null;
  updatedAt: Date;
  chapters: Array<ChapterRowForWire & { deletedAt: Date | null }>;
};

/** Whether the book-level settings moved since the last publish; a book with no snapshot has none to move from. */
function metaChangedSincePublish(project: ProjectForManuscript, settings: ManuscriptSettings): boolean {
  return settings.published !== null && !publishedMetaEqual(settings.published, currentPublishedMeta(project, settings));
}

/**
 * What the manuscript DTO needs beyond the two rows: both are reads of other
 * tables (open jobs, the COVER image), so the caller loads them —
 * `manuscriptWireContext` — and this stays a pure function.
 */
export type ManuscriptWireContext = {
  publishBlockedReason: ManuscriptPublishBlockedReason | null;
  cover: ManuscriptCoverDto;
};

export function serializeManuscript(
  project: ProjectForManuscript,
  manuscript: ManuscriptForWire,
  context: ManuscriptWireContext
): ManuscriptDto {
  const settings = parseManuscriptSettings(manuscript.settings);
  const chapters = liveChapters(manuscript.chapters).sort((left, right) => left.position - right.position);
  const published = manuscriptIsPublished(project.mediaSettings, manuscript.firstPublishedAt);
  return {
    projectId: project.id,
    revision: manuscript.revision,
    source: manuscriptSource(project.mediaSettings) ?? "written",
    layout: settings.layout,
    kind: settings.kind,
    title: project.title,
    subtitle: project.subtitle ?? null,
    authorName: project.authorName ?? null,
    dedication: settings.dedication,
    artStyle: settings.artStyle,
    goalWords: settings.goalWords,
    language: project.language,
    wordCount: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    published,
    hasUnpublishedChanges: manuscriptHasUnpublishedChanges({
      liveChapters: chapters,
      publishedOrder: manuscript.publishedOrder,
      published,
      metaChanged: metaChangedSincePublish(project, settings)
    }),
    publishBlockedReason: context.publishBlockedReason,
    castCharacterIds: settings.castCharacterIds,
    cover: context.cover,
    chapters: chapters.map(serializeChapterSummary),
    updatedAt: manuscript.updatedAt.toISOString()
  };
}

/**
 * What the project list asks for: one nested select beside the cover, and no
 * chapter markdown — a hundred-thousand-word book would otherwise ride along
 * in every library refresh.
 */
export const manuscriptSummarySelect = {
  select: {
    settings: true,
    publishedOrder: true,
    firstPublishedAt: true,
    chapters: {
      where: { deletedAt: null },
      orderBy: { position: "asc" },
      select: { id: true, wordCount: true, revision: true, publishedRevision: true }
    }
  }
} as const;

export type ManuscriptSummaryRecord = {
  settings: unknown;
  publishedOrder: unknown;
  firstPublishedAt: Date | null;
  chapters: Array<{ id: string; wordCount: number; revision: number; publishedRevision: number | null }>;
};

export function serializeManuscriptSummary(
  project: Omit<ProjectForManuscript, "id" | "language"> & { manuscript?: ManuscriptSummaryRecord | null | undefined }
): ManuscriptSummaryDto | null {
  const manuscript = project.manuscript;
  if (!manuscript) {
    return null;
  }
  const settings = parseManuscriptSettings(manuscript.settings);
  const published = manuscriptIsPublished(project.mediaSettings, manuscript.firstPublishedAt);
  return {
    wordCount: manuscript.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    chapterCount: manuscript.chapters.length,
    goalWords: settings.goalWords,
    published,
    hasUnpublishedChanges: manuscriptHasUnpublishedChanges({
      liveChapters: manuscript.chapters,
      publishedOrder: manuscript.publishedOrder,
      published,
      metaChanged: metaChangedSincePublish({ id: "", language: "", ...project }, settings)
    })
  };
}

type VersionRow = { id: string; reason: string; title: string; markdown?: string; wordCount: number; createdAt: Date };

export function serializeVersionSummary(version: VersionRow): ManuscriptVersionSummaryDto {
  return {
    id: version.id,
    reason: versionReasonToWire(version.reason),
    title: version.title,
    wordCount: version.wordCount,
    createdAt: version.createdAt.toISOString()
  };
}

export function serializeVersion(version: VersionRow & { markdown: string }): ManuscriptVersionDto {
  return { ...serializeVersionSummary(version), markdown: version.markdown };
}
