import { describe, expect, it } from "vitest";
import { calculateProjectCostSummary } from "./costs.js";
import {
  VOICE_CALL_OPERATION,
  VOICE_CALL_PURPOSE,
  addLiveVoiceUsage,
  calculateLiveVoiceCost,
  emptyLiveVoiceUsage,
  liveVoiceRate,
  parseGeminiLiveUsage
} from "./liveVoiceUsage.js";

/** One turn's report as Gemini Live sends it beside `serverContent`. */
const turnReport = {
  promptTokenCount: 1200,
  responseTokenCount: 300,
  totalTokenCount: 1500,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: 800 }, { modality: "AUDIO", tokenCount: 400 }],
  responseTokensDetails: [{ modality: "AUDIO", tokenCount: 280 }, { modality: "TEXT", tokenCount: 20 }]
};

const LIVE = { provider: "gemini", model: "gemini-3.1-flash-live-preview" } as const;

describe("parseGeminiLiveUsage", () => {
  it("splits a turn's billed tokens by direction and modality", () => {
    expect(parseGeminiLiveUsage(turnReport)).toEqual({
      complete: true,
      usage: {
        reports: 1,
        inputTokens: 1200,
        outputTokens: 300,
        inputByModality: { TEXT: 800, AUDIO: 400 },
        outputByModality: { AUDIO: 280, TEXT: 20 },
        cachedTokens: 0,
        thoughtsTokens: 0
      }
    });
  });

  it("bills thinking as output text when it is counted apart from the response", () => {
    const parsed = parseGeminiLiveUsage({ ...turnReport, thoughtsTokenCount: 50, totalTokenCount: 1550 });
    expect(parsed?.usage.outputByModality).toEqual({ AUDIO: 280, TEXT: 70 });
    expect(parsed?.usage.outputTokens).toBe(350);
    expect(parsed?.complete).toBe(true);
  });

  it("does not bill thinking twice when the total shows it inside the response", () => {
    const parsed = parseGeminiLiveUsage({ ...turnReport, thoughtsTokenCount: 50, totalTokenCount: 1500 });
    expect(parsed?.usage.outputByModality).toEqual({ AUDIO: 280, TEXT: 20 });
    expect(parsed?.usage.outputTokens).toBe(300);
  });

  it("counts a tool-use prompt as input and reads int64 counts sent as strings", () => {
    const parsed = parseGeminiLiveUsage({
      ...turnReport,
      promptTokenCount: "1200",
      toolUsePromptTokenCount: 10,
      toolUsePromptTokensDetails: [{ modality: "TEXT", tokenCount: "10" }]
    });
    expect(parsed?.usage.inputByModality).toEqual({ TEXT: 810, AUDIO: 400 });
    expect(parsed?.usage.inputTokens).toBe(1210);
    expect(parsed?.complete).toBe(true);
  });

  it("keeps a report whose details do not account for its totals, unattributed and incomplete", () => {
    const bare = parseGeminiLiveUsage({ promptTokenCount: 900, responseTokenCount: 30 });
    expect(bare?.complete).toBe(false);
    expect(bare?.usage).toMatchObject({ inputTokens: 900, outputTokens: 30, inputByModality: { UNATTRIBUTED: 900 } });
    const short = parseGeminiLiveUsage({ ...turnReport, promptTokenCount: 1300 });
    expect(short?.complete).toBe(false);
    expect(short?.usage.inputByModality).toEqual({ TEXT: 800, AUDIO: 400, UNATTRIBUTED: 100 });
    // Details claiming more than the total are no better.
    expect(parseGeminiLiveUsage({ ...turnReport, promptTokenCount: 1000 })?.complete).toBe(false);
  });

  it("ignores what is not a report and a report of nothing", () => {
    expect(parseGeminiLiveUsage(undefined)).toBeNull();
    expect(parseGeminiLiveUsage([turnReport])).toBeNull();
    expect(parseGeminiLiveUsage({ promptTokenCount: 0, totalTokenCount: 0 })).toBeNull();
    expect(parseGeminiLiveUsage({ promptTokenCount: -4 })).toBeNull();
  });
});

describe("calculateLiveVoiceCost", () => {
  it("prices each modality at Google's published Live rate", () => {
    const usage = parseGeminiLiveUsage(turnReport)!.usage;
    // 800 × $0.75 + 400 × $3.00 in, 280 × $12.00 + 20 × $4.50 out, per million.
    expect(calculateLiveVoiceCost({ ...LIVE, usage })).toBe(0.00525);
  });

  it("sums turns rather than keeping the last, because every turn re-bills the context", () => {
    const one = parseGeminiLiveUsage(turnReport)!.usage;
    const two = addLiveVoiceUsage(one, one);
    expect(two.reports).toBe(2);
    expect(calculateLiveVoiceCost({ ...LIVE, usage: two })).toBe(0.0105);
  });

  it("refuses to price a model or a modality the card has no rate for", () => {
    const usage = parseGeminiLiveUsage(turnReport)!.usage;
    expect(calculateLiveVoiceCost({ provider: "gemini", model: "gemini-live-unknown", usage })).toBeNull();
    expect(calculateLiveVoiceCost({ provider: "openai", model: LIVE.model, usage })).toBeNull();
    expect(calculateLiveVoiceCost({ ...LIVE, usage: { ...usage, inputByModality: { DOCUMENT: 5 } } })).toBeNull();
    const unattributed = parseGeminiLiveUsage({ promptTokenCount: 900, responseTokenCount: 30 })!.usage;
    expect(calculateLiveVoiceCost({ ...LIVE, usage: unattributed })).toBeNull();
  });

  it("reads the relay's `models/`-prefixed name and prices an empty usage at zero", () => {
    expect(liveVoiceRate("gemini", "models/gemini-3.1-flash-live-preview")).not.toBeNull();
    expect(calculateLiveVoiceCost({ ...LIVE, usage: emptyLiveVoiceUsage() })).toBe(0);
  });
});

describe("voice rows in a project cost summary", () => {
  it("count as audio, priced by their costHint or counted unpriced", () => {
    const summary = calculateProjectCostSummary([
      { provider: "gemini", model: LIVE.model, purpose: VOICE_CALL_PURPOSE, promptTokens: 1200, outputTokens: 300, costHint: 0.00525, metadata: { operation: VOICE_CALL_OPERATION } },
      { provider: "gemini", model: "gemini-live-unknown", purpose: VOICE_CALL_PURPOSE, promptTokens: 10, outputTokens: 5, costHint: null, metadata: { operation: VOICE_CALL_OPERATION } }
    ]);
    expect(summary).toMatchObject({ audioUsd: 0.00525, textUsd: 0, unpricedAudioCalls: 1, unpricedTextCalls: 0 });
  });
});
