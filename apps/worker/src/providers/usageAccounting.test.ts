import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateTextOptions } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    providerCallLog: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() }
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));

import {
  beginLiveTextUsage,
  durationBetweenTimestamps,
  estimateTextRequestTokens,
  estimateTokenCountFromText,
  estimateTokenCountFromTextLength,
  finiteTokenCount,
  isUsage,
  markLiveTextUsageFailed,
  maybeUpdateLiveTextOutput,
  providerUsageFromError,
  recordProviderAudioCost,
  recordProviderImageCost,
  recordProviderUsage,
  recordProviderUsageFromError,
  settleLiveTextUsageEstimate,
  withLiveOutputTracking
} from "./usageAccounting.js";

const baseCall = {
  projectId: "project-1",
  generationJobId: "gj-1",
  provider: "gemini",
  model: "gemini-2.5-flash",
  purpose: "book.page",
  operation: "generate_page",
  callId: "call-1",
  durationMs: 1200
};

const createdData = () => mocks.prisma.providerCallLog.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
const updatedData = () => mocks.prisma.providerCallLog.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.providerCallLog.create.mockResolvedValue({ id: "log-1" });
  mocks.prisma.providerCallLog.update.mockResolvedValue({});
  mocks.prisma.providerCallLog.findUnique.mockResolvedValue({ metadata: { operation: "generate_page" } });
});

describe("recordProviderUsage", () => {
  it("prices a call settled on exact usage — a non-null costHint means settled and priced", async () => {
    await recordProviderUsage({ ...baseCall, usage: { promptTokens: 1_000_000, outputTokens: 100_000 } });

    const data = createdData();
    expect(data.promptTokens).toBe(1_000_000);
    expect(data.outputTokens).toBe(100_000);
    expect(typeof data.costHint).toBe("number");
    expect(data.costHint as number).toBeGreaterThan(0);
    expect(data.metadata).toMatchObject({ liveStatus: "settled", provisional: false });
  });

  it("prices DeepSeek V4 at the official off-peak rate when settling outside peak hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await recordProviderUsage({
        ...baseCall,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        usage: { promptTokens: 1_000_000, cacheHitTokens: 100_000, outputTokens: 500_000 }
      });
      expect(createdData().costHint).toBe(1.5862);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prices DeepSeek V4 at the official peak rate during UTC weekday peak hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T07:00:00.000Z"));
    try {
      await recordProviderUsage({
        ...baseCall,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        usage: { promptTokens: 1_000_000, outputTokens: 0 }
      });
      expect(createdData().costHint).toBe(0.44);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists and prices OpenAI cache-write tokens at their write rate", async () => {
    await recordProviderUsage({
      ...baseCall,
      provider: "openai",
      model: "gpt-5.6-sol",
      usage: {
        promptTokens: 200_000,
        outputTokens: 10_000,
        cacheHitTokens: 20_000,
        cacheWriteTokens: 40_000
      }
    });

    expect(createdData()).toMatchObject({ cacheWriteTokens: 40_000, costHint: 0.968 });
  });

  it("leaves costHint null on estimated tokens, so provisional rows never read as spend", async () => {
    await recordProviderUsage({ ...baseCall, usage: undefined, fallbackPromptTokens: 500, fallbackOutputTokens: 200 });

    const data = createdData();
    expect(data.costHint).toBeNull();
    expect(data.metadata).toMatchObject({
      provisional: true,
      promptTokensEstimated: true,
      outputTokensEstimated: true
    });
  });

  it("writes an unrated row with a null costHint when no rate card prices the model", async () => {
    // Settled on real tokens but unpriceable: kept (the Costs tab counts it as
    // understated spend) rather than dropped or guessed.
    await recordProviderUsage({
      ...baseCall,
      model: "totally-unknown-model",
      usage: { promptTokens: 1000, outputTokens: 100 }
    });

    const data = createdData();
    expect(data.costHint).toBeNull();
    expect(data.metadata).toMatchObject({ provisional: false });
  });

  it("settles into the live row when one was opened", async () => {
    await recordProviderUsage({
      ...baseCall,
      usage: { promptTokens: 10, outputTokens: 5 },
      liveUsageId: "live-1"
    });

    expect(mocks.prisma.providerCallLog.create).not.toHaveBeenCalled();
    expect(mocks.prisma.providerCallLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "live-1" } })
    );
  });

  it("writes nothing without any token counts, but fails an open live row", async () => {
    await recordProviderUsage({ ...baseCall, usage: undefined });
    expect(mocks.prisma.providerCallLog.create).not.toHaveBeenCalled();

    await recordProviderUsage({ ...baseCall, usage: undefined, liveUsageId: "live-1" });
    expect(mocks.prisma.providerCallLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "live-1" },
        data: expect.objectContaining({
          costHint: null,
          metadata: expect.objectContaining({ liveStatus: "failed", provisional: true })
        })
      })
    );
  });

  it("swallows database failures rather than failing the provider call", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.providerCallLog.create.mockRejectedValue(new Error("db down"));

    await expect(
      recordProviderUsage({ ...baseCall, usage: { promptTokens: 10, outputTokens: 5 } })
    ).resolves.toBeUndefined();
    consoleError.mockRestore();
  });
});

describe("recordProviderUsageFromError", () => {
  it("records usage carried on a provider error", async () => {
    await recordProviderUsageFromError({
      projectId: "project-1",
      generationJobId: "gj-1",
      purpose: "book.page",
      operation: "generate_page",
      callId: "call-1",
      durationMs: 900,
      error: { provider: "gemini", model: "gemini-2.5-flash", usage: { promptTokens: 50, outputTokens: 0 } }
    });

    expect(createdData()).toMatchObject({ provider: "gemini", promptTokens: 50 });
  });

  it("ignores errors that carry no usage", async () => {
    await recordProviderUsageFromError({
      projectId: "project-1",
      generationJobId: "gj-1",
      purpose: "book.page",
      operation: "generate_page",
      callId: "call-1",
      durationMs: 900,
      error: new Error("plain failure")
    });

    expect(mocks.prisma.providerCallLog.create).not.toHaveBeenCalled();
  });
});

describe("live usage lifecycle", () => {
  const textOptions = { messages: [{ role: "user", content: "Write a page about robins." }] } as GenerateTextOptions;

  it("opens an in-progress row with estimated tokens and no cost", async () => {
    const live = await beginLiveTextUsage({
      ...baseCall,
      startedAt: "2026-08-08T00:00:00.000Z",
      options: textOptions
    });

    expect(live).toEqual({ id: "log-1", promptTokens: estimateTextRequestTokens(textOptions) });
    expect(createdData()).toMatchObject({
      costHint: null,
      outputTokens: 0,
      metadata: expect.objectContaining({ liveStatus: "in_progress", provisional: true })
    });
  });

  it("returns null when the live row cannot be opened", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prisma.providerCallLog.create.mockRejectedValue(new Error("db down"));

    await expect(
      beginLiveTextUsage({ ...baseCall, startedAt: "2026-08-08T00:00:00.000Z", options: textOptions })
    ).resolves.toBeNull();
    consoleError.mockRestore();
  });

  it("throttles live output updates to one per second", async () => {
    const now = Date.now();
    await expect(
      maybeUpdateLiveTextOutput({ liveUsageId: "live-1", outputTokens: 5, lastUpdateAt: now })
    ).resolves.toBe(now);
    expect(mocks.prisma.providerCallLog.update).not.toHaveBeenCalled();

    const stale = now - 5_000;
    const updatedAt = await maybeUpdateLiveTextOutput({ liveUsageId: "live-1", outputTokens: 5, lastUpdateAt: stale });
    expect(updatedAt).toBeGreaterThan(stale);
    expect(mocks.prisma.providerCallLog.update).toHaveBeenCalledWith({
      where: { id: "live-1" },
      data: { outputTokens: 5 }
    });

    // Without a live row there is nothing to update.
    await expect(maybeUpdateLiveTextOutput({ liveUsageId: undefined, outputTokens: 5, lastUpdateAt: 0 })).resolves.toBe(0);
  });

  it("settles an estimate as provisional and keeps the cost null", async () => {
    await settleLiveTextUsageEstimate("live-1", { durationMs: 1500, outputTokens: 420 });

    expect(updatedData()).toMatchObject({
      outputTokens: 420,
      costHint: null,
      metadata: expect.objectContaining({
        operation: "generate_page",
        liveStatus: "settled",
        provisional: true,
        outputTokensEstimated: true
      })
    });
  });

  it("marks a live row failed with the serialized error, preserving existing metadata", async () => {
    await markLiveTextUsageFailed("live-1", { durationMs: 700, error: new Error("stream cut") });

    expect(updatedData()).toMatchObject({
      costHint: null,
      metadata: expect.objectContaining({
        operation: "generate_page",
        liveStatus: "failed",
        provisional: true,
        error: expect.objectContaining({ message: "stream cut" })
      })
    });
  });
});

describe("image and audio cost rows", () => {
  it("writes nothing at all for an unpriced image or audio call", async () => {
    // Unlike text, an unpriced media call leaves no unrated row: the rate
    // check happens before the write, so `SUM("costHint")` stays truthful.
    await recordProviderImageCost({ ...baseCall, costHint: null, metadata: {} });
    await recordProviderAudioCost({ ...baseCall, costHint: null, audioMs: 1000 });

    expect(mocks.prisma.providerCallLog.create).not.toHaveBeenCalled();
  });

  it("writes a priced image row with its metadata", async () => {
    await recordProviderImageCost({ ...baseCall, costHint: 0.039, metadata: { assetType: "COVER" } });

    expect(createdData()).toMatchObject({
      costHint: 0.039,
      promptTokens: null,
      outputTokens: null,
      metadata: expect.objectContaining({ operation: "generate_page", callId: "call-1", assetType: "COVER" })
    });
  });

  it("writes a priced audio row with rounded audio milliseconds", async () => {
    await recordProviderAudioCost({ ...baseCall, costHint: 0.01, audioMs: 1234.56 });

    expect(createdData()).toMatchObject({
      costHint: 0.01,
      metadata: expect.objectContaining({ audioMs: 1235 })
    });
  });
});

describe("pure helpers", () => {
  it("recognizes usage-shaped objects", () => {
    expect(isUsage({ promptTokens: 1 })).toBe(true);
    expect(isUsage({ cacheHitTokens: 1 })).toBe(true);
    expect(isUsage({ cacheWriteTokens: 1 })).toBe(true);
    expect(isUsage({})).toBe(false);
    expect(isUsage([1])).toBe(false);
    expect(isUsage(null)).toBe(false);
  });

  it("extracts provider usage only from fully described errors", () => {
    expect(
      providerUsageFromError({ provider: "gemini", model: "m", usage: { promptTokens: 1 } })
    ).toEqual({ provider: "gemini", model: "m", usage: { promptTokens: 1 } });
    expect(providerUsageFromError({ provider: "gemini", usage: { promptTokens: 1 } })).toBeNull();
    expect(providerUsageFromError("nope")).toBeNull();
  });

  it("keeps only finite token counts", () => {
    expect(finiteTokenCount(42)).toBe(42);
    expect(finiteTokenCount(0)).toBe(0);
    expect(finiteTokenCount(Number.NaN)).toBeNull();
    expect(finiteTokenCount(undefined)).toBeNull();
  });

  it("estimates tokens at four characters each with a floor of one", () => {
    expect(estimateTokenCountFromTextLength(0)).toBe(0);
    expect(estimateTokenCountFromTextLength(1)).toBe(1);
    expect(estimateTokenCountFromTextLength(8)).toBe(2);
    expect(estimateTokenCountFromText("abcdefgh")).toBe(2);
    expect(estimateTextRequestTokens({ messages: [{ role: "user", content: "hi" }] } as GenerateTextOptions)).toBe(
      estimateTokenCountFromText("user\nhi") + 4 + 12
    );
  });

  it("measures durations only for ordered, parseable timestamps", () => {
    expect(durationBetweenTimestamps("2026-08-08T00:00:00.000Z", "2026-08-08T00:00:01.500Z")).toBe(1500);
    expect(durationBetweenTimestamps("2026-08-08T00:00:01.000Z", "2026-08-08T00:00:00.000Z")).toBeNull();
    expect(durationBetweenTimestamps("not a date", "2026-08-08T00:00:00.000Z")).toBeNull();
  });

  it("chains live output tracking in front of an existing chunk callback", async () => {
    const seen: string[] = [];
    const wrapped = withLiveOutputTracking(
      {
        messages: [],
        onOutputTextChunk: async (chunk: string) => {
          seen.push(`original:${chunk}`);
        }
      } as unknown as GenerateTextOptions,
      async (chunk) => {
        seen.push(`tracker:${chunk}`);
      }
    );

    await wrapped.onOutputTextChunk?.("hello");
    expect(seen).toEqual(["tracker:hello", "original:hello"]);
  });
});
