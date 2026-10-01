import { describe, expect, it } from "vitest";
import type { CreateProjectInput } from "../schemas/book.js";
import { instructionalToolkitSchema, type InstructionalToolkit } from "../schemas/instructional.js";
import {
  activeToolkit,
  deliverableCarriesLength,
  homeUncoveredRequirements,
  requirementCoverageIssues,
  requirementRefs,
  sharedRequirements,
  toolkitBookKind,
  toolkitFrom,
  toolkitPayload,
  toolkitWriterLines,
  usesToolkit,
  type ToolkitComposition
} from "./instructionalBook.js";

function book(category: CreateProjectInput["category"], mobile: Record<string, unknown> | undefined, prompt = "Create a practical guide to running one-on-ones."): CreateProjectInput {
  return {
    prompt,
    category,
    targetPages: 24,
    complexity: 4,
    temperature: 0.65,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "manual",
      includeCover: false,
      coverTemplate: "business",
      finalReview: false,
      toneProfile: "confident",
      ...(mobile ? { mobile } : {})
    }
  } as CreateProjectInput;
}

const plan = { title: "One-on-Ones That Work", premise: "A guide for new managers.", audience: "New managers" };

describe("the toolkit path is the reader's book type, never the category", () => {
  it("resolves a chosen practical guide or workbook, and an auto choice by the lane the advisor resolved", () => {
    expect(toolkitBookKind(book("BUSINESS", { bookTypeChoice: "practical_guide" }))).toBe("guide");
    expect(toolkitBookKind(book("EDUCATION", { bookTypeChoice: "workbook" }))).toBe("workbook");
    expect(toolkitBookKind(book("BUSINESS", { bookTypeChoice: "auto", detectedLane: "practical_guide" }))).toBe("guide");
    expect(toolkitBookKind(book("EDUCATION", { bookTypeChoice: "auto", detectedLane: "auto", recipe: { lane: "workbook" } }))).toBe("workbook");
    expect(toolkitBookKind(book("BUSINESS", { detectedLane: "workbook" }))).toBe("workbook");
  });

  it("takes no other book type, and no book the reader did not type", () => {
    for (const choice of ["lead_magnet", "offer_guide", "client_tool", "short_story", "adult_story", "children_story"]) {
      expect(toolkitBookKind(book("BUSINESS", { bookTypeChoice: choice, detectedLane: "practical_guide" }))).toBeUndefined();
    }
    expect(toolkitBookKind(book("BUSINESS", { bookTypeChoice: "auto", detectedLane: "lead_magnet" }))).toBeUndefined();
    expect(toolkitBookKind(book("BUSINESS", undefined))).toBeUndefined();
  });

  it("never gives a business history the toolkit, though Business makes it instructional by category", () => {
    const history = book("BUSINESS", { bookTypeChoice: "lead_magnet" }, "A history of Nokia from rubber boots to phones.");
    expect(usesToolkit(history, { title: "Nokia", premise: "How Nokia rose and fell.", audience: "Readers" })).toBe(false);
    expect(usesToolkit(book("BUSINESS", undefined, "The history of the Hudson's Bay Company."), plan)).toBe(false);
    const toolkit = instructionalToolkitSchema.parse({ kind: "guide" });
    expect(activeToolkit(history, plan, toolkit)).toBeUndefined();
  });

  it("needs an instructional book as well: a chosen guide written as a story stays a story", () => {
    expect(usesToolkit(book("BUSINESS", { bookTypeChoice: "practical_guide" }), plan)).toBe(true);
    expect(usesToolkit(book("STORY", { bookTypeChoice: "practical_guide" }), plan)).toBe(false);
    expect(usesToolkit(book("BUSINESS", { bookTypeChoice: "practical_guide" }), { ...plan, authorStance: { thesis: "t", positions: [], refusals: [], voiceSample: "v", research: "none" } })).toBe(false);
  });
});

describe("the brief's asks each have a home before any prose", () => {
  const requirements = requirementRefs(["A question bank", "A one-page template", "Include worksheets"]);
  const compositions: ToolkitComposition[] = [
    { chapterIndex: 1, sections: [{ form: "situation", subject: "A status meeting", owns: ["Maya"], covers: ["R3"] }, { form: "tool", subject: "Thirty questions sorted by purpose", owns: ["The question bank"], covers: ["R1"] }] },
    { chapterIndex: 2, sections: [{ form: "worksheet", subject: "The agenda worksheet", owns: [], covers: ["R3"] }, { form: "tool", subject: "A one-page meeting and follow-up template", heading: "The one-page template", owns: [] }] }
  ];

  it("names what no section covers, and counts a general ask met in two chapters as shared, not missing", () => {
    expect(requirements.map((entry) => entry.id)).toEqual(["R1", "R2", "R3"]);
    expect(requirementCoverageIssues(compositions, requirements)).toEqual(["Requirement R2 (A one-page template) is covered by no section; give it one."]);
    expect(sharedRequirements(compositions, requirements)).toEqual(["R3 in chapters 1, 2"]);
  });

  it("homes an uncovered ask in the section whose words it shares, and says where", () => {
    const chapters = [
      { index: 1, title: "Make the meeting matter", summary: "Purpose", keyBeats: [] },
      { index: 2, title: "Close the loop", summary: "Follow-ups and a template", keyBeats: ["Provide a one-page template"] }
    ];
    const { compositions: homed, homed: notes } = homeUncoveredRequirements(compositions, requirements, chapters);
    expect(notes).toEqual(["R2 → chapter 2, section 2"]);
    expect(homed[1]!.sections[1]!.covers).toEqual(["R2"]);
    expect(homed[1]!.sections[1]!.owns).toContain("A one-page template");
    expect(requirementCoverageIssues(homed, requirements)).toEqual([]);
    // The input is left as it was.
    expect(compositions[1]!.sections[1]!.covers).toBeUndefined();
  });
});

describe("a chapter's long section is a deliverable", () => {
  it("moves the long share off an opening situation onto the largest deliverable, and leaves everything else", () => {
    const chapter: ToolkitComposition = {
      chapterIndex: 5,
      sections: [
        { form: "situation", subject: "Ben misses a second handoff", owns: [], share: 0.43 },
        { form: "script", subject: "Opening the conversation", owns: [], share: 0.18 },
        { form: "decision-rule", subject: "When disagreement does not settle it", owns: [], share: 0.12 },
        { form: "worksheet", subject: "The follow-through plan", owns: [], share: 0.27 }
      ]
    };
    const [moved] = deliverableCarriesLength([chapter]);
    expect(moved!.sections.map((section) => section.share)).toEqual([0.27, 0.18, 0.12, 0.43]);
    expect(moved!.sections.map((section) => section.form)).toEqual(["situation", "script", "decision-rule", "worksheet"]);
  });

  it("changes nothing when a deliverable already carries it, or when no deliverable is there to take it", () => {
    const already: ToolkitComposition = { chapterIndex: 1, sections: [{ form: "tool", subject: "Bank", owns: [], share: 0.5 }, { form: "situation", subject: "S", owns: [], share: 0.5 }] };
    expect(deliverableCarriesLength([already])[0]!.sections.map((section) => section.share)).toEqual([0.5, 0.5]);
    const none: ToolkitComposition = { chapterIndex: 1, sections: [{ form: "situation", subject: "S", owns: [], share: 0.6 }, { form: "decision-rule", subject: "R", owns: [], share: 0.4 }] };
    expect(deliverableCarriesLength([none])[0]!.sections.map((section) => section.share)).toEqual([0.6, 0.4]);
  });
});

describe("the toolkit a plan stores", () => {
  it("clips a long running-case value instead of losing the running case, and keeps each figure's year", () => {
    const toolkit = toolkitFrom(
      {
        runningCase: {
          name: "Maya",
          situation: "A freelance designer with uneven receipts.",
          figures: [
            { label: "Monthly receipts, January to December", value: "$4,200; $5,100; $2,800; $6,000; $3,900; $4,700; $3,200; $5,500; $4,100; $2,600; $4,900; $3,600; ".repeat(4), year: 2026 },
            { label: "Self-employment tax rate", value: "15.3%", year: "2026" }
          ]
        },
        caveats: [{ text: "Check state rules with a tax professional.", chapterIndex: 3 }, { text: "A caveat for a chapter that is not there.", chapterIndex: 9 }],
        rules: ["The agenda is 25 minutes.", 42]
      },
      "workbook",
      { country: "United States", currency: "USD", year: "2026" },
      [1, 2, 3]
    );
    expect(toolkit.runningCase?.figures).toHaveLength(2);
    expect(toolkit.runningCase!.figures[0]!.value.length).toBeLessThanOrEqual(240);
    expect(toolkit.runningCase!.figures[0]!.year).toBe("2026");
    expect(toolkit.caveats).toEqual([{ text: "Check state rules with a tax professional.", chapterIndex: 3 }]);
    expect(toolkit.rules).toEqual(["The agenda is 25 minutes."]);
    expect(instructionalToolkitSchema.safeParse(toolkit).success).toBe(true);
  });

  it("keeps no running case for a guide", () => {
    expect(toolkitFrom({ runningCase: { name: "A", situation: "B situation", figures: [{ label: "x", value: "1" }] } }, "guide", undefined, [1]).runningCase).toBeUndefined();
  });

  it("hands a chapter only the cautions it was given, and states the country once for all of them", () => {
    const toolkit: InstructionalToolkit = {
      kind: "workbook",
      setting: { country: "the United States", currency: "USD", year: "2026" },
      caveats: [{ text: "Check state tax rules.", chapterIndex: 3 }],
      rules: []
    };
    expect(toolkitPayload(toolkit, 3)).toMatchObject({ cautions: ["Check state tax rules."] });
    expect(toolkitPayload(toolkit, 4)).not.toHaveProperty("cautions");
    expect(toolkitWriterLines(toolkit, 3).join(" ")).toContain("the one that applies in the United States, for 2026, amounts in USD");
    expect(toolkitWriterLines(toolkit, 4).join(" ")).not.toContain("cautions are the warnings");
    expect(toolkitWriterLines(undefined, 1)).toEqual([]);
  });
});
