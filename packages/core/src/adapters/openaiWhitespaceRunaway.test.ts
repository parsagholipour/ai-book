import { describe, expect, it, vi } from "vitest";
import { OpenAITextAdapter } from "./openai.js";
import { WHITESPACE_RUNAWAY_NEWLINES, WhitespaceRunawayGuard } from "./whitespaceRunaway.js";

const chapter = "### The flexible 25-minute agenda\n\nUse this agenda as a starting structure.\n\n\n\nJordan meets with their manager each week.";
// r2-fast-guide (2026-09-30): the length-retry compose wrote its chapter, then " \n" to the 10,608-token fuse.
const runaway = chapter + " \n".repeat(8_000);

function setup(text: string, chunkSize = 64) {
  const adapter = new OpenAITextAdapter({ apiKey: "test", model: "gpt-6-luna", thinkingEffort: "none" });
  let consumed = 0;
  let closed = false;
  const create = vi.fn(async () => (async function* () {
    try {
      for (let i = 0; i < text.length; i += chunkSize) {
        consumed = Math.min(text.length, i + chunkSize);
        yield { type: "response.output_text.delta", delta: text.slice(i, i + chunkSize) };
      }
      yield { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
    } finally { closed = true; }
  })());
  Object.defineProperty(adapter, "client", { value: { responses: { create } } });
  return { adapter, consumed: () => consumed, closed: () => closed };
}

describe("a streamed reply that runs into blank lines", () => {
  it.each([1, 7, 64])("ends at the blank lines with the text before them, across chunks of %i", async (chunkSize) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const test = setup(runaway, chunkSize);
    const result = await test.adapter.generateText({ purpose: "compose-chapter", messages: [], maxTokens: 10_608, onOutputTextChunk: () => {} });
    expect(result.text.trim()).toBe(chapter);
    expect(test.consumed()).toBeLessThan(chapter.length + WHITESPACE_RUNAWAY_NEWLINES * 2 + chunkSize + 1);
    expect(test.closed()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: "text.whitespace_runaway", purpose: "compose-chapter" }));
    warn.mockRestore();
  });

  it("leaves a reply that only paragraphs with blank lines alone", () => {
    const guard = new WhitespaceRunawayGuard();
    const prose = `${Array.from({ length: 200 }, (_, i) => `Paragraph ${i}.\n\n\n`).join("")}The end.`;
    expect(guard.append(prose)).toBe(false);
    expect(guard.append(" \n".repeat(WHITESPACE_RUNAWAY_NEWLINES - 1))).toBe(false);
    expect(guard.append("\n")).toBe(true);
  });
});
