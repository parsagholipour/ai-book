import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookPlanSchema, createProjectSchema } from "../schemas/book.js";
import { planChapterForms, type ChapterFormRange } from "./chapterForms.js";
import { composeChapter } from "./composedChapter.js";
import { exampleCastFrom, exampleCastLines } from "./exampleCast.js";
import { inferWritingMode } from "./styleContract.js";

const input = createProjectSchema.parse({ prompt: "A practical guide to one-on-one meetings for new managers.", category: "BUSINESS", targetPages: 20 });
const cast = [{ name: "Maya", role: "a first-time manager of a four-person design team" }, { name: "Jordan", role: "a support lead who reports to Maya" }];

function ranges(): ChapterFormRange[] {
  let start = 1;
  return makeFallbackPlan(input).chapters.map((chapter) => {
    const range = { chapter, startPage: start, endPage: start + chapter.targetPages - 1 };
    start = range.endPage + 1;
    return range;
  });
}

function recording(reply?: (options: GenerateJsonOptions<unknown>) => unknown) {
  const seen: GenerateJsonOptions<unknown>[] = [];
  const fake = new FakeTextModelAdapter(input);
  const model = { ...fake, generateJson: async (options: GenerateJsonOptions<unknown>) => {
    seen.push(options);
    const base = await fake.generateJson(options);
    const data = reply ? { ...(base.data as object), ...(reply(options) as object) } : base.data;
    return { ...base, data };
  } } as unknown as FakeTextModelAdapter;
  return { model, seen };
}

describe("a guide's recurring example people and its brief's asks", () => {
  it("reads a cast from the reply: unique names with roles, at most four", () => {
    expect(exampleCastFrom({ cast: [...cast, { name: "maya", role: "someone else" }, { name: "", role: "nobody" }, { name: "Lena", role: "x" }] })).toEqual(cast);
    expect(exampleCastFrom({ cast: "Maya" })).toBeUndefined();
    expect(exampleCastLines(cast)[0]).toContain("Maya (a first-time manager of a four-person design team); Jordan (a support lead who reports to Maya)");
    expect(exampleCastLines(undefined)).toEqual([]);
  });

  it("asks the form planner to house every brief requirement and to plan a cast, and returns the cast", async () => {
    const { model, seen } = recording(() => ({ cast }));
    const result = await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: ranges(), textModel: model,
      requirements: ['Question bank: "a question bank"'], exampleCast: "plan" });
    const system = seen[0]!.messages[0]!.content;
    const payload = JSON.parse(seen[0]!.messages[1]!.content);
    expect(system).toContain("briefRequirements lists what the request explicitly asks the book to contain");
    expect(system).toContain("Also return cast: two to four recurring example people");
    expect(payload.briefRequirements).toEqual(['Question bank: "a question bank"']);
    expect(payload.outputContract.cast).toBeDefined();
    expect(result.cast).toEqual(cast);
  });

  it("keeps an earlier run's cast whatever the planner answers, and asks for none unless told", async () => {
    const { model, seen } = recording(() => ({ cast: [{ name: "Someone", role: "else entirely" }] }));
    const kept = await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: ranges(), textModel: model, exampleCast: cast });
    expect(kept.cast).toEqual(cast);
    expect(JSON.parse(seen[0]!.messages[1]!.content).exampleCast).toEqual(cast);
    const plain = recording();
    const none = await planChapterForms({ input, plan: makeFallbackPlan(input), ranges: ranges(), textModel: plain.model });
    expect(none.cast).toBeUndefined();
    expect(plain.seen[0]!.messages[0]!.content).not.toContain("cast");
  });

  it("shows the writer the cast and stores it on the plan", async () => {
    const plan = makeFallbackPlan(input);
    const chapter = plan.chapters[0]!;
    const textModel = new FakeTextModelAdapter(input);
    const calls = vi.spyOn(textModel, "generateText");
    await composeChapter({ input, plan, chapter, exampleCast: cast,
      stance: { thesis: "Meetings belong to the employee.", positions: [], refusals: [], voiceSample: "Plain." },
      composition: { chapterIndex: chapter.index, throughLine: "t", sections: [{ form: "worked-example", subject: "Maya's first one-on-one", share: 1, owns: ["Maya"] }], landing: "l", avoid: [] },
      chapterPageStart: 1, chapterPageEnd: 4, earlierChapters: [], continuityNotes: [], researchNotes: [], textModel });
    expect(String(calls.mock.calls[0]![0].messages[0]!.content)).toContain(exampleCastLines(cast)[0]);
    expect(bookPlanSchema.parse({ ...plan, exampleCast: cast }).exampleCast).toEqual(cast);
    expect(bookPlanSchema.parse({ ...plan, exampleCast: "Maya" }).exampleCast).toBeUndefined();
  });
});

describe("the writing mode follows the stance's research answer", () => {
  it("makes a book written from no source a story, whatever its category and cue words", () => {
    const fantasy = createProjectSchema.parse({ prompt: "A fantasy novel about the last era of a dying dynasty of dragon riders.", category: "CUSTOM", targetPages: 20 });
    const stance = (research?: "sources" | "none") => ({ thesis: "t", positions: [], refusals: [], voiceSample: "v", ...(research ? { research } : {}) });
    expect(inferWritingMode(fantasy, makeFallbackPlan(fantasy))).toBe("analytical-history");
    expect(inferWritingMode(fantasy, { ...makeFallbackPlan(fantasy), authorStance: stance("none") })).toBe("narrative");
    expect(inferWritingMode(input, { ...makeFallbackPlan(input), authorStance: stance("sources") })).toBe("instructional");
    const kids = createProjectSchema.parse({ prompt: "A bedtime story.", category: "KIDS", targetPages: 12 });
    expect(inferWritingMode(kids, { ...makeFallbackPlan(kids), authorStance: stance("none") })).toBe("children-narrative");
  });
});
