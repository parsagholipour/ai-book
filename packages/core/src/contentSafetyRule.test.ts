import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GenerateTextOptions, TextModelAdapter } from "./adapters/types.js";
import { sexualContentRefusal } from "./contentRestrictions.js";
import {
  SEXUAL_CONTENT_RULE,
  withSexualContentRule,
  withSexualContentRuleMessages,
  withSexualContentRuleModel,
  withSexualContentRuleText
} from "./contentSafetyRule.js";

describe("withSexualContentRuleMessages", () => {
  it("puts the rule in front of the first system message, keeping the prompt's own ending last", () => {
    const messages = withSexualContentRuleMessages(
      [
        { role: "system", content: "Write the page. Reply with JSON keys title and markdown." },
        { role: "user", content: "Page 3." }
      ],
      true
    );
    expect(messages[0]).toEqual({
      role: "system",
      content: `${SEXUAL_CONTENT_RULE}\n\nWrite the page. Reply with JSON keys title and markdown.`
    });
    expect(messages[1]).toEqual({ role: "user", content: "Page 3." });
  });

  it("adds the rule as the system message when a call has none", () => {
    expect(withSexualContentRuleMessages([{ role: "user", content: "Hi" }], true)).toEqual([
      { role: "system", content: SEXUAL_CONTENT_RULE },
      { role: "user", content: "Hi" }
    ]);
  });

  it("is the identity when the filter is off", () => {
    const messages = [{ role: "system" as const, content: "Prompt" }];
    expect(withSexualContentRuleMessages(messages, false)).toBe(messages);
  });

  it("never adds the rule twice", () => {
    const once = withSexualContentRuleMessages([{ role: "system", content: "Prompt" }], true);
    expect(withSexualContentRuleMessages(once, true)).toBe(once);
  });

  it("is byte-identical across calls, so the cached prefix stays one prefix", () => {
    const a = withSexualContentRuleMessages([{ role: "system", content: "A" }], true)[0]!.content;
    const b = withSexualContentRuleMessages([{ role: "system", content: "B" }], true)[0]!.content;
    expect(a.slice(0, SEXUAL_CONTENT_RULE.length)).toBe(b.slice(0, SEXUAL_CONTENT_RULE.length));
  });
});

describe("withSexualContentRule", () => {
  it("returns the same options object when nothing changes", () => {
    const options: GenerateTextOptions = { messages: [{ role: "user", content: "x" }] };
    expect(withSexualContentRule(options, false)).toBe(options);
  });

  it("keeps every other option", () => {
    const signal = new AbortController().signal;
    const options = withSexualContentRule({ messages: [], purpose: "page-draft", maxTokens: 10, signal }, true);
    expect(options).toMatchObject({ purpose: "page-draft", maxTokens: 10, signal });
    expect(options.messages).toEqual([{ role: "system", content: SEXUAL_CONTENT_RULE }]);
  });
});

describe("withSexualContentRuleText", () => {
  it("prefixes a persona and leaves it alone when off", () => {
    expect(withSexualContentRuleText("You are Marlow.", true)).toBe(`${SEXUAL_CONTENT_RULE}\n\nYou are Marlow.`);
    expect(withSexualContentRuleText("You are Marlow.", false)).toBe("You are Marlow.");
  });
});

describe("withSexualContentRuleModel", () => {
  function scriptedModel() {
    const seen: GenerateTextOptions[] = [];
    const result = { text: "{}", model: "m", provider: "p" };
    const model: TextModelAdapter = {
      generateText: vi.fn(async (options) => { seen.push(options); return result; }),
      generateJson: vi.fn(async (options) => { seen.push(options); return { ...result, data: {} as never }; }),
      generateWithTools: vi.fn(async (options) => { seen.push(options); return { ...result, toolCalls: [] }; }),
      async *streamText(options) { seen.push(options); yield "chunk"; }
    };
    return { model, seen };
  }

  it("carries the rule on every method and on the bound adapter, and none when off", async () => {
    const { model, seen } = scriptedModel();
    let enabled = true;
    const wrapped = withSexualContentRuleModel(model, async () => enabled);
    const messages = [{ role: "system" as const, content: "Answer in JSON." }];
    await wrapped.generateText({ messages });
    await wrapped.generateJson({ messages, schema: z.object({}) });
    await wrapped.generateWithTools({ messages, tools: [] });
    for await (const _chunk of wrapped.streamText({ messages })) { /* drain */ }
    const bound = await wrapped.bindForCall!("chat");
    await bound.adapter.generateJson({ messages, schema: z.object({}) });
    expect(seen).toHaveLength(5);
    for (const options of seen) {
      expect(options.messages[0]!.content.startsWith(SEXUAL_CONTENT_RULE)).toBe(true);
      expect(options.messages[0]!.content.endsWith("Answer in JSON.")).toBe(true);
    }
    enabled = false;
    await wrapped.generateText({ messages });
    expect(seen[5]!.messages).toBe(messages);
  });
});

describe("sexualContentRefusal", () => {
  it("names the minor rule apart from the adult one", () => {
    expect(sexualContentRefusal("child_safety")).toMatchObject({ allowed: false, reason: "minor_sexual_content" });
    expect(sexualContentRefusal("sexual")).toMatchObject({ allowed: false, reason: "sexual_content" });
  });
});
