import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import type { BookPlan, ChapterPlan, CreateProjectInput } from "../schemas/book.js";
import { judgeChapterDrafts, judgeExcerpt } from "./chapterJudge.js";

const input = { prompt: "A history of aggression", temperature: 0.4 } as unknown as CreateProjectInput;
const plan = { title: "Aggression Through Time", audience: "general readers" } as unknown as BookPlan;
const chapter = { index: 3, title: "The Ledger" } as unknown as ChapterPlan;

/** A judge answering by the position of the draft it prefers, whichever order it is shown. */
function judgePreferring(preferred: string | undefined) {
  const calls: string[][] = [];
  const judge = {
    ...new FakeTextModelAdapter(input),
    generateJson: async (options: GenerateJsonOptions<unknown>) => {
      const user = options.messages.find((message) => message.role === "user")?.content ?? "";
      const payload = JSON.parse(user) as { draftA: string; draftB: string };
      calls.push([payload.draftA, payload.draftB]);
      const winner = preferred === undefined ? "A" : payload.draftB === preferred ? "B" : "A";
      const data = { winner, reason: `prefers ${winner}` };
      return { data: options.schema.parse(data), text: JSON.stringify(data), model: "fake", provider: "fake" };
    }
  } as unknown as FakeTextModelAdapter;
  return { judge, calls };
}

describe("judgeChapterDrafts", () => {
  it("picks the draft both orders agree on", async () => {
    const { judge, calls } = judgePreferring("second draft");
    const verdict = await judgeChapterDrafts({ input, plan, chapter, drafts: ["first draft", "second draft"], judge });
    expect(verdict).toEqual({ pick: 1, agreed: true, reasons: ["prefers B", "prefers A"] });
    expect(calls).toHaveLength(2);
  });

  it("keeps the first draft when the two orders disagree", async () => {
    // A judge that always answers "A" prefers whichever draft came first.
    const { judge } = judgePreferring(undefined);
    const verdict = await judgeChapterDrafts({ input, plan, chapter, drafts: ["first draft", "second draft"], judge });
    expect(verdict.pick).toBe(0);
    expect(verdict.agreed).toBe(false);
  });

  it("judges a single draft without a call", async () => {
    const { judge, calls } = judgePreferring(undefined);
    await expect(judgeChapterDrafts({ input, plan, chapter, drafts: ["only"], judge })).resolves.toEqual({
      pick: 0,
      agreed: true,
      reasons: []
    });
    expect(calls).toHaveLength(0);
  });
});

describe("judgeExcerpt", () => {
  it("returns a short chapter whole and excerpts a long one at both ends", () => {
    const short = Array.from({ length: 800 }, (_, index) => `w${index}`).join(" ");
    expect(judgeExcerpt(short)).toBe(short);
    const long = Array.from({ length: 4000 }, (_, index) => `w${index}`).join(" ");
    const excerpt = judgeExcerpt(long);
    expect(excerpt.startsWith("w0 w1 ")).toBe(true);
    expect(excerpt.endsWith(" w3999")).toBe(true);
    expect(excerpt).toContain("\n\n[…]\n\n");
    expect(excerpt.split(/\s+/).filter((word) => word.startsWith("w"))).toHaveLength(1350);
  });
});
