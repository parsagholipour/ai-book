import type { StudioKind, StudioLayout } from "@book-maker/core";
import type { MobileProjectSummaryDto } from "../dto.js";

/**
 * Wire shapes of the Writing Studio (`.scratch/writing-studio/spec.md`, "DTOs").
 * Types only. The Dart mirrors in `apps/mobile/lib/features/studio/domain/`
 * are written against this file, so a key renamed here is a broken app.
 *
 * No key may contain "model" — the mobile leak guard rejects it (see
 * `src/mobile/CLAUDE.md`, "Serializers are the API contract").
 */

export type ManuscriptLayout = StudioLayout;
export type ManuscriptKind = StudioKind;
export type ManuscriptChapterStatus = "idea" | "drafting" | "revised" | "final";
export type ManuscriptVersionReason = "auto" | "before_ai" | "restore" | "publish" | "conflict";

export type ManuscriptChapterSummaryDto = {
  id: string;
  /** 1-based, among live chapters. */
  position: number;
  title: string;
  status: ManuscriptChapterStatus;
  wordCount: number;
  revision: number;
  /** First ~160 characters of prose, plain text. */
  excerpt: string;
  hasUnpublishedChanges: boolean;
  hasConflict: boolean;
  /**
   * The book `Chapter` row this chapter became at the last publish (or was
   * derived from), null before it has one. The reader's `/book` payload carries
   * each page's `chapterId`, and this is how "Edit page" finds the chapter to
   * open. Added beside the spec's fields; see the spec's changelog.
   */
  bookChapterId: string | null;
  updatedAt: string;
};

export type ManuscriptChapterDto = ManuscriptChapterSummaryDto & {
  markdown: string;
  notes: string;
  conflict: null | { title: string; markdown: string; detectedAt: string };
};

export type ManuscriptPublishBlockedReason = "busy" | "audiobook" | "importing";

export type ManuscriptDto = {
  projectId: string;
  revision: number;
  source: "written" | "imported";
  layout: ManuscriptLayout;
  kind: ManuscriptKind;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  dedication: string | null;
  artStyle: string | null;
  goalWords: number | null;
  language: string;
  /** Sum over live chapters. */
  wordCount: number;
  /** Ever published (a Studio book) — always true for an imported one. */
  published: boolean;
  hasUnpublishedChanges: boolean;
  publishBlockedReason: ManuscriptPublishBlockedReason | null;
  /** Library character ids the author named as the book's cast (≤ 24), in their order. */
  castCharacterIds: string[];
  cover: ManuscriptCoverDto;
  /** Live chapters, by position. */
  chapters: ManuscriptChapterSummaryDto[];
  updatedAt: string;
};

export type ManuscriptCoverSource = "design" | "upload" | "ai";

/**
 * The book's cover as the publish sheet shows it. `imageUrl` is the public
 * `/assets/images/<projectId>/…` path (loaded with the bearer), null before the
 * first cover exists. It carries a `?v=` version that changes with every new
 * cover and with nothing else (`versionedImageAssetUrl`), so a client may cache
 * by URL. `pending` is a cover job still drawing: during it
 * `source` already names what is being made, while `imageUrl` stays the old
 * picture until the new one lands.
 */
export type ManuscriptCoverDto = {
  source: ManuscriptCoverSource;
  imageUrl: string | null;
  pending: boolean;
};

/** The `manuscript` field on `MobileProjectSummaryDto`. */
export type ManuscriptSummaryDto = {
  wordCount: number;
  chapterCount: number;
  goalWords: number | null;
  published: boolean;
  hasUnpublishedChanges: boolean;
};

export type ManuscriptVersionSummaryDto = {
  id: string;
  reason: ManuscriptVersionReason;
  title: string;
  wordCount: number;
  createdAt: string;
};

export type ManuscriptVersionDto = ManuscriptVersionSummaryDto & { markdown: string };

export type PublishChecklistItemKind =
  | "empty_chapter"
  | "untitled_chapter"
  | "placeholder"
  | "unclosed_fence"
  | "conflict"
  | "empty_book";

export type PublishChecklistDto = {
  firstPublish: boolean;
  words: number;
  estimatedPages: number;
  changedChapters: number;
  items: Array<{
    kind: PublishChecklistItemKind;
    chapterId: string | null;
    /** A reader-facing sentence. */
    message: string;
    /** `empty_book` and `conflict` block; the rest warn. */
    blocking: boolean;
  }>;
};

export type StudioProjectCreateResponseDto = {
  project: MobileProjectSummaryDto;
  manuscript: ManuscriptDto;
  chapter: ManuscriptChapterDto;
};

export type ManuscriptResponseDto = { manuscript: ManuscriptDto };

export type ManuscriptChapterResponseDto = { chapter: ManuscriptChapterDto };

export type ManuscriptChapterSaveResponseDto = {
  chapter: ManuscriptChapterSummaryDto;
  manuscriptRevision: number;
  savedAt: string;
};

export type ManuscriptChapterCreateResponseDto = { chapter: ManuscriptChapterDto; manuscript: ManuscriptDto };

export type ManuscriptVersionsResponseDto = { versions: ManuscriptVersionSummaryDto[] };

export type ManuscriptVersionResponseDto = { version: ManuscriptVersionDto };

export type ManuscriptImageUploadResponseDto = { url: string; width: number; height: number };

export type ManuscriptPublishResponseDto = { project: MobileProjectSummaryDto; manuscript: ManuscriptDto };

export type ManuscriptPublishDryRunResponseDto = { checklist: PublishChecklistDto };

export type ManuscriptFromPlanResponseDto = { project: MobileProjectSummaryDto; manuscript: ManuscriptDto };

/** `POST /manuscript/takeover`: a generated book its owner continues in the Studio. */
export type ManuscriptTakeoverResponseDto = { project: MobileProjectSummaryDto; manuscript: ManuscriptDto };

/** `POST /manuscript/assist` — every key is always present; unused ones are empty. */
export type ManuscriptQuickAssistResponseDto = {
  assist: {
    kind: string;
    suggestions: Array<{ text: string }>;
    corrections: Array<{ find: string; replace: string; reason: string }>;
    ideas: Array<{ title: string; text: string }>;
    answer: string | null;
  };
};

export type ManuscriptAssistKind = "illustrate" | "draft_chapter" | "chapter_feedback" | "consistency" | "outline";
export type ManuscriptAssistStatus = "queued" | "running" | "ready" | "failed" | "dismissed" | "applied";

export type ManuscriptAssistNoteDto = {
  quote: string | null;
  note: string;
  severity: "suggestion" | "issue";
  /** Consistency notes only: the chapter the quote was found in. */
  chapterId?: string | null;
};

export type ManuscriptAssistResultDto =
  | null
  | { type: "image"; url: string; alt: string }
  | { type: "draft"; markdown: string }
  | { type: "notes"; notes: ManuscriptAssistNoteDto[] }
  | { type: "outline"; chapters: Array<{ title: string; notes: string }> };

export type ManuscriptAssistDto = {
  id: string;
  kind: ManuscriptAssistKind;
  status: ManuscriptAssistStatus;
  chapterId: string | null;
  creditsCharged: number;
  createdAt: string;
  /** A reader-facing sentence. */
  error: string | null;
  result: ManuscriptAssistResultDto;
};

export type ManuscriptAssistResponseDto = { assist: ManuscriptAssistDto };

export type ManuscriptAssistsResponseDto = { assists: ManuscriptAssistDto[] };
