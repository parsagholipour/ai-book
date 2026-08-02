import { AUDIOBOOK_NARRATORS, audiobookNarrator } from "@book-maker/core";
import type { AudiobookChapterStatus, AudiobookStatus } from "@book-maker/db";
import type {
  MobileAudiobookChapterDto,
  MobileAudiobookChapterStatus,
  MobileAudiobookDto,
  MobileAudiobookProgressDto,
  MobileAudiobookStatus,
  MobileNarratorVoiceDto
} from "./dto.js";

/**
 * What the app is allowed to know about a narration.
 *
 * Voices are narrator names, which are user-facing on purpose. The TTS model,
 * the provider and the chunking are not, and none of them appear here.
 */

export type AudiobookChapterRecord = {
  index: number;
  title: string;
  status: AudiobookChapterStatus;
  durationMs: number | null;
  estimatedDurationMs: number | null;
  byteSize: number | null;
  segmentCount: number | null;
};

export type AudiobookWithChapters = {
  id: string;
  projectId: string;
  voice: string;
  status: AudiobookStatus;
  contentRevision: number | null;
  totalDurationMs: number | null;
  chapters: AudiobookChapterRecord[];
};

export function serializeAudiobook(audiobook: AudiobookWithChapters, projectContentRevision: number): MobileAudiobookDto {
  const chapters = [...audiobook.chapters]
    .sort((left, right) => left.index - right.index)
    .map((chapter) => serializeAudiobookChapter(audiobook.projectId, chapter));
  const chaptersReady = chapters.filter((chapter) => chapter.status === "ready").length;
  const narrator = audiobookNarrator(audiobook.voice);

  return {
    id: audiobook.id,
    projectId: audiobook.projectId,
    status: audiobookStatus(audiobook.status),
    voice: audiobook.voice,
    narratorName: narrator?.displayName ?? audiobook.voice,
    isStale: audiobook.contentRevision !== null && audiobook.contentRevision !== projectContentRevision,
    totalDurationMs: audiobook.totalDurationMs,
    totalEstimatedDurationMs: totalEstimatedDurationMs(chapters),
    failureMessage: audiobook.status === "FAILED" ? "Narration stopped before it finished. Your credits were refunded." : null,
    progress: audiobook.status === "GENERATING" ? progressFor(chaptersReady, chapters.length) : null,
    chapters
  };
}

function serializeAudiobookChapter(projectId: string, chapter: AudiobookChapterRecord): MobileAudiobookChapterDto {
  const ready = chapter.status === "READY";
  const base = `/api/mobile/projects/${projectId}/audiobook/chapters/${chapter.index}`;
  return {
    index: chapter.index,
    title: chapter.title,
    status: chapterStatus(chapter.status),
    durationMs: chapter.durationMs,
    estimatedDurationMs: chapter.estimatedDurationMs,
    byteSize: chapter.byteSize,
    segmentCount: chapter.segmentCount,
    audioUrl: ready ? `${base}/audio` : null,
    timelineUrl: ready ? `${base}/timeline` : null
  };
}

/**
 * The player draws one continuous timeline, so it needs a length for chapters
 * that do not exist yet. Measured durations are used where they exist and
 * estimates fill the rest, which is what keeps the seek bar from jumping as the
 * tail of the book arrives.
 */
function totalEstimatedDurationMs(chapters: MobileAudiobookChapterDto[]): number | null {
  if (chapters.length === 0) {
    return null;
  }
  return chapters.reduce((total, chapter) => total + (chapter.durationMs ?? chapter.estimatedDurationMs ?? 0), 0);
}

function progressFor(chaptersReady: number, chapterCount: number): MobileAudiobookProgressDto {
  return {
    percent: chapterCount > 0 ? Math.round((chaptersReady / chapterCount) * 100) : 0,
    currentAction:
      chapterCount === 0
        ? "Preparing narration"
        : chaptersReady === 0
          ? "Narrating the first chapter"
          : `Narrated ${chaptersReady} of ${chapterCount} chapters`,
    chaptersReady,
    chapterCount
  };
}

export function serializeNarratorVoices(): MobileNarratorVoiceDto[] {
  return AUDIOBOOK_NARRATORS.map((narrator) => ({
    voice: narrator.voice,
    name: narrator.displayName,
    blurb: narrator.blurb,
    // The version becomes part of the app's on-device cache key. Bump it when
    // replacing the bundled recordings so existing installs fetch them again.
    sampleUrl: `/api/mobile/audiobook/voices/${narrator.voice}/sample?v=1`
  }));
}

function audiobookStatus(status: AudiobookStatus): MobileAudiobookStatus {
  switch (status) {
    case "COMPLETE":
      return "complete";
    case "FAILED":
      return "failed";
    default:
      return "generating";
  }
}

function chapterStatus(status: AudiobookChapterStatus): MobileAudiobookChapterStatus {
  switch (status) {
    case "READY":
      return "ready";
    case "FAILED":
      return "failed";
    default:
      return "pending";
  }
}
