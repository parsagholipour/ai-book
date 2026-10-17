import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import type { InstructionalToolkit } from "../schemas/instructional.js";
import { PINNED_FORMS } from "./chapterFormPalette.js";
import type { ChapterFormRange } from "./chapterForms.js";
import { planEpisodes } from "./episodes.js";
import { planInstructionalForms, planResearchLeads } from "./instructionalPlanning.js";

const input = {
  prompt: "Create a workbook for freelancers with irregular income: budgeting, taxes, a buffer month, pricing.",
  category: "EDUCATION",
  targetPages: 9,
  complexity: 4,
  temperature: 0.65,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "manual",
    includeCover: false,
    coverTemplate: "auto",
    finalReview: false,
    toneProfile: "neutral",
    mobile: { bookTypeChoice: "workbook" }
  }
} as CreateProjectInput;

const plan = {
  ...makeFallbackPlan(input),
  continuityRules: ["Keep tax guidance general and direct readers to local authorities.", "Label sample figures as illustrative."],
  chapters: [
    { index: 1, title: "Your money snapshot", summary: "What comes in and goes out", keyBeats: ["Snapshot worksheet"], targetPages: 3 },
    { index: 2, title: "Set aside tax money", summary: "A tax routine", keyBeats: ["Tax tracker"], targetPages: 3 },
    { index: 3, title: "Price your work", summary: "A planning rate", keyBeats: ["Pricing worksheet"], targetPages: 3 }
  ]
};

// Three pages of 570 words: three or four sections a chapter, so a three-section answer is kept whole.
const ranges: ChapterFormRange[] = plan.chapters.map((chapter, offset) => ({ chapter, startPage: offset * 3 + 1, endPage: offset * 3 + 3, words: 1710 }));

function scripted(replies: unknown[]) {
  const model = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  model.generateJson = async (options) => {
    calls.push(options);
    const reply = replies.shift();
    if (reply === undefined) throw new Error("Unexpected model call in test");
    return { data: options.schema.parse(reply), text: JSON.stringify(reply), model: "fixture", provider: "fixture" };
  };
  return { model, calls };
}

const system = (call: GenerateJsonOptions<unknown>) => call.messages.find((message) => message.role === "system")!.content;
const user = (call: GenerateJsonOptions<unknown>) => JSON.parse(call.messages.find((message) => message.role === "user")!.content) as Record<string, unknown>;

function section(form: string, heading: string, share: number, extra: Record<string, unknown> = {}) {
  return { form, heading, subject: `${heading} in full.`, share, owns: [heading], handoff: "", ...extra };
}

function chapterReply(chapterIndex: number, sections: unknown[]) {
  return { chapterIndex, throughLine: "What the reader gets.", sections, landing: `Answer ${chapterIndex}.`, avoid: [] };
}

const RUNNING_CASE = { name: "Maya", situation: "A freelance designer with uneven receipts.", figures: [{ label: "January receipts", value: "$4,200", year: "2026" }] };

describe("research leads", () => {
  it("is what planEpisodes asks of a toolkit book: facts for sentences, a setting, and never a scene", async () => {
    const { model, calls } = scripted([
      {
        setting: { country: "United States", currency: "USD", year: "2026" },
        chapters: [
          { index: 1, episodes: [{ title: "Share of adults with month-to-month income swings", kind: "scene", searchQueries: ["Fed SHED income volatility"] }] },
          { index: 2, episodes: [{ title: "2026 estimated-tax due dates", kind: "figure", searchQueries: ["IRS 1040-ES 2026"] }] },
          { index: 9, episodes: [{ title: "A chapter the plan does not have", kind: "figure" }] }
        ]
      }
    ]);
    const stance = { thesis: "t", positions: ["p", "q"], refusals: [], voiceSample: "v" };
    const result = await planEpisodes({ input, plan, stance, textModel: model, evidenceRequired: true });
    expect(result.setting).toEqual({ country: "United States", currency: "USD", year: "2026" });
    expect(result.episodes?.chapters.map((chapter) => chapter.index)).toEqual([1, 2]);
    // An unknown or scene kind is a document: a scene would open the chapter through composeScene.
    expect(result.episodes!.chapters[0]!.episodes[0]!.kind).toBe("document");
    expect(result.episodes!.chapters[1]!.episodes[0]!.kind).toBe("figure");
    expect(system(calls[0]!)).toContain("A research lead is one fact the chapter will use in a sentence");
    expect(system(calls[0]!)).not.toContain("filling the shoebox");
    expect(user(calls[0]!).outputContract).toMatchObject({ setting: { country: "" } });
  });

  it("dates the setting from the day it is planned", async () => {
    const { model, calls } = scripted([{ chapters: [{ index: 1, episodes: [] }] }]);
    const result = await planResearchLeads({ input, plan, textModel: model, today: "2026-10-01" });
    expect(user(calls[0]!).today).toBe("2026-10-01");
    expect(result.setting).toBeUndefined();
  });
});

describe("the toolkit form plan", () => {
  it("plans deliverables with headings against numbered requirements, and returns the toolkit and running case", async () => {
    const { model, calls } = scripted([
      {
        chapters: [
          chapterReply(1, [section("situation", "When the rent is due first", 0.15), section("worksheet", "The money snapshot", 0.6, { covers: ["R1"] }), section("exercise", "Name one unknown", 0.25)]),
          chapterReply(2, [section("tool", "The tax tracker", 0.55, { covers: ["R2"] }), section("situation", "A payment lands", 0.15), section("decision-rule", "Move the tax money", 0.3)]),
          chapterReply(3, [section("worksheet", "The price test", 0.6, { covers: ["R3"] }), section("script", "When the client pushes back", 0.25), section("worked-example", "Maya's rate", 0.15)])
        ],
        cast: [{ name: "Maya", role: "A freelance designer.", introducedIn: 1 }],
        runningCase: RUNNING_CASE,
        caveats: [{ text: "Check state rules with a tax professional.", chapterIndex: 2 }],
        rules: ["The buffer covers essential personal costs only."]
      }
    ]);
    const result = await planInstructionalForms({
      input, plan, ranges, requirements: ["A money snapshot worksheet", "A tax tracker", "A pricing worksheet"], exampleCast: "plan",
      setting: { country: "United States", year: "2026" }, textModel: model
    });
    const prompt = system(calls[0]!);
    expect(prompt).toContain("heading is the section's subheading");
    expect(prompt).toContain("Each figure, calculation and agreed outcome is owned by one section in the whole book");
    expect(prompt).toContain("This book is a workbook, carried by one running case.");
    expect(prompt).not.toContain("caseAssignments");
    const payload = user(calls[0]!);
    expect(payload.requirements).toEqual([
      { id: "R1", text: "A money snapshot worksheet" },
      { id: "R2", text: "A tax tracker" },
      { id: "R3", text: "A pricing worksheet" }
    ]);
    expect((payload.book as Record<string, unknown>).continuityRules).toEqual(plan.continuityRules);
    expect(result.source).toBe("model");
    expect(result.compositions[0]!.sections.map((entry) => entry.heading)).toEqual(["When the rent is due first", "The money snapshot", "Name one unknown"]);
    expect(result.cast).toEqual([{ name: "Maya", role: "A freelance designer.", introducedIn: 1 }]);
    expect(result.toolkit).toMatchObject({ kind: "workbook", setting: { country: "United States", year: "2026" }, runningCase: RUNNING_CASE, rules: ["The buffer covers essential personal costs only."] });
    expect(result.coverage).toEqual({ issues: [], homed: [], shared: [] });
  });

  it("keeps a chapter whose model section says share 0, and moves the long share off a situation", async () => {
    const { model } = scripted([
      {
        chapters: [
          chapterReply(1, [section("situation", "A long opening situation", 0.6), section("tool", "The checklist", 0.3), section("script", "The words", 0.1)]),
          chapterReply(2, [section("tool", "The tracker", 0.5), section("decision-rule", "The rule", 0.5), section("quiet-transition", "Onward", 0)]),
          chapterReply(3, [section("worksheet", "The price test", 0.6), section("script", "Pushback", 0.3), section("decision-rule", "The floor", 0.1)])
        ]
      }
    ]);
    const result = await planInstructionalForms({ input, plan, ranges, textModel: model });
    const [first, second] = result.compositions;
    expect(first!.sections.map((entry) => entry.form)).toEqual(["situation", "tool", "script"]);
    expect(first!.sections.map((entry) => entry.share!)).toEqual([expect.closeTo(0.3, 6), expect.closeTo(0.6, 6), expect.closeTo(0.1, 6)]);
    // The zero share is no share: the chapter keeps its planned sections, split evenly as a missing share always was.
    expect(second!.sections.map((entry) => entry.heading)).toEqual(["The tracker", "The rule", "Onward"]);
  });

  it("never rotates a deliverable away, and homes an uncovered requirement by code (there is no repair call)", async () => {
    const same = [section("tool", "The bank", 0.5), section("tool", "The template", 0.3), section("tool", "The checklist", 0.2)];
    const { model, calls } = scripted([
      { chapters: [chapterReply(1, same), chapterReply(2, same), chapterReply(3, same)] }
    ]);
    const result = await planInstructionalForms({ input, plan, ranges, requirements: ["A question bank", "A pricing worksheet"], textModel: model });
    expect(calls).toHaveLength(1);
    for (const composition of result.compositions) {
      expect(composition.sections.every((entry) => PINNED_FORMS.has(entry.form))).toBe(true);
    }
    expect(result.coverage?.homed).toHaveLength(2);
    expect(result.coverage?.issues).toEqual([]);
  });

  it("hands a stored toolkit back unchanged and plans against it", async () => {
    const stored: InstructionalToolkit = { kind: "workbook", setting: { country: "United States" }, runningCase: RUNNING_CASE, caveats: [{ text: "Stated once.", chapterIndex: 1 }], rules: [] };
    const { model, calls } = scripted([
      {
        chapters: [1, 2, 3].map((index) => chapterReply(index, [section("worksheet", `Sheet ${index}`, 0.6), section("script", `Script ${index}`, 0.3), section("decision-rule", `Rule ${index}`, 0.1)])),
        runningCase: { name: "Someone else", situation: "A different case entirely.", figures: [{ label: "x", value: "1" }] }
      }
    ]);
    const result = await planInstructionalForms({ input, plan, ranges, toolkit: stored, textModel: model });
    expect(result.toolkit).toBe(stored);
    expect(user(calls[0]!).toolkit).toEqual(stored);
    expect(system(calls[0]!)).toContain("toolkit is what the book's earlier chapters already fixed");
  });
});
