import { expect, it, vi } from "vitest";
import { OpenAITextAdapter } from "../adapters/openai.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { composeChapter } from "./composedChapter.js";
import captured from "./testing/bolsonaroProseRunaway.json" with { type: "json" };

const input = createProjectSchema.parse({ prompt: "An assessment of Bolsonaro's presidency.", category: "BUSINESS", targetPages: 120 });
const plan = makeFallbackPlan(input);
const good = Array.from({ length: 300 }, (_, i) => `Example ${i} distinguishes a specific policy decision from its measured public outcome.`).join(" ");
// Only the response edges were retained. Replay the recorded repeated tail verbatim.
const runaway = captured.partialOutput.head + "\n\n" + captured.partialOutput.tail;

function fixture(replies: Array<"runaway" | "truncated" | "good">, chunkSize = 7) {
  const adapter = new OpenAITextAdapter({ apiKey: "fixture", model: "gpt-6-luna", thinkingEffort: "none", maxRetries: 0 });
  const closed: number[] = [], consumed: number[] = [];
  const create = vi.fn(async (request: { stream?: boolean; max_output_tokens?: number }) => {
    const index = create.mock.calls.length - 1;
    const reply = replies[index];
    if (!reply) throw new Error("Unexpected paid request");
    const text = reply === "runaway" ? runaway : good;
    const response = { model: "gpt-6-luna", status: reply === "good" ? "completed" : "incomplete", output_text: text,
      ...(reply === "good" ? {} : { incomplete_details: { reason: "max_output_tokens" } }),
      usage: { input_tokens: 11553, output_tokens: reply === "good" ? 4000 : request.max_output_tokens } };
    if (!request.stream) return response;
    return (async function* () {
      try {
        for (let i = 0; i < text.length; i += chunkSize) {
          consumed[index] = Math.min(text.length, i + chunkSize);
          yield { type: "response.output_text.delta", delta: text.slice(i, i + chunkSize) };
        }
        yield { type: `response.${response.status}`, response };
      } finally { closed.push(index); }
    })();
  });
  Object.assign(adapter, { client: { responses: { create } } });
  const compose = (signal?: AbortSignal) => composeChapter({ input, plan,
    chapter: { ...plan.chapters[0]!, index: 17, title: "How to Judge the Record" },
    stance: { thesis: "Assess the record.", positions: [], refusals: [], voiceSample: "Be specific." },
    composition: { chapterIndex: 17, throughLine: "Assess the record.", sections: [{ form: "principle", subject: "Policy outcomes", share: 1, owns: [] }], landing: "A measured verdict", avoid: [] },
    chapterPageStart: 109, chapterPageEnd: 114, earlierChapters: [], continuityNotes: [], researchNotes: [], textModel: adapter,
    ...(signal ? { signal } : {}) });
  return { adapter, create, closed, consumed, compose };
}

it.each([1, 7, 256])("recovers the captured chapter loop before its token fuse, across chunks of %i", async chunkSize => {
  const test = fixture(["runaway", "good"], chunkSize);
  expect((await test.compose()).markdown).toBe(good);
  expect(test.create.mock.calls.map(([r]) => r.max_output_tokens)).toEqual([12912, 12912]);
  expect(test.consumed[0]).toBeLessThan(runaway.length);
  expect(test.closed).toEqual([0, 1]);
});

it("gives an ordinary truncated first draft one wider attempt", async () => {
  const test = fixture(["truncated", "good"]);
  expect((await test.compose()).markdown).toBe(good);
  expect(test.create.mock.calls.map(([r]) => r.max_output_tokens)).toEqual([12912, 19368]);
});

it("does not publish a repeated failure or keep buying attempts", async () => {
  const test = fixture(["runaway", "runaway"]);
  await expect(test.compose()).rejects.toMatchObject({ name: "ProseOutputRepetitionError" });
  expect(test.create).toHaveBeenCalledTimes(2);
  expect(test.closed).toEqual([0, 1]);
});

it("honors cancellation before any chapter request", async () => {
  const test = fixture(["runaway", "good"]);
  const controller = new AbortController();
  controller.abort();
  await expect(test.compose(controller.signal)).rejects.toBe(controller.signal.reason);
  expect(test.create).not.toHaveBeenCalled();
});
