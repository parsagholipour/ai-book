import {
  AUDIOBOOK_MP3_KBPS,
  buildChapterNarration,
  buildAudiobookTimeline,
  encodePcm16ToMp3,
  languageLabel,
  narrationStylePrompt,
  pcm16DurationMs,
  serializeAudiobookTimeline,
  type ChapterNarration,
  type Pcm16AudioChunk,
  type SpeechAdapter,
  type SynthesizedChunkTiming
} from "@book-maker/core";
import {
  audiobookChapterPlans,
  joinNarrationChunks,
  spokenChapterLabel,
  type AudiobookChapterPlan
} from "./generateAudiobookSupport.js";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProviders } from "@book-maker/core";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";

/**
 * `generate-audiobook` job: narrate a finished book, one chapter at a time.
 *
 * Chapters are done in reading order and published the moment each is finished,
 * because that is what lets someone start listening to chapter one while the
 * back half of the book is still being made. Everything here is written to be
 * safe to run twice: chapters already marked READY are skipped, and a chapter
 * only reaches READY once both its audio and its timeline are on disk under
 * their final names.
 */

/** In-flight speech requests. Enough to hide latency, low enough to stay under provider rate limits. */
const MAX_PARALLEL_CHUNKS = 3;

export async function generateAudiobook(job: Job) {
  const projectId = job.data.projectId as string;
  const audiobookId = job.data.audiobookId as string;
  const generationJobId = job.data.generationJobId as string | undefined;

  const audiobook = await prisma.audiobook.findUnique({
    where: { id: audiobookId },
    include: { chapters: { orderBy: { index: "asc" } } }
  });
  if (!audiobook || audiobook.projectId !== projectId) {
    throw new Error(`Audiobook ${audiobookId} not found for project ${projectId}`);
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, language: true, contentRevision: true }
  });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  await advanceJobStep(generationJobId, "prepare", 8, "Preparing narration");
  const pages = await prisma.page.findMany({
    where: { projectId, status: "COMPLETED" },
    orderBy: { index: "asc" },
    select: { index: true, title: true, markdown: true, chapter: { select: { index: true, title: true } } }
  });
  if (pages.length === 0) {
    throw new Error("This book has no finished pages to narrate.");
  }

  const chapterLabel = spokenChapterLabel(project.language);
  const plans = audiobookChapterPlans(pages);
  const narrations = plans.map((chapter) =>
    buildChapterNarration({
      chapterIndex: chapter.index,
      title: chapter.title,
      language: project.language,
      chapterLabel,
      pages: chapter.pages
    })
  );

  const audioDir = join(config.AUDIO_STORAGE_DIR, projectId, audiobookId);
  await mkdir(audioDir, { recursive: true });
  await syncChapterRows(audiobookId, narrations, plans);

  const readyIndexes = new Set(
    audiobook.chapters.filter((chapter) => chapter.status === "READY").map((chapter) => chapter.index)
  );
  const providers = createLoggedProviders(job, createProviders(config));
  const stylePrompt = narrationStylePrompt({ language: languageLabel(project.language) });

  await advanceJobStep(generationJobId, "synthesize", 12, `Narrating ${narrations.length} chapters`);
  let completed = readyIndexes.size;
  for (const narration of narrations) {
    if (readyIndexes.has(narration.chapterIndex)) {
      continue;
    }
    await narrateChapter({
      narration,
      audiobookId,
      audioDir,
      voice: audiobook.voice,
      stylePrompt,
      speech: providers.speech
    });
    completed += 1;
    await updateJobProgress(generationJobId, {
      progress: 12 + Math.round((completed / narrations.length) * 80),
      message: `Narrated chapter ${completed} of ${narrations.length}`
    });
  }

  await advanceJobStep(generationJobId, "finalize", 95, "Finishing audiobook");
  const finishedChapters = await prisma.audiobookChapter.findMany({
    where: { audiobookId, status: "READY" },
    select: { durationMs: true }
  });
  await prisma.audiobook.update({
    where: { id: audiobookId },
    data: {
      status: "COMPLETE",
      error: null,
      contentRevision: project.contentRevision,
      totalDurationMs: finishedChapters.reduce((total, chapter) => total + (chapter.durationMs ?? 0), 0)
    }
  });
  await removeSupersededAudiobookDirs(projectId, audiobookId);
}

async function narrateChapter(options: {
  narration: ChapterNarration;
  audiobookId: string;
  audioDir: string;
  voice: string;
  stylePrompt: string;
  speech: SpeechAdapter;
}): Promise<void> {
  const { narration } = options;
  const results = await synthesizeChunks(options);

  const timings: SynthesizedChunkTiming[] = results.map((chunk, index) => ({
    index,
    durationMs: pcm16DurationMs(chunk)
  }));
  const timeline = buildAudiobookTimeline({ narration, timings });
  const pcm = joinNarrationChunks(results, narration);
  const mp3 = encodePcm16ToMp3(pcm, {
    sampleRate: results[0]?.sampleRate,
    channels: results[0]?.channels,
    kbps: AUDIOBOOK_MP3_KBPS
  });

  // Both files land under their final names together, so a crash between them
  // can never leave a chapter that looks ready but cannot be followed.
  const audioPath = join(options.audioDir, `chapter-${narration.chapterIndex}.mp3`);
  const timelinePath = join(options.audioDir, `chapter-${narration.chapterIndex}.timeline.json`);
  await writeFile(`${audioPath}.part`, mp3);
  await writeFile(`${timelinePath}.part`, serializeAudiobookTimeline(timeline), "utf8");
  await rename(`${audioPath}.part`, audioPath);
  await rename(`${timelinePath}.part`, timelinePath);

  await prisma.audiobookChapter.update({
    where: { audiobookId_index: { audiobookId: options.audiobookId, index: narration.chapterIndex } },
    data: {
      status: "READY",
      durationMs: timeline.durationMs,
      byteSize: mp3.length,
      segmentCount: timeline.segments.length
    }
  });
}

/**
 * Runs a bounded window of requests but keeps the results in narration order,
 * because the order is what the timeline's arithmetic depends on.
 */
async function synthesizeChunks(options: {
  narration: ChapterNarration;
  voice: string;
  stylePrompt: string;
  speech: SpeechAdapter;
}): Promise<Pcm16AudioChunk[]> {
  const { chunks } = options.narration;
  const results = Array.from<Pcm16AudioChunk | undefined>({ length: chunks.length });
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      const chunk = chunks[index];
      if (!chunk) {
        return;
      }
      const result = await options.speech.synthesize({
        text: chunk.text,
        voice: options.voice,
        stylePrompt: options.stylePrompt,
        language: options.narration.language
      });
      results[index] = { pcm: result.pcm, sampleRate: result.sampleRate, channels: result.channels };
    }
  };

  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CHUNKS, chunks.length) }, worker));

  return results.map((result, index) => {
    if (!result) {
      throw new Error(`Narration chunk ${index} produced no audio.`);
    }
    return result;
  });
}

async function syncChapterRows(
  audiobookId: string,
  narrations: ChapterNarration[],
  plans: AudiobookChapterPlan[]
): Promise<void> {
  const planByIndex = new Map(plans.map((plan) => [plan.index, plan]));
  for (const narration of narrations) {
    const plan = planByIndex.get(narration.chapterIndex);
    const pageStartIndex = plan?.pages[0]?.index;
    const pageEndIndex = plan?.pages[plan.pages.length - 1]?.index;
    const shared = {
      title: narration.title,
      estimatedDurationMs: Math.round(narration.estimatedDurationMs),
      segmentCount: narration.segments.length,
      ...(pageStartIndex === undefined ? {} : { pageStartIndex }),
      ...(pageEndIndex === undefined ? {} : { pageEndIndex })
    };
    await prisma.audiobookChapter.upsert({
      where: { audiobookId_index: { audiobookId, index: narration.chapterIndex } },
      create: { audiobookId, index: narration.chapterIndex, ...shared },
      update: shared
    });
  }

  await prisma.audiobookChapter.deleteMany({
    where: { audiobookId, index: { notIn: narrations.map((narration) => narration.chapterIndex) } }
  });
}

/** Frees the disk held by a project's previous narration once this one lands. */
async function removeSupersededAudiobookDirs(projectId: string, audiobookId: string): Promise<void> {
  const projectDir = join(config.AUDIO_STORAGE_DIR, projectId);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== audiobookId) {
      await rm(join(projectDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
