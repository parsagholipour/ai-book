import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobile/testing/mobileApiMocks.js")).dbModuleMock());

import { z } from "zod";
import { generateJsonWithRetry, type TextModelAdapter } from "@book-maker/core";
import { recordInlineProviderUsage, withInlineProviderUsage } from "./inlineProviderUsage.js";
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
    const result = await generateJsonWithRetry(withInlineProviderUsage(scripted([{ text: "fixed" }]), { projectId: "project-1" }), {
      purpose: "author-assist-rewrite",
      schema: z.object({ text: z.string() }),
      messages: [{ role: "user", content: "Rewrite this." }]
    });

    expect(result.data).toEqual({ text: "fixed" });
    expect(rows()).toEqual([
      expect.objectContaining({ purpose: "author-assist-rewrite", projectId: "project-1", promptTokens: 100, outputTokens: 10 })
    ]);
  });

  it("records nothing for a call that failed, and hands the failure back", async () => {
    const model = withInlineProviderUsage(scripted([new Error("provider exploded")]), { projectId: null });

    await expect(
      model.generateJson({ purpose: "author-assist-ask", schema: z.object({ answer: z.string() }), messages: [] })
    ).rejects.toThrow("provider exploded");
    expect(rows()).toEqual([]);
  });
});
