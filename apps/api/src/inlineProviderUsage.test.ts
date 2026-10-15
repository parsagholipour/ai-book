import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobile/testing/mobileApiMocks.js")).dbModuleMock());

import { z } from "zod";
import { generateJsonWithRetry, type TextModelAdapter } from "@book-maker/core";
import { recordInlineProviderUsage, withInlineProviderUsage, withInlineResearchUsage } from "./inlineProviderUsage.js";
import { mockPrisma } from "./mobile/testing/mobileApiMocks.js";

afterEach(() => {
  vi.clearAllMocks();
});

function rows() {
  return mockPrisma.providerCallLog.create.mock.calls.map((call) => call[0].data);
}

describe("recordInlineProviderUsage", () => {
  it("prices a call only from the tokens the provider reported", async () => {
    await recordInlineProviderUsage({
      projectId: "project-1",
      userId: "reader-1",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "author-assist-rewrite",
      textOperation: "text.generateJson",
      durationMs: 812,
      usage: { promptTokens: 1000, outputTokens: 200, reasoningTokens: 50 },
      fallbackPromptTokens: 7,
      fallbackOutputTokens: 7
    });
    await recordInlineProviderUsage({
      projectId: null,
      userId: "reader-1",
      provider: "deepseek",
      model: "deepseek-chat",
      purpose: "author-assist-ask",
      textOperation: "text.generateJson",
      durationMs: 400,
      usage: { promptTokens: 1000 },
      fallbackPromptTokens: 900,
      fallbackOutputTokens: 120
    });

    const [exact, estimated] = rows();
    expect(exact).toMatchObject({
      projectId: "project-1",
      generationJobId: null,
      userId: "reader-1",
      promptTokens: 1000,
      outputTokens: 200,
      durationMs: 812,
      metadata: { operation: "inline", provisional: false, reasoningTokens: 50, liveStatus: "settled" }
    });
    expect(exact.costHint).toBeGreaterThan(0);
    // An estimate may move a token count, never a dollar figure.
    expect(estimated).toMatchObject({
      promptTokens: 1000,
      outputTokens: 120,
      costHint: null,
      metadata: { provisional: true, promptTokensEstimated: false, outputTokensEstimated: true }
    });
  });

  it("swallows a write that fails", async () => {
    mockPrisma.providerCallLog.create.mockRejectedValueOnce(new Error("database away"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      recordInlineProviderUsage({
        projectId: null,
        userId: null,
        provider: "deepseek",
        model: "deepseek-chat",
        purpose: "p",
        textOperation: "text.generateJson",
        durationMs: 1,
        usage: undefined,
        fallbackPromptTokens: 1,
        fallbackOutputTokens: 1
      })
    ).resolves.toBeUndefined();
    quiet.mockRestore();
  });
});

describe("withInlineProviderUsage", () => {
  function scripted(replies: Array<unknown | Error>): TextModelAdapter {
    return {
      async generateJson(options) {
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return {
          data: options.schema.parse(reply),
          text: JSON.stringify(reply),
          provider: "deepseek",
          model: "deepseek-chat",
          usage: { promptTokens: 100, outputTokens: 10 }
        };
      },
      generateText: async () => ({ text: "", provider: "deepseek", model: "deepseek-chat" }),
      generateWithTools: async () => ({ text: "", provider: "deepseek", model: "deepseek-chat", toolCalls: [] }),
      async *streamText() {
        yield "";
      }
    };
  }

  it("records the call a retry wrapper makes through the bound adapter", async () => {
    const result = await generateJsonWithRetry(withInlineProviderUsage(scripted([{ text: "fixed" }]), { projectId: "project-1", userId: "reader-1" }), {
      purpose: "author-assist-rewrite",
      schema: z.object({ text: z.string() }),
      messages: [{ role: "user", content: "Rewrite this." }]
    });

    expect(result.data).toEqual({ text: "fixed" });
    expect(rows()).toEqual([
      expect.objectContaining({ purpose: "author-assist-rewrite", projectId: "project-1", userId: "reader-1", promptTokens: 100, outputTokens: 10 })
    ]);
  });

  it("records nothing for a call that failed, and hands the failure back", async () => {
    const model = withInlineProviderUsage(scripted([new Error("provider exploded")]), { projectId: null, userId: "reader-1" });

    await expect(
      model.generateJson({ purpose: "author-assist-ask", schema: z.object({ answer: z.string() }), messages: [] })
    ).rejects.toThrow("provider exploded");
    expect(rows()).toEqual([]);
  });
});

describe("withInlineResearchUsage", () => {
  function research(grounding: { searchQueries: number; webSources: number } | undefined, allowances?: Record<string, number>) {
    return withInlineResearchUsage({
      search: async (query) => ({
        query: query.query,
        summary: "Notes.",
        provider: "gemini",
        model: "gemini-2.5-flash",
        usage: { promptTokens: 200, outputTokens: 800, reasoningTokens: 0 },
        ...(grounding ? { grounding } : {}),
        sources: []
      })
    }, { projectId: null, userId: "reader-1", ...(allowances ? { searchGroundingAllowances: allowances } : {}) });
  }

  it("claims the creation chat's grounded search an ordinal in the shared allowance, and prices it free inside it", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ units: 791 }]);

    await research({ searchQueries: 4, webSources: 9 }).search({ query: "container shipping history", purpose: "mobile-creation-chat" });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // 200 × $0.30/M + 800 × $2.50/M = $0.00206 in tokens; prompt 791 of the day's 1,500 is free.
    expect(rows()).toEqual([expect.objectContaining({
      projectId: null,
      generationJobId: null,
      // The creation chat has no book yet, so only the reader names whose spend it was.
      userId: "reader-1",
      purpose: "mobile-creation-chat",
      costHint: 0.00206,
      metadata: expect.objectContaining({
        operation: "inline",
        textOperation: "research.search",
        groundedPrompt: true,
        webSearchQueries: 4,
        groundingSources: 9,
        groundingFeeUsd: 0,
        groundingListFeeUsd: 0.035,
        groundingPool: "gemini-2.5-flash",
        groundingUnits: 1,
        groundingOrdinal: 791,
        groundingAllowance: 1_500,
        groundingAllowanceCovered: true
      })
    })]);
  });

  it("bills list price past the allowance, and for every prompt when it is set to 0", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ units: 1_501 }]).mockResolvedValueOnce([{ units: 1 }]);

    await research({ searchQueries: 4, webSources: 9 }).search({ query: "a" });
    await research({ searchQueries: 4, webSources: 9 }, { SEARCH_GROUNDING_FREE_GEMINI_25_FLASH_PER_DAY: 0 }).search({ query: "b" });

    expect(rows()).toEqual([
      expect.objectContaining({ costHint: 0.03706, metadata: expect.objectContaining({ groundingOrdinal: 1_501, groundingFeeUsd: 0.035 }) }),
      expect.objectContaining({ costHint: 0.03706, metadata: expect.objectContaining({ groundingOrdinal: 1, groundingAllowance: 0, groundingFeeUsd: 0.035 }) })
    ]);
  });

  it("writes nothing for a search that reported no usage, such as the mock adapter's", async () => {
    const plain = withInlineResearchUsage({
      search: async (query) => ({ query: query.query, summary: "Placeholder.", sources: [] })
    }, { projectId: null, userId: null });

    await plain.search({ query: "anything" });

    expect(rows()).toEqual([]);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
