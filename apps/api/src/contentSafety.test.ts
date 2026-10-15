import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  prisma: {
    safetySettingsRevision: { findFirst: vi.fn() },
    generationQualityRevision: { findFirst: vi.fn(async () => null) },
    providerCallLog: { create: vi.fn(async () => ({ id: "call-1" })) }
  },
  seen: [] as Array<{ messages: Array<{ role: string; content: string }> }>
}));
vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("@book-maker/core", async (importActual) => {
  const actual = await importActual<typeof import("@book-maker/core")>();
  const answer = { text: "{\"title\":\"Tide\"}", model: "deepseek-chat", provider: "deepseek" };
  // The live router stands in for a provider: it records what it was sent.
  const scripted = {
    generateText: async (options: { messages: Array<{ role: string; content: string }> }) => { mocks.seen.push(options); return answer; },
    generateJson: async (options: { messages: Array<{ role: string; content: string }>; schema: z.ZodType }) => {
      mocks.seen.push(options);
      return { ...answer, data: options.schema.parse({ title: "Tide" }) };
    },
    generateWithTools: async (options: { messages: Array<{ role: string; content: string }> }) => { mocks.seen.push(options); return { ...answer, toolCalls: [] }; },
    async *streamText() { yield ""; }
  };
  return { ...actual, createLiveGenerationTextModel: () => scripted };
});

import { generateJsonWithRetry, SEXUAL_CONTENT_RULE, type AppConfig } from "@book-maker/core";
import { forgetSexualContentFilterSetting, withContentSafetyInstructions } from "./contentSafety.js";
import { createLiveFastJudgmentsTextModel, createLiveTieredTextModel } from "./generationTextModelRouting.js";
import { withInlineProviderUsage } from "./inlineProviderUsage.js";

const CONFIG = { MOCK_AI: false } as AppConfig;
const PROMPT = [
  { role: "system" as const, content: "You are Tomeza's book advisor. Reply with JSON key title." },
  { role: "user" as const, content: "A romance between two teens." }
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seen.length = 0;
  forgetSexualContentFilterSetting();
});

describe("the API's inline model calls", () => {
  it("carry the rule through the factory, the cost recorder and the bound retry loop while the filter is on", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue(null);
    // Built exactly as the advisor and the book chat build theirs (`mobile/routeContext.ts`).
    const advisor = withInlineProviderUsage(createLiveFastJudgmentsTextModel(CONFIG), { projectId: null, userId: "user-a" });

    await generateJsonWithRetry(advisor, { messages: PROMPT, purpose: "mobile-book-advisor", schema: z.object({ title: z.string() }) });
    await createLiveTieredTextModel(CONFIG, "premium").generateText({ messages: PROMPT, purpose: "studio-assist" });

    expect(mocks.seen).toHaveLength(2);
    for (const options of mocks.seen) {
      expect(options.messages[0]!.content.startsWith(`${SEXUAL_CONTENT_RULE}\n\n`)).toBe(true);
      expect(options.messages[0]!.content.endsWith(PROMPT[0]!.content)).toBe(true);
    }
  });

  it("send the prompt as written when the operator turned the filter off", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ sexualContentFilterEnabled: false });

    await createLiveFastJudgmentsTextModel(CONFIG).generateText({ messages: PROMPT, purpose: "chat" });

    expect(mocks.seen[0]!.messages).toEqual(PROMPT);
  });

  it("put the rule in front of a voice persona, and leave it alone when off", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue(null);
    await expect(withContentSafetyInstructions("You are Marlow.")).resolves.toBe(`${SEXUAL_CONTENT_RULE}\n\nYou are Marlow.`);

    forgetSexualContentFilterSetting();
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ sexualContentFilterEnabled: false });
    await expect(withContentSafetyInstructions("You are Marlow.")).resolves.toBe("You are Marlow.");
  });
});
