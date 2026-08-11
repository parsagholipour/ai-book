import {
  AUDIOBOOK_MP3_KBPS,
  buildChapterNarration,
  buildAudiobookTimeline,
  createSpeechAdapter,
  encodePcm16ToMp3,
  isSpeechProviderFallbackError,
  languageLabel,
  narrationStylePrompt,
  pcm16DurationMs,
  ProviderHttpError,
  resolveAudiobookNarratorVoice,
  serializeAudiobookTimeline,
  type ChapterNarration,
  type SpeechAdapter,
  type SpeechModelSelection,
  type SynthesizedChunkTiming
} from "@book-maker/core";
import {
  audiobookChapterPlans,
  joinNarrationChunks,
  narratedChapterLabel,
  synthesizeChunks,
  type AudiobookChapterPlan
} from "./generateAudiobookSupport.js";
import { prisma } from "@book-maker/db";
import { Job } from "bullmq";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLoggedSpeechAdapter } from "../providers/loggedAdapters.js";
import { createRunLogger } from "../providers/runLogging.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, updateJobProgress } from "../runtime/jobLifecycle.js";
import {
  selectAudiobookSpeechProvider,
  type SelectedAudiobookSpeechProvider
} from "./audiobookProviderPolicy.js";

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

  const plans = audiobookChapterPlans(pages);
  const chapterLabel = narratedChapterLabel(plans, pages, project.language);
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
  // Up front as well as at the end: only this audiobook's files are ever served,
  // so a narration that failed before it could clean up would otherwise leave
  // its chapters on disk forever.
  await removeSupersededAudiobookDirs(projectId, audiobookId);
  await syncChapterRows(audiobookId, narrations, plans);

  // Only READY chapters that exist in the *current* partition count: rows from
  // an older, larger partition would start `completed` above the chapter total
  // and push the derived progress past 100.
  const plannedChapterIndexes = new Set(plans.map((chapter) => chapter.index));
  let readyIndexes = new Set(
    audiobook.chapters
      .filter((chapter) => chapter.status === "READY" && plannedChapterIndexes.has(chapter.index))
      .map((chapter) => chapter.index)
  );
  const stylePrompt = narrationStylePrompt({ language: languageLabel(project.language) });
  const logger = createRunLogger(job);
  const plannedChunks = narrations.reduce((total, narration) => total + narration.chunks.length, 0);
  const selection = await selectInitialSpeechProvider({ audiobook, plannedChunks });
  let fallback:
    | {
        reason: string;
        discardedChapterCount: number;
        renderVersion: number;
        primaryModel: string;
        fallbackModel: string;
      }
    | undefined;

  if (selection.provider === "openai_tts" && audiobook.speechProvider !== "openai_tts") {
    const reason = selection.fallbackReason ?? "gemini_quota_preflight";
    const discardedChapterCount = readyIndexes.size;
    const renderVersion = await persistOpenAISelection({
      audiobookId,
      audioDir,
      reason,
      resetRender: discardedChapterCount > 0
    });
    if (discardedChapterCount > 0) {
      readyIndexes = new Set();
    }
    fallback = {
      reason,
      discardedChapterCount,
      renderVersion,
      primaryModel: geminiModelForAudiobook(audiobook),
      fallbackModel: selection.model
    };
    await logger.append("tts.fallback.start", fallbackLogPayload(fallback, selection));
  } else if (selection.provider === "openai_tts") {
    const reason = selection.fallbackReason ?? audiobook.fallbackReason ?? "gemini_provider_unavailable";
    fallback = {
      reason,
      discardedChapterCount: 0,
      renderVersion: audiobook.renderVersion,
      primaryModel: config.GEMINI_TTS_MODEL,
      fallbackModel: selection.model
    };
    await persistSpeechSelection(audiobookId, audiobook.voice, selection);
    await logger.append("tts.fallback.start", {
      ...fallbackLogPayload(fallback, selection),
      resumed: true
    });
  } else {
    await persistSpeechSelection(audiobookId, audiobook.voice, selection);
  }

  await advanceJobStep(generationJobId, "synthesize", 12, `Narrating ${narrations.length} chapters`);
  try {
    try {
      await narrateAllChapters({
        job,
        generationJobId,
        narrations,
        audiobookId,
        audioDir,
        narrator: audiobook.voice,
        selection,
        stylePrompt,
        readyIndexes
      });
    } catch (error) {
      if (
        selection.provider !== "gemini_tts" ||
        !backupProviderAvailable() ||
        !isSpeechProviderFallbackError(error)
      ) {
        throw error;
      }

      const reason = speechFallbackReason(error);
      const discardedChapterCount = await prisma.audiobookChapter.count({
        where: { audiobookId, status: "READY" }
      });
      const fallbackSelection: SelectedAudiobookSpeechProvider = {
        provider: "openai_tts",
        model: config.OPENAI_TTS_MODEL,
        fallbackReason: reason
      };
      const renderVersion = await persistOpenAISelection({
        audiobookId,
        audioDir,
        reason,
        resetRender: true
      });
      fallback = {
        reason,
        discardedChapterCount,
        renderVersion,
        primaryModel: selection.model,
        fallbackModel: fallbackSelection.model
      };
      await logger.append("tts.fallback.start", fallbackLogPayload(fallback, fallbackSelection));
      await updateJobProgress(generationJobId, {
        progress: 12,
        message: "Switching to backup narration and restarting the audiobook"
      });

      await narrateAllChapters({
        job,
        generationJobId,
        narrations,
        audiobookId,
        audioDir,
        narrator: audiobook.voice,
        selection: fallbackSelection,
        stylePrompt,
        readyIndexes: new Set()
      });
    }

    await advanceJobStep(generationJobId, "finalize", 95, "Finishing audiobook");
    const finishedChapters = await prisma.audiobookChapter.findMany({
      where: { audiobookId, status: "READY" },
      select: { durationMs: true }
    });
    if (finishedChapters.length !== narrations.length) {
      throw new Error(`Narration finished ${finishedChapters.length} of ${narrations.length} chapters.`);
    }
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
    if (fallback) {
      await logger.append("tts.fallback.success", {
        ...fallbackLogPayload(fallback, { provider: "openai_tts", model: fallback.fallbackModel }),
        ...(await providerSpendSummary(generationJobId))
      });
    }
  } catch (error) {
    if (fallback) {
      await logger.append("tts.fallback.error", {
        ...fallbackLogPayload(fallback, { provider: "openai_tts", model: fallback.fallbackModel }),
        ...(await providerSpendSummary(generationJobId)),
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
      });
    }
    throw error;
  }
}

async function selectInitialSpeechProvider(options: {
  audiobook: {
    speechProvider: string | null;
    speechModel: string | null;
    fallbackReason: string | null;
  };
  plannedChunks: number;
}): Promise<SelectedAudiobookSpeechProvider> {
  const fallbackAvailable = backupProviderAvailable();
  const geminiModel = geminiModelForAudiobook(options.audiobook);
  const recentGeminiCalls =
    fallbackAvailable && options.audiobook.speechProvider !== "openai_tts"
      ? await prisma.providerCallLog.count({
          where: {
            provider: "gemini_tts",
            model: geminiModel,
            purpose: "tts.synthesize",
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1_000) }
          }
        })
      : 0;
  return selectAudiobookSpeechProvider({
    persistedProvider: options.audiobook.speechProvider,
    persistedModel: options.audiobook.speechModel,
    persistedFallbackReason: options.audiobook.fallbackReason,
    recentGeminiCalls,
    plannedChunks: options.plannedChunks,
    safeGeminiBudget: config.GEMINI_TTS_SAFE_RPD_BUDGET,
    fallbackAvailable,
    geminiModel,
    openAIModel: config.OPENAI_TTS_MODEL
  });
}

function geminiModelForAudiobook(audiobook: { speechProvider: string | null; speechModel: string | null }): string {
  return audiobook.speechProvider === "gemini_tts" && audiobook.speechModel
    ? audiobook.speechModel
    : config.GEMINI_TTS_MODEL;
}

function backupProviderAvailable(): boolean {
  return config.AUDIOBOOK_OPENAI_FALLBACK_ENABLED && (config.MOCK_AI || Boolean(config.OPENAI_API_KEY));
}

async function persistSpeechSelection(
  audiobookId: string,
  narrator: string,
  selection: SpeechModelSelection
): Promise<void> {
  await prisma.audiobook.update({
    where: { id: audiobookId },
    data: {
      speechProvider: selection.provider,
      speechModel: selection.model,
      speechVoice: resolveAudiobookNarratorVoice(narrator, selection.provider)
    }
  });
}

async function persistOpenAISelection(options: {
  audiobookId: string;
  audioDir: string;
  reason: string;
  resetRender: boolean;
}): Promise<number> {
  const updated = await prisma.$transaction(async (tx) => {
    const audiobook = await tx.audiobook.findUniqueOrThrow({
      where: { id: options.audiobookId },
      select: { voice: true }
    });
    const selected = await tx.audiobook.update({
      where: { id: options.audiobookId },
      data: {
        speechProvider: "openai_tts",
        speechModel: config.OPENAI_TTS_MODEL,
        speechVoice: resolveAudiobookNarratorVoice(audiobook.voice, "openai_tts"),
        fallbackReason: options.reason,
        totalDurationMs: null,
        ...(options.resetRender ? { renderVersion: { increment: 1 } } : {})
      },
      select: { renderVersion: true }
    });
    if (options.resetRender) {
      await tx.audiobookChapter.updateMany({
        where: { audiobookId: options.audiobookId },
        data: { status: "PENDING", durationMs: null, byteSize: null, segmentCount: null }
      });
    }
    return selected;
  });
  if (options.resetRender) {
    await rm(options.audioDir, { recursive: true, force: true });
    await mkdir(options.audioDir, { recursive: true });
  }
  return updated.renderVersion;
}

async function narrateAllChapters(options: {
  job: Job;
  generationJobId: string | undefined;
  narrations: ChapterNarration[];
  audiobookId: string;
  audioDir: string;
  narrator: string;
  selection: SpeechModelSelection;
  stylePrompt: string;
  readyIndexes: Set<number>;
}): Promise<void> {
  const speech = createLoggedSpeechAdapter(options.job, createSpeechAdapter(config, options.selection));
  const voice = resolveAudiobookNarratorVoice(options.narrator, options.selection.provider);
  let completed = options.readyIndexes.size;
  for (const narration of options.narrations) {
    if (options.readyIndexes.has(narration.chapterIndex)) {
      continue;
    }
    await narrateChapter({
      narration,
      audiobookId: options.audiobookId,
      audioDir: options.audioDir,
      narrator: options.narrator,
      voice,
      stylePrompt: options.stylePrompt,
      speech
    });
    completed += 1;
    await updateJobProgress(options.generationJobId, {
      progress: 12 + Math.round((completed / options.narrations.length) * 80),
      message: `Narrated chapter ${completed} of ${options.narrations.length}`
    });
  }
}

function speechFallbackReason(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return "gemini_rate_limit";
    if (error.status === 408) return "gemini_timeout";
    if (error.status >= 500) return "gemini_unavailable";
  }
  return "gemini_network_failure";
}

function fallbackLogPayload(
  fallback: {
    reason: string;
    discardedChapterCount: number;
    renderVersion: number;
    primaryModel: string;
  },
  selection: Pick<SpeechModelSelection, "provider" | "model">
) {
  return {
    primaryProvider: "gemini_tts",
    primaryModel: fallback.primaryModel,
    fallbackProvider: selection.provider,
    fallbackModel: selection.model,
    reason: fallback.reason,
    discardedChapterCount: fallback.discardedChapterCount,
    renderVersion: fallback.renderVersion
  };
}

async function providerSpendUsd(generationJobId: string | undefined, provider: string): Promise<number> {
  if (!generationJobId) return 0;
  const result = await prisma.providerCallLog.aggregate({
    where: { generationJobId, provider },
    _sum: { costHint: true }
  });
  return result._sum.costHint ?? 0;
}

async function providerSpendSummary(generationJobId: string | undefined) {
  const [primaryProviderSpendUsd, fallbackProviderSpendUsd] = await Promise.all([
    providerSpendUsd(generationJobId, "gemini_tts"),
    providerSpendUsd(generationJobId, "openai_tts")
  ]);
  return {
    primaryProviderSpendUsd,
    fallbackProviderSpendUsd,
    actualProviderSpendUsd: primaryProviderSpendUsd + fallbackProviderSpendUsd
  };
}

async function narrateChapter(options: {
  narration: ChapterNarration;
  audiobookId: string;
  audioDir: string;
  narrator: string;
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
