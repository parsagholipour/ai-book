import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewQuickDraftManuscript } from "./quickDraftReview.js";
import { reviewQuickDraftPageLocally } from "./pagesLocalQa.js";
import { containsPromptLeak, MANUSCRIPT_PROMPT_LEAK_PATTERNS, PAGE_PROMPT_LEAK_PATTERNS } from "./promptLeak.js";

const input = createProjectSchema.parse({ prompt: "A business workbook.", category: "BUSINESS", targetPages: 6,
  mediaSettings: { modelTier: "fast" } });
const plan = makeFallbackPlan(input);
const pages = [{ index: 1, title: "Budget", markdown: "We spend 20 on rent and 30 on supplies." },
  { index: 4, title: "Total", markdown: "The total is 60." }];
function setup(raw: unknown = { findings: [] }) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(request: GenerateJsonOptions<T>) =>
    ({ data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" }));
  return { options: { input, plan, pages, textModel }, generate };
}

describe("Quick Draft manuscript screen", () => {
  it("reads every page's actual prose in one call and accepts a clean screen", async () => {
    const { options, generate } = setup();
    expect((await reviewQuickDraftManuscript(options)).approved).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(generate.mock.calls[0]![0].messages[1]!.content).pages).toEqual(pages);
    expect(generate.mock.calls[0]![0].purpose).toBe("final-book-qa");
  });

  const arithmetic = { pageIndex: 4, kind: "arithmetic", problem: "20 + 30 is 50, not 60.", fix: "Change the total to 50.",
    evidence: [{ pageIndex: 4, quote: "The total is 60." }, { pageIndex: 1, quote: pages[0]!.markdown }] };
  it("turns a quoted arithmetic defect into a targeted repair", async () => {
    const { options } = setup({ findings: [arithmetic] });
    expect(await reviewQuickDraftManuscript(options)).toMatchObject({ approved: false,
      issues: ["Page 4: 20 + 30 is 50, not 60."], requiredFixes: ["Page 4: Change the total to 50."] });
  });
  it("retains a grounded arithmetic fix when another finding misquotes its evidence", async () => {
    const { options } = setup({ findings: [arithmetic, { ...arithmetic, pageIndex: 1,
      evidence: [{ pageIndex: 1, quote: "A paraphrase, not the actual sentence." }] }] });
    const result = await reviewQuickDraftManuscript(options);
    expect(result.approved).toBe(false);
    expect(result.requiredFixes).toContain("Page 4: Change the total to 50.");
    expect(result).toMatchObject({ focusedReview: { rejectedFindings: 1 } });
  });
  it("accepts five exact passages proving a multi-page contradiction", async () => {
    const quotes = ["The first copy is white.", "The second copy is brown.", "The third copy is blue.",
      "Ilyan takes the brown second copy.", "The courier takes the second copy too."];
    const { options } = setup({ findings: [{ ...arithmetic, pageIndex: 5, kind: "contradiction",
      evidence: quotes.map((quote, i) => ({ pageIndex: i + 1, quote })) }] });
    const result = await reviewQuickDraftManuscript({ ...options,
      pages: quotes.map((markdown, i) => ({ index: i + 1, title: "Copies", markdown })) });
    expect(result.issues).toHaveLength(1);
    expect(result).toMatchObject({ focusedReview: { rejectedFindings: 0 } });
  });
  it("keeps linked repair pages together without authorizing unrelated evidence pages", async () => {
    const { options } = setup({ findings: [{ pageIndex: 15, repairPageIndexes: [15, 16], kind: "contradiction",
      problem: "The shell clue contradicts the cave map.", fix: "Use the cave clue on both pages.",
      evidence: [{ pageIndex: 5, quote: "The map shows a cave." }, { pageIndex: 15, quote: "Pip points to a shell." },
        { pageIndex: 16, quote: "The captain checks the shell." }] }] });
    const result = await reviewQuickDraftManuscript({ ...options, pages: [
      { index: 5, title: "Map", markdown: "The map shows a cave." },
      { index: 15, title: "Clue", markdown: "Pip points to a shell." },
      { index: 16, title: "Captain", markdown: "The captain checks the shell." }
    ] });
    expect(result).toMatchObject({ focusedReview: { repairGroups: [[15, 16]] } });
    expect(result.requiredFixes).toEqual(["Page 15: Use the cave clue on both pages.", "Page 16: Use the cave clue on both pages."]);
  });
  it.each([
    { ...arithmetic, pageIndex: 99 },
    { ...arithmetic, evidence: [{ pageIndex: 4, quote: "Invented quote." }] },
    { ...arithmetic, kind: "contradiction", evidence: [arithmetic.evidence[0]] }
  ])("flags ungrounded findings instead of publishing a clean verdict", async (finding) => {
    const { options, generate } = setup({ findings: [finding] });
    expect(await reviewQuickDraftManuscript(options)).toMatchObject({ approved: false, issues: [], requiredFixes: [],
      focusedReview: { rejectedFindings: 1, repairGroups: [] } });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("reports an oversized manuscript as unavailable without grading a truncated book", async () => {
    const { options, generate } = setup();
    await expect(reviewQuickDraftManuscript({ ...options, pages: [{ ...pages[0]!, markdown: "x".repeat(1_000_001) }] }))
      .rejects.toThrow("input budget");
    expect(generate).not.toHaveBeenCalled();
  });
  it("screens all 100 adult pages without dropping the last chapter", async () => {
    const longPages = Array.from({ length: 100 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`,
      markdown: `${"A complete technical explanation. ".repeat(105)}End of page ${i + 1}.` }));
    const { options, generate } = setup();
    await expect(reviewQuickDraftManuscript({ ...options, pages: longPages })).resolves.toMatchObject({ approved: true });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(generate.mock.calls[0]![0].messages[1]!.content).pages).toEqual(longPages);
  });
  it("grounds equivalent math delimiters without splitting a linked arithmetic repair", async () => {
    const { options } = setup({ findings: [{ pageIndex: 18, repairPageIndexes: [18, 19], kind: "arithmetic",
      problem: "The remainder and shared value disagree.", fix: "Correct both steps together.",
      evidence: [{ pageIndex: 18, quote: "The remainder is \\(25\\)." },
        { pageIndex: 19, quote: "Alice computes modulo \\(41\\)." }] }] });
    expect(await reviewQuickDraftManuscript({ ...options, pages: [
      { index: 18, title: "Exchange", markdown: "The remainder is \\(25\\)." },
      { index: 19, title: "Result", markdown: "Alice computes modulo 41." }
    ] })).toMatchObject({ focusedReview: { rejectedFindings: 0, repairGroups: [[18, 19]] } });
  });
  it("preserves rejected dependency scopes so a valid sibling cannot authorize half a repair", async () => {
    const linked = { ...arithmetic, pageIndex: 1, repairPageIndexes: [1, 4],
      evidence: [{ pageIndex: 1, quote: "Invented wording." }, { pageIndex: 4, quote: "The total is 60." }] };
    const { options } = setup({ findings: [linked, arithmetic] });
    expect(await reviewQuickDraftManuscript(options)).toMatchObject({
      requiredFixes: ["Page 4: Change the total to 50."],
      focusedReview: { rejectedFindings: 1, unverifiedRepairPageIndexes: [1, 4], repairGroups: [[4]] }
    });
  });
});

describe("Quick Draft local integrity", () => {
  function review(markdown: string) {
    return reviewQuickDraftPageLocally({ input, plan, pageIndex: 2, draft: { title: "Budget", markdown,
      summary: "Budget", continuityNotes: [] }, previousPages: [{ ...pages[0]!, summary: "Budget" }],
      continuityNotes: [], textModel: new FakeTextModelAdapter() });
  }
  it("does not turn short prose, shared titles or style preferences into repairs", () => {
    expect(review("In this chapter, we consider an alternative.").approved).toBe(true);
  });
  it("keeps placeholder and leaked-note checks", () => {
    expect(review("This is a placeholder page.").approved).toBe(false);
    expect(review("We need output only prose, no meta.").checks.promptLeakFree).toBe(false);
  });
  it.each([
    "(The final sentence is the chapter end; no extra material.)",
    "Wait target 1720-2560, this is ~1600? Need expand to 1720 min.",
    "We need output only prose, no meta."
  ])("catches experiment drafting notes in both page and manuscript checks: %s", (text) => {
    expect(containsPromptLeak(text, PAGE_PROMPT_LEAK_PATTERNS)).toBe(true);
    expect(containsPromptLeak(text, MANUSCRIPT_PROMPT_LEAK_PATTERNS)).toBe(true);
  });
  it("allows ordinary research notes while retaining supplied-packet detection", () => {
    expect(containsPromptLeak("The research notes are filed in the shared folder.", PAGE_PROMPT_LEAK_PATTERNS)).toBe(false);
    expect(containsPromptLeak("According to the supplied research notes, revenue doubled.", PAGE_PROMPT_LEAK_PATTERNS)).toBe(true);
  });
});
