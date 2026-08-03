import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    audiobook: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    audiobookChapter: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn()
    },
    project: { findUnique: vi.fn() },
    page: { findMany: vi.fn() },
    providerCallLog: { count: vi.fn(), aggregate: vi.fn() },
    $transaction: vi.fn()
  },
  createSpeechAdapter: vi.fn(),
  advanceJobStep: vi.fn(),
  updateJobProgress: vi.fn(),
  logEvents: [] as string[],
  config: {
    AUDIO_STORAGE_DIR: "",
    OPENAI_API_KEY: "openai-key",
    AUDIOBOOK_OPENAI_FALLBACK_ENABLED: true,
    GEMINI_TTS_SAFE_RPD_BUDGET: 90,
    GEMINI_TTS_MODEL: "gemini-tts",
    OPENAI_TTS_MODEL: "openai-tts",
    MOCK_AI: false
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
vi.mock("@book-maker/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@book-maker/core")>()),
  createSpeechAdapter: mocks.createSpeechAdapter
}));
vi.mock("../runtime/config.js", () => ({ config: mocks.config }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: mocks.advanceJobStep,
  updateJobProgress: mocks.updateJobProgress
}));
vi.mock("../providers/runLogging.js", () => ({
  createRunLogger: () => ({
    filePath: "test.jsonl",
    append: async (event: string) => {
      mocks.logEvents.push(event);
      return new Date().toISOString();
    }
  })
}));
vi.mock("../providers/loggedAdapters.js", async () => {
  const { isRecoverableNetworkError } = await import("@book-maker/core");
  return {
    createLoggedSpeechAdapter: (_job: Job, speech: { synthesize(request: unknown): Promise<unknown> }) => ({
      async synthesize(request: unknown) {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          try {
            return await speech.synthesize(request);
          } catch (error) {
            if (attempt === 5 || !isRecoverableNetworkError(error)) throw error;
          }
        }
        throw new Error("retry exhausted");
      }
    })
  };
});

import { ProviderHttpError } from "@book-maker/core";
import { generateAudiobook } from "./generateAudiobook.js";

type ChapterRow = {
  index: number;
  title: string;
  status: "PENDING" | "READY";
  durationMs: number | null;
  estimatedDurationMs: number | null;
  byteSize: number | null;
  segmentCount: number | null;
};

let storageDir: string;
let recentGeminiCalls: number;
let speechFailure: ((provider: string, call: number) => unknown) | undefined;
let providerCalls: Array<{ provider: string; voice: string; text: string }>;
let chapterRows: ChapterRow[];
let audiobook: Record<string, unknown>;

function chapter(index: number, status: "PENDING" | "READY" = "PENDING"): ChapterRow {
  return {
    index,
    title: `Chapter ${index}`,
    status,
    durationMs: status === "READY" ? 100 : null,
    estimatedDurationMs: 100,
    byteSize: status === "READY" ? 10 : null,
    segmentCount: status === "READY" ? 1 : null
  };
}

function job(): Job {
  return {
    id: "bull-1",
    name: "generate-audiobook",
    data: { projectId: "project-1", audiobookId: "audio-1", generationJobId: "job-1" }
  } as unknown as Job;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.logEvents.length = 0;
  storageDir = await mkdtemp(join(tmpdir(), "audiobook-fallback-"));
  mocks.config.AUDIO_STORAGE_DIR = storageDir;
  mocks.config.OPENAI_API_KEY = "openai-key";
  mocks.config.AUDIOBOOK_OPENAI_FALLBACK_ENABLED = true;
  mocks.config.GEMINI_TTS_SAFE_RPD_BUDGET = 90;
  recentGeminiCalls = 0;
  speechFailure = undefined;
  providerCalls = [];
  chapterRows = [];
  audiobook = {
    id: "audio-1",
    projectId: "project-1",
    voice: "Zephyr",
    status: "GENERATING",
    contentRevision: 3,
    totalDurationMs: null,
    generationJobId: "job-1",
    error: null,
    speechProvider: null,
    speechModel: null,
    speechVoice: null,
    fallbackReason: null,
    renderVersion: 1
  };

  mocks.prisma.audiobook.findUnique.mockImplementation(async () => ({ ...audiobook, chapters: [...chapterRows] }));
  mocks.prisma.audiobook.findUniqueOrThrow.mockImplementation(async () => ({ voice: audiobook.voice }));
  mocks.prisma.project.findUnique.mockResolvedValue({
    id: "project-1",
    title: "Book",
    language: "en",
    contentRevision: 3
  });
  mocks.prisma.page.findMany.mockResolvedValue([
    { index: 1, title: "One", markdown: "First chapter.", chapter: { index: 1, title: "One" } },
    { index: 2, title: "Two", markdown: "Second chapter.", chapter: { index: 2, title: "Two" } }
  ]);
  mocks.prisma.providerCallLog.count.mockImplementation(async () => recentGeminiCalls);
  mocks.prisma.providerCallLog.aggregate.mockResolvedValue({ _sum: { costHint: 0.001 } });
  mocks.prisma.audiobookChapter.upsert.mockImplementation(async ({ create, update }: { create: ChapterRow; update: Partial<ChapterRow> }) => {
    const existing = chapterRows.find((row) => row.index === create.index);
    if (existing) Object.assign(existing, update);
    else chapterRows.push({ ...chapter(create.index), ...create });
    return existing ?? create;
  });
  mocks.prisma.audiobookChapter.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.audiobookChapter.update.mockImplementation(async ({ where, data }: { where: { audiobookId_index: { index: number } }; data: Partial<ChapterRow> }) => {
    const row = chapterRows.find((candidate) => candidate.index === where.audiobookId_index.index)!;
    Object.assign(row, data);
    return row;
  });
  mocks.prisma.audiobookChapter.updateMany.mockImplementation(async ({ data }: { data: Partial<ChapterRow> }) => {
    chapterRows.forEach((row) => Object.assign(row, data));
    return { count: chapterRows.length };
  });
  mocks.prisma.audiobookChapter.count.mockImplementation(
    async () => chapterRows.filter((row) => row.status === "READY").length
  );
  mocks.prisma.audiobookChapter.findMany.mockImplementation(
    async () => chapterRows.filter((row) => row.status === "READY")
  );
  mocks.prisma.audiobook.update.mockImplementation(async ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
    for (const [key, value] of Object.entries(data)) {
      if (key === "renderVersion" && typeof value === "object" && value) {
        audiobook.renderVersion = Number(audiobook.renderVersion) + Number((value as { increment: number }).increment);
      } else {
        audiobook[key] = value;
      }
    }
    return select ? { renderVersion: audiobook.renderVersion } : { ...audiobook };
  });
  mocks.prisma.$transaction.mockImplementation(async (operation: (tx: typeof mocks.prisma) => Promise<unknown>) => operation(mocks.prisma));

  const providerCounts = new Map<string, number>();
  mocks.createSpeechAdapter.mockImplementation((_config, selection: { provider: string; model: string }) => ({
    async synthesize(request: { text: string; voice: string }) {
      const call = (providerCounts.get(selection.provider) ?? 0) + 1;
      providerCounts.set(selection.provider, call);
      providerCalls.push({ provider: selection.provider, voice: request.voice, text: request.text });
      const failure = speechFailure?.(selection.provider, call);
      if (failure) throw failure;
      return {
        provider: selection.provider,
        model: selection.model,
        pcm: Buffer.alloc(4_800),
        sampleRate: 24_000,
        channels: 1,
        durationMs: 100
      };
    }
  }));
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe("generateAudiobook provider fallback", () => {
  it("completes normally with Gemini and no fallback", async () => {
    await generateAudiobook(job());

    expect(providerCalls.every((call) => call.provider === "gemini_tts")).toBe(true);
    expect(audiobook).toMatchObject({ status: "COMPLETE", speechProvider: "gemini_tts", renderVersion: 1 });
    expect(mocks.logEvents).not.toContain("tts.fallback.start");
  });

  it("starts directly on OpenAI when preflight projects beyond the Gemini budget", async () => {
    recentGeminiCalls = 90;
    await generateAudiobook(job());

    expect(providerCalls.every((call) => call.provider === "openai_tts")).toBe(true);
    expect(audiobook).toMatchObject({
      speechProvider: "openai_tts",
      fallbackReason: "gemini_quota_preflight",
      renderVersion: 1
    });
  });

  it("retries a short Gemini 429 without restarting or mixing providers", async () => {
    speechFailure = (provider, call) =>
      provider === "gemini_tts" && call === 1
        ? new ProviderHttpError("short throttle", { status: 429, retryAfterMs: 100 })
        : undefined;
    await generateAudiobook(job());

    expect(providerCalls.filter((call) => call.provider === "gemini_tts").length).toBeGreaterThan(2);
    expect(providerCalls.some((call) => call.provider === "openai_tts")).toBe(false);
    expect(audiobook.renderVersion).toBe(1);
  });

  it.each([
    ["long 429", new ProviderHttpError("daily quota", { status: 429, retryAfterMs: 120_000 })],
    ["5xx", new ProviderHttpError("unavailable", { status: 503 })],
    ["network", Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" })]
  ])("restarts every chapter exactly once on %s", async (_label, failure) => {
    chapterRows = [chapter(1, "READY"), chapter(2)];
    speechFailure = (provider) => (provider === "gemini_tts" ? failure : undefined);
    await generateAudiobook(job());

    const openAIText = providerCalls.filter((call) => call.provider === "openai_tts").map((call) => call.text);
    expect(openAIText.some((text) => text.includes("First chapter"))).toBe(true);
    expect(openAIText.some((text) => text.includes("Second chapter"))).toBe(true);
    expect(chapterRows.every((row) => row.status === "READY")).toBe(true);
    expect(audiobook).toMatchObject({ speechProvider: "openai_tts", renderVersion: 2 });
    expect(mocks.logEvents.filter((event) => event === "tts.fallback.start")).toHaveLength(1);
    expect(mocks.logEvents).toContain("tts.fallback.success");
  });

  it.each([
    ["bad input", new ProviderHttpError("bad input", { status: 400 })],
    ["unauthorized", new ProviderHttpError("unauthorized", { status: 401 })],
    ["forbidden", new ProviderHttpError("forbidden", { status: 403 })],
    ["abort", Object.assign(new Error("request aborted"), { name: "AbortError" })],
    ["stop", Object.assign(new Error("Stopped by user"), { name: "StopRequestedError" })]
  ])("does not fallback for %s", async (_label, failure) => {
    speechFailure = (provider) => (provider === "gemini_tts" ? failure : undefined);
    await expect(generateAudiobook(job())).rejects.toBe(failure);

    expect(providerCalls.some((call) => call.provider === "openai_tts")).toBe(false);
    expect(audiobook.speechProvider).toBe("gemini_tts");
    expect(audiobook.renderVersion).toBe(1);
  });

  it("resumes a persisted OpenAI switch without making another Gemini request", async () => {
    audiobook.speechProvider = "openai_tts";
    audiobook.speechModel = "openai-snapshot";
    audiobook.speechVoice = "marin";
    audiobook.fallbackReason = "gemini_rate_limit";
    audiobook.renderVersion = 2;
    mocks.config.AUDIOBOOK_OPENAI_FALLBACK_ENABLED = false;
    chapterRows = [chapter(1, "READY"), chapter(2)];

    await generateAudiobook(job());

    expect(providerCalls.every((call) => call.provider === "openai_tts")).toBe(true);
    expect(audiobook.renderVersion).toBe(2);
  });

  it("logs the backup failure and lets the existing job refund path handle it", async () => {
    speechFailure = (provider) =>
      provider === "gemini_tts"
        ? new ProviderHttpError("unavailable", { status: 503 })
        : new ProviderHttpError("backup unavailable", { status: 503 });

    await expect(generateAudiobook(job())).rejects.toThrow("backup unavailable");
    expect(mocks.logEvents.filter((event) => event === "tts.fallback.start")).toHaveLength(1);
    expect(mocks.logEvents).toContain("tts.fallback.error");
  });
});
