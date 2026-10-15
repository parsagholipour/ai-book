import { beforeEach, describe, expect, it, vi } from "vitest";

const createMany = vi.hoisted(() => vi.fn());
vi.mock("@book-maker/db", () => ({ prisma: { providerCallLog: { createMany } } }));

import { recordVoiceUsage, voiceUsageModel, VoiceUsageMeter } from "./voiceRelayUsage.js";

const identity = { callId: "call-1", userId: "user-a", projectId: null, provider: "gemini", model: "gemini-3.1-flash-live-preview" };
const report = {
  promptTokenCount: 1200,
  responseTokenCount: 300,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: 800 }, { modality: "AUDIO", tokenCount: 400 }],
  responseTokensDetails: [{ modality: "AUDIO", tokenCount: 280 }, { modality: "TEXT", tokenCount: 20 }]
};

beforeEach(() => {
  createMany.mockReset();
});

describe("VoiceUsageMeter", () => {
  it("empties itself on take, so the next segment starts from nothing", () => {
    const meter = new VoiceUsageMeter(identity, 0);
    meter.observe({ serverContent: {}, usageMetadata: report });
    expect(meter.pending).toBe(true);

    const [row] = meter.take(30_000);
    expect(row).toMatchObject({ userId: "user-a", projectId: null, purpose: "voice-call", costHint: 0.00525, durationMs: 30_000 });
    expect(meter.pending).toBe(false);
    expect(meter.take(60_000)).toEqual([]);
  });

  it("ignores frames that carry no usage", () => {
    const meter = new VoiceUsageMeter(identity);
    meter.observe({ serverContent: { turnComplete: true } });
    meter.observe({ sessionResumptionUpdate: { resumable: true }, usageMetadata: { totalTokenCount: 0 } });
    expect(meter.pending).toBe(false);
  });

  it("files every report unpriced on a model the card does not know", () => {
    const meter = new VoiceUsageMeter({ ...identity, model: "gemini-live-next" });
    meter.observe({ usageMetadata: report });
    expect(meter.take()).toEqual([expect.objectContaining({ costHint: null, promptTokens: 1200, metadata: expect.objectContaining({ costStatus: "unknown_rate" }) })]);
  });
});

describe("recordVoiceUsage", () => {
  it("writes a segment's rows in one statement", async () => {
    const meter = new VoiceUsageMeter(identity);
    meter.observe({ usageMetadata: report });
    const rows = meter.take();
    await recordVoiceUsage(rows, vi.fn());
    expect(createMany).toHaveBeenCalledExactlyOnceWith({ data: rows });
  });

  it("reports a failed write instead of throwing it", async () => {
    createMany.mockRejectedValueOnce(new Error("database away"));
    const warn = vi.fn();
    const meter = new VoiceUsageMeter(identity);
    meter.observe({ usageMetadata: report });
    await expect(recordVoiceUsage(meter.take(), warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "database away" }));
  });

  it("writes nothing for an empty segment", async () => {
    await recordVoiceUsage([], vi.fn());
    expect(createMany).not.toHaveBeenCalled();
  });
});

it("names the model the way every other cost row does", () => {
  expect(voiceUsageModel("models/gemini-3.1-flash-live-preview")).toBe("gemini-3.1-flash-live-preview");
  expect(voiceUsageModel("gemini-3.1-flash-live-preview")).toBe("gemini-3.1-flash-live-preview");
});
