/**
 * Building blocks for variants: replay the logged request (optionally transformed), post-process a
 * chapter reply the way the product does, and the two no-call arms.
 */
import { core } from "../container/runtime.ts";
import type { ChatMessage, Fixture } from "../lib/fixtures.ts";
import { unwrapWholeFence } from "../lib/text.ts";
import type { Variant, VariantContext, VariantOutput } from "./types.ts";

/** Purposes whose reply is a chapter the product normalizes before staging it. */
export const CHAPTER_TEXT_PURPOSES = new Set(["compose-chapter", "edit-chapter", "cut-chapter"]);

export type RequestTransform = (input: { messages: ChatMessage[]; temperature?: number; maxTokens?: number; fixture: Fixture }) => {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

/** The chapter as `composeChapter` / `editChapter` / `cutChapter` would keep it: unfenced, headings normalized. */
export function chapterFinal(fixture: Fixture, text: string): string {
  const title = fixture.context.chapterTitle;
  const keepSubheadings = /### /.test(String(fixture.payload?.draft ?? "")) || fixture.writingMode === "instructional";
  return core.normalizeChapterMarkdown(unwrapWholeFence(text), { ...(title ? { chapterTitle: title } : {}), ...(keepSubheadings ? { keepSubheadings: true } : {}) });
}

/** Map every system message through `rewrite`. */
export function rewriteSystem(messages: ChatMessage[], rewrite: (content: string) => string): ChatMessage[] {
  return messages.map((message) => (message.role === "system" ? { ...message, content: rewrite(message.content) } : message));
}

/** Replay the fixture's logged request (after `transform`) on the live route; search fixtures run a grounded search. */
export async function replayLogged(context: VariantContext, transform?: RequestTransform): Promise<VariantOutput> {
  const { fixture } = context;
  if (fixture.op === "search") {
    const record = await context.search(fixture.query ?? { query: "", purpose: fixture.purpose });
    return { output: record.text, calls: [record], extra: { sources: record.sources.length, grounding: record.grounding } };
  }
  const base = {
    messages: fixture.messages,
    ...(fixture.request.temperature !== undefined ? { temperature: fixture.request.temperature } : {}),
    ...(fixture.request.maxTokens !== undefined ? { maxTokens: fixture.request.maxTokens } : {})
  };
  const request = transform ? transform({ ...base, fixture }) : base;
  const record = await context.call({ purpose: fixture.purpose, json: fixture.op === "generateJson", ...request });
  return {
    output: record.text,
    ...(record.data !== undefined ? { data: record.data } : {}),
    ...(CHAPTER_TEXT_PURPOSES.has(fixture.purpose) ? { finalText: chapterFinal(fixture, record.text) } : {}),
    calls: [record]
  };
}

export const recorded: Variant = {
  name: "recorded",
  description: "No call: the reply the book actually got, with its logged latency, tokens and model. Free; use it as the reference arm.",
  async run({ fixture }) {
    const model = { provider: fixture.model.provider, model: fixture.model.model };
    const costUsd = core.calculateTextGenerationCost({ ...model, promptTokens: fixture.usage.promptTokens, outputTokens: fixture.usage.outputTokens, cacheHitTokens: fixture.usage.cacheHitTokens });
    return {
      output: fixture.response.text,
      ...(fixture.recordedData !== undefined ? { data: fixture.recordedData } : {}),
      ...(CHAPTER_TEXT_PURPOSES.has(fixture.purpose) ? { finalText: chapterFinal(fixture, fixture.response.text) } : {}),
      calls: [],
      reported: { latencyMs: fixture.durationMs, usage: fixture.usage, costUsd, model },
      ...(fixture.op === "search" ? { extra: { sources: fixture.response.sources?.length ?? 0, grounding: fixture.response.grounding } } : {})
    };
  }
};

export const baseline: Variant = {
  name: "baseline",
  description: "The logged request replayed unchanged on today's live route for the fixture's tier (the stored quality revision's model and effort).",
  run: (context) => replayLogged(context)
};
