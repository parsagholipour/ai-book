import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateTextOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema } from "../schemas/book.js";
import { chapterWordBudget, composeChapter } from "./composedChapter.js";
import { LENGTH_FLOOR_SHARE } from "./printedLength.js";

const input = createProjectSchema.parse({ prompt: "A practical guide to one-on-one meetings.", category: "BUSINESS", targetPages: 20 });
const plan = makeFallbackPlan(input);
const chapter = plan.chapters[0]!;
const min = chapterWordBudget(input, 4).min;
const prose = (words: number) => Array.from({ length: Math.ceil(words / 10) }, (_, i) => `Sentence ${i} holds exactly ten words about the one meeting.`).join(" ");

function compose(replies: Array<string | Error>, lengthSlack?: number) {
  const fake = new FakeTextModelAdapter(input);
  const calls: GenerateTextOptions[] = [];
  const model = { ...fake, generateText: async (options: GenerateTextOptions) => {
    calls.push(options);
    const reply = replies[Math.min(calls.length, replies.length) - 1]!;
    if (reply instanceof Error) throw reply;
    return { text: reply, provider: "fixture", model: "fixture" };
  } } as unknown as FakeTextModelAdapter;
  const result = composeChapter({ input, plan, chapter, ...(lengthSlack !== undefined ? { lengthSlack } : {}),
    stance: { thesis: "t", positions: [], refusals: [], voiceSample: "v" },
    composition: { chapterIndex: chapter.index, throughLine: "t", sections: [{ form: "principle", subject: "s", share: 1, owns: [] }], landing: "l", avoid: [] },
    chapterPageStart: 1, chapterPageEnd: 4, earlierChapters: [], continuityNotes: [], researchNotes: [], textModel: model });
  return { result, calls };
}

async function attemptsFor(words: number, lengthSlack?: number) {
  const { result, calls } = compose([prose(words)], lengthSlack);
  await result;
  return calls.length;
}

describe("the compose call's length retry", () => {
  it("retries a chapter under the length floor unless the book's earlier chapters already cover the shortfall", async () => {
    const short = Math.round(min * 0.8);
    expect(await attemptsFor(short)).toBe(2);
    expect(await attemptsFor(short, 0)).toBe(2);
    expect(await attemptsFor(short, min)).toBe(1);
    // Covered, but a stub: under three quarters of the minimum is retried whatever the slack.
    expect(await attemptsFor(Math.round(min * 0.6), 10 * min)).toBe(2);
    expect(await attemptsFor(min + 50)).toBe(1);
  });

  it("takes a draft that prints its pages: at the floor the book is judged at, no second call", async () => {
    // 2026-10-01: 32 of the 44 stored length retries asked again for a draft at 0.85–0.99 of its minimum.
    expect(await attemptsFor(Math.round(min * 0.9))).toBe(1);
    expect(await attemptsFor(Math.ceil(min * LENGTH_FLOOR_SHARE / 10) * 10)).toBe(1);
  });

  it("counts a worksheet by the room it prints, not only the words in its cells", async () => {
    const rows = 20;
    const table = ["| Item | Amount | Decision |", "|---|---|---|", ...Array.from({ length: rows - 1 }, () => "| Rent | [ ] | [ ] |")].join("\n");
    const { result, calls } = compose([`${prose(Math.round(min * 0.75))}\n\n${table}`]);
    expect((await result).words).toBeGreaterThanOrEqual(min * LENGTH_FLOOR_SHARE);
    expect(calls).toHaveLength(1);
  });

  it("keeps the earlier draft when the length retry fails, and says why", async () => {
    const first = prose(Math.round(min * 0.7));
    const { result, calls } = compose([first, new Error("OpenAI response was incomplete: max_output_tokens.")]);
    const composed = await result;
    expect(calls).toHaveLength(2);
    expect(composed.markdown).toBe(first);
    expect(composed.attempts).toBe(2);
    expect(composed.lengthRetryError).toBe("OpenAI response was incomplete: max_output_tokens.");
  });

  it("still fails on a first call that fails, and lets a stop through a retry", async () => {
    await expect(compose([new Error("Connection error.")]).result).rejects.toThrow("Connection error.");
    // An empty first answer is no draft to keep.
    await expect(compose(["", new Error("Connection error.")]).result).rejects.toThrow("Connection error.");
    const stop = Object.assign(new Error("Generation stopped by user"), { name: "StopRequestedError" });
    await expect(compose([prose(Math.round(min * 0.7)), stop]).result).rejects.toBe(stop);
  });
});
