import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateJsonWithRetry, SEXUAL_CONTENT_RULE, type GenerateTextOptions, type TextModelAdapter } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  prisma: {
    providerCallLog: {
      create: vi.fn(async () => ({ id: "provider-call-1" })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null)
    },
    safetySettingsRevision: { findFirst: vi.fn() }
  }
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("../runtime/config.js", () => ({ config: { MOCK_AI: false } }));

import { forgetContentSafetySetting } from "./contentSafetyRule.js";
import { LoggingTextModelAdapter } from "./loggedAdapters.js";

const requests: Array<{ event: string; payload: unknown }> = [];

function logged(inner: TextModelAdapter) {
  return new LoggingTextModelAdapter(
    inner,
    { filePath: "/tmp/content-safety.jsonl", append: async (event: string, payload: unknown) => { requests.push({ event, payload }); return "2026-10-13T00:00:00.000Z"; } },
    undefined,
    undefined,
    { provider: "deepseek", model: "writer" }
  );
}

function scripted() {
  const seen: GenerateTextOptions[] = [];
  const answer = { text: "{\"title\":\"t\"}", model: "writer", provider: "deepseek" };
  const model: TextModelAdapter = {
    generateText: vi.fn(async (options) => { seen.push(options); return answer; }),
    generateJson: vi.fn(async (options) => { seen.push(options); return { ...answer, data: options.schema.parse({ title: "t" }) }; }),
    generateWithTools: vi.fn(async (options) => { seen.push(options); return { ...answer, toolCalls: [] }; }),
    async *streamText(options) { seen.push(options); yield "prose"; }
  };
  return { model, seen };
}

const PROMPT = [
  { role: "system" as const, content: "You write page 3. Reply with JSON keys title and markdown." },
  { role: "user" as const, content: "An erotic story about two 15-year-olds." }
];

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  forgetContentSafetySetting();
});

describe("LoggingTextModelAdapter content rule", () => {
  it("puts the rule in front of every text call's system prompt while the filter is on (no revision = on)", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue(null);
    const { model, seen } = scripted();
    const text = logged(model);

    await text.generateText({ messages: PROMPT, purpose: "page-draft" });
    await text.generateJson({ messages: PROMPT, purpose: "page-draft", schema: z.object({ title: z.string() }) });
    await text.generateWithTools({ messages: PROMPT, purpose: "page-draft", tools: [] });
    for await (const _chunk of text.streamText({ messages: PROMPT, purpose: "page-draft" })) { /* drain */ }
    // The bound path every `generateJsonWithRetry` takes.
    await generateJsonWithRetry(text, { messages: PROMPT, purpose: "plan-book", schema: z.object({ title: z.string() }) });

    expect(seen).toHaveLength(5);
    for (const options of seen) {
      expect(options.messages[0]!.role).toBe("system");
      // First on the wire, and the prompt's own ending (its JSON keys) still last.
      expect(options.messages[0]!.content.startsWith(`${SEXUAL_CONTENT_RULE}\n\n`)).toBe(true);
      expect(options.messages[0]!.content.endsWith(PROMPT[0]!.content)).toBe(true);
      expect(options.messages[1]).toEqual(PROMPT[1]);
    }
    // The run log records what the provider was sent.
    const logged0 = requests.find((entry) => entry.event === "text.generateText.request")!.payload as { request: { messages: Array<{ content: string }> } };
    expect(JSON.stringify(logged0)).toContain("Content rule (always applies)");
    // One read of the switch for all five calls.
    expect(mocks.prisma.safetySettingsRevision.findFirst).toHaveBeenCalledTimes(1);
  });

  it("sends the prompt untouched when the operator turned the filter off", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockResolvedValue({ sexualContentFilterEnabled: false });
    const { model, seen } = scripted();

    await logged(model).generateText({ messages: PROMPT, purpose: "page-draft" });

    expect(seen[0]!.messages).toEqual(PROMPT);
  });

  it("keeps the rule on when the switch cannot be read", async () => {
    mocks.prisma.safetySettingsRevision.findFirst.mockRejectedValue(new Error("connection reset"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { model, seen } = scripted();

    await logged(model).generateText({ messages: [{ role: "user", content: "Hi" }], purpose: "chat" });

    expect(seen[0]!.messages).toEqual([
      { role: "system", content: SEXUAL_CONTENT_RULE },
      { role: "user", content: "Hi" }
    ]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
