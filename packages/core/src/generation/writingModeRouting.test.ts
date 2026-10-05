import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { createProjectSchema, type BookPlan } from "../schemas/book.js";
import { WRITING_MODES } from "../schemas/styleContract.js";
import { planChapterForms } from "./chapterForms.js";
import { planEpisodes } from "./episodes.js";
import { activeToolkit, usesToolkit } from "./instructionalBook.js";
import { inferWritingMode } from "./styleContract.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

// Same conflicting fields as the two Bolsonaro books: Auto was routed to
// Business/a guide, but the completed planner chose analytical history.
const input = createProjectSchema.parse({
  prompt: "A book assessing Bolsonaro's personality and performance in government.",
  category: "BUSINESS",
  targetPages: 12,
  mediaSettings: {
    fullIllustrations: false,
    mobile: { bookTypeChoice: "auto", detectedLane: "practical_guide" }
  }
});
const plan: BookPlan = {
  ...makeFallbackPlan(input),
  title: "Bolsonaro in Power",
  premise: "An assessment of Bolsonaro's public leadership and governing record.",
  writingMode: "analytical-history",
  authorStance: { thesis: "Confrontation shaped the presidency.", positions: [], refusals: [], voiceSample: "A sample.", research: "sources" }
};

describe("generation follows the saved writing mode", () => {
  it.each(WRITING_MODES)("preserves %s despite an inferred Business/guide category", (writingMode) => {
    const saved = { ...plan, writingMode };
    expect(inferWritingMode(input, saved)).toBe(writingMode);
    expect(usesToolkit(input, saved)).toBe(writingMode === "instructional");
  });

  it("does not reactivate an old toolkit on an analytical plan", () => {
    expect(activeToolkit(input, plan, { kind: "guide", rules: [], caveats: [] })).toBeUndefined();
  });

  it("keeps category inference for a legacy plan with no saved mode", () => {
    const { writingMode: _mode, ...legacy } = plan;
    expect(inferWritingMode(input, legacy)).toBe("instructional");
    expect(usesToolkit(input, legacy)).toBe(true);
  });

  it("retains the explicit fiction signal and keeps a children's story on its own path", () => {
    const fiction = { ...plan, authorStance: { ...plan.authorStance!, research: "none" as const } };
    expect(inferWritingMode(input, fiction)).toBe("narrative");
    expect(usesToolkit(input, fiction)).toBe(false);
    expect(inferWritingMode(input, { ...fiction, writingMode: "children-narrative" })).toBe("children-narrative");
  });

  it("assigns documented episodes and retains their explanatory focus", async () => {
    const focus = {
      question: "How did Congress change the pension proposal?",
      investigation: ["Compare the proposal and enacted text", "Trace the amendments adopted in Congress"],
      contribution: "Congress shaped the enacted pension reform."
    };
    const { model, calls } = scriptedDevelopmentModel([{
      chapters: [{ index: 1, episodes: [{ title: "Pension reform", kind: "document" }], focus }]
    }]);
    const result = await planEpisodes({ input, plan, stance: plan.authorStance!, textModel: model });
    expect(result.failure).toBeUndefined();
    expect(result.episodes?.chapters[0]?.focus).toMatchObject(focus);
    const payload = JSON.parse(calls[0]!.messages.find((message) => message.role === "user")!.content);
    expect(payload.outputContract.chapters[0]).toHaveProperty("focus");
    expect(payload.outputContract).not.toHaveProperty("setting");
  });

  it("gives the chapter-form planner the analytical palette", async () => {
    const textModel = new FakeTextModelAdapter(input);
    const calls = vi.spyOn(textModel, "generateJson");
    const chapter = plan.chapters[0]!;
    await planChapterForms({ input, plan, textModel, repair: false,
      ranges: [{ chapter, startPage: 1, endPage: chapter.targetPages }] });
    const payload = JSON.parse(calls.mock.calls[0]![0].messages.find((message) => message.role === "user")!.content);
    expect(payload.book.writingMode).toBe("analytical-history");
    expect(payload.palette).toEqual(expect.arrayContaining([expect.objectContaining({ form: "close-reading" })]));
    expect(payload.palette).not.toEqual(expect.arrayContaining([expect.objectContaining({ form: "exercise" })]));
  });
});
