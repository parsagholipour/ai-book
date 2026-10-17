import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { repairQuickDraftPages } from "./quickDraftRepair.js";

const input = createProjectSchema.parse({ prompt: "Pip follows a cave map.", category: "KIDS", targetPages: 16 });
const pages = [
  { index: 5, title: "Map", markdown: "The map shows a cave.", summary: "The map." },
  { index: 15, title: "Clue", markdown: "Pip points to a shell.", summary: "A clue." },
  { index: 16, title: "Captain", markdown: "The captain checks the shell.", summary: "They agree." }
];
function setup(patches: unknown, verdict: unknown) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockImplementation(async <T>(request: GenerateJsonOptions<T>) => {
    const raw = request.purpose === "patch-page" ? patches : verdict;
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  });
  return { options: { input, plan: makeFallbackPlan(input), pages, targetPageIndexes: [15, 16],
    instruction: "Use the cave clue on both pages.", textModel }, generate };
}
const coordinated = { pages: [15, 16].map(pageIndex => ({ pageIndex, patches: [{ find: "shell", replace: "cave" }] })) };
const approved = { targetChecks: [15, 16].map(pageIndex => ({ pageIndex, resolved: true })), regressions: [] };

describe("focused repair candidate acceptance", () => {
  it("keeps the fake patch-page route in the grouped repair contract", async () => {
    const textModel = new FakeTextModelAdapter();
    const generate = vi.spyOn(textModel, "generateJson");
    await expect(repairQuickDraftPages({ input, plan: makeFallbackPlan(input), pages,
      targetPageIndexes: [15, 16], instruction: "Use the cave clue.", textModel }))
      .rejects.toThrow("No repair candidate was proposed.");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("checks the complete candidate before returning two linked patches", async () => {
    const { options, generate } = setup(coordinated, approved);
    const repaired = await repairQuickDraftPages(options);
    expect(repaired.map(p => p.markdown)).toEqual([pages[0]!.markdown, "Pip points to a cave.", "The captain checks the cave."]);
    expect(pages[1]!.markdown).toContain("shell");
    expect(generate.mock.calls.map(([request]) => request.purpose)).toEqual(["patch-page", "final-book-qa"]);
    const proposal = JSON.parse(generate.mock.calls[0]![0].messages[1]!.content);
    expect(proposal.pages.map((p: { index: number }) => p.index)).toEqual([15, 16]);
    expect(proposal.bookOutline).toEqual([{ index: 5, title: "Map", summary: "The map." }]);
    const review = JSON.parse(generate.mock.calls[1]![0].messages[1]!.content);
    expect(review.changedPages).toEqual([
      { index: 15, title: "Clue", original: "Pip points to a shell.", candidate: "Pip points to a cave." },
      { index: 16, title: "Captain", original: "The captain checks the shell.", candidate: "The captain checks the cave." }]);
    expect(review.contextPages).toEqual([]);
  });
  it("corrects a copied title once before checking the candidate, without treating the title as prose", async () => {
    const { options, generate } = setup(coordinated, approved);
    generate.mockImplementationOnce(async request => {
      const data = { pages: [{ pageIndex: 15, patches: [{ find: "Clue", replace: "Cave" }] }] };
      return { data: request.schema.parse(data), text: JSON.stringify(data), provider: "fixture", model: "fixture" };
    });
    const repaired = await repairQuickDraftPages(options);
    expect(repaired[1]!.title).toBe("Clue");
    expect(repaired[1]!.markdown).toBe("Pip points to a cave.");
    expect(generate.mock.calls.map(([request]) => request.purpose)).toEqual(["patch-page", "patch-page", "final-book-qa"]);
    expect(generate.mock.calls[1]![0].messages[0]!.content).toContain("not_found");
  });
  it("stops after one failed anchor correction and preserves every original page", async () => {
    const { options, generate } = setup({ pages: [{ pageIndex: 15, patches: [{ find: "Clue", replace: "Cave" }] }] }, approved);
    await expect(repairQuickDraftPages(options)).rejects.toThrow("not_found");
    expect(generate.mock.calls.map(([request]) => request.purpose)).toEqual(["patch-page", "patch-page"]);
    expect(options.pages).toEqual(pages);
  });
  it("reads the targets, their neighbours and the pages the findings cite on a 100-page book, never all of it", async () => {
    const { options, generate } = setup(coordinated, approved);
    const longPages = Array.from({ length: 100 }, (_, i) => {
      const original = pages.find(page => page.index === i + 1);
      return { index: i + 1, title: `Page ${i + 1}`, summary: "Context.",
        markdown: `${original?.markdown ?? (i + 1 === 60 ? "The Ledger of Ashfall names the cave." : "Complete context.")}\n${"A complete technical explanation. ".repeat(105)}` };
    });
    const findings = [{ targets: [15, 16], kind: "contradiction", problem: "The clue changes.", fix: "Use the cave clue.",
      evidence: [{ pageIndex: 15, quote: "shell" }, { pageIndex: 40, quote: "Complete context." }] }];
    const repaired = await repairQuickDraftPages({ ...options, pages: longPages, findings });
    expect(repaired).toHaveLength(100);
    expect(repaired[99]).toEqual(longPages[99]);
    expect(repaired[14]!.markdown).toContain("Pip points to a cave.");
    const proposal = JSON.parse(generate.mock.calls[0]![0].messages[1]!.content);
    expect(proposal.pages.map((p: { index: number }) => p.index)).toEqual([14, 15, 16, 17, 40]);
    expect(proposal.bookOutline).toHaveLength(95);
    expect(proposal.findings[0]).toMatchObject({ repairPages: [15, 16], problem: "The clue changes." });
    const review = JSON.parse(generate.mock.calls[1]![0].messages[1]!.content);
    expect(review.contextPages.map((p: { index: number }) => p.index)).toEqual([14, 17, 40]);
    const bookSize = JSON.stringify(longPages).length;
    for (const [request] of generate.mock.calls) expect(request.messages[1]!.content.length).toBeLessThan(bookSize / 4);
  });
  it("shows the verifier every unchanged page that repeats a name the repair changed", async () => {
    const book = [
      { index: 1, title: "One", markdown: "Mara keeps the Ledger of Ashfall.", summary: "Ledger." },
      { index: 2, title: "Two", markdown: "Mara opens the Ledger of Ashfall.", summary: "Ledger." },
      { index: 3, title: "Three", markdown: "Rain on the river.", summary: "Rain." },
      { index: 4, title: "Four", markdown: "Rain again.", summary: "Rain." },
      { index: 5, title: "Five", markdown: "The Ledger of Ashfall burns.", summary: "Fire." }
    ];
    const { options, generate } = setup({ pages: [{ pageIndex: 2, patches: [{ find: "Ledger of Ashfall", replace: "Book of Ashfall" }] }] },
      { targetChecks: [{ pageIndex: 2, resolved: true }], regressions: [] });
    await repairQuickDraftPages({ ...options, pages: book, targetPageIndexes: [2] });
    const review = JSON.parse(generate.mock.calls[1]![0].messages[1]!.content);
    expect(review.contextPages.map((p: { index: number }) => p.index)).toEqual([1, 3, 5]);
  });
  it("re-asks once when a patch touches a figure the finding is not about, then keeps the page", async () => {
    const chart = '```figure\n{"kind":"bar","title":"Costs","categories":["A","B"],"series":[{"name":"Dollars","values":[3,4]}],"source":"Notes"}\n```';
    const figurePages = [{ index: 15, title: "Clue", markdown: `Pip points to a shell.\n\n${chart}`, summary: "A clue." }];
    const { options, generate } = setup({ pages: [{ pageIndex: 15, patches: [{ find: "[3,4]", replace: "[3,5]" }] }] },
      { targetChecks: [{ pageIndex: 15, resolved: true }], regressions: [] });
    await expect(repairQuickDraftPages({ ...options, pages: figurePages, targetPageIndexes: [15] })).rejects.toThrow("figure_changed");
    const proposal = JSON.parse(generate.mock.calls[0]![0].messages[1]!.content);
    expect(proposal.pages[0].markdown).toBe("Pip points to a shell.\n\n[Figure: Costs]");
    expect(generate.mock.calls.map(([request]) => request.purpose)).toEqual(["patch-page", "patch-page"]);
  });
  it("rejects the whole candidate when a linked page remains inconsistent", async () => {
    const { options } = setup({ pages: [coordinated.pages[0]] }, {
      targetChecks: [{ pageIndex: 15, resolved: true }, { pageIndex: 16, resolved: false }], regressions: [] });
    await expect(repairQuickDraftPages(options)).rejects.toThrow("unresolved");
  });
  it("rejects a patch that removes production notes but duplicates a paragraph", async () => {
    const paragraph = "The agreement names an owner and a date so both people can check the result at their next meeting.";
    const { options, generate } = setup({ pages: [{ pageIndex: 15, patches: [{ find: "DRAFT NOTE", replace: paragraph }] }] }, {
      targetChecks: [{ pageIndex: 15, resolved: true }], regressions: [{ pageIndex: 15, reason: "A paragraph is now printed twice.", quote: paragraph }] });
    await expect(repairQuickDraftPages({ ...options, targetPageIndexes: [15],
      pages: [{ ...pages[1]!, markdown: `${paragraph}\n\nDRAFT NOTE` }] })).rejects.toThrow("printed twice");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("refuses edits to evidence-only pages before paying for acceptance", async () => {
    const { options, generate } = setup({ pages: [{ pageIndex: 5, patches: [{ find: "cave", replace: "shell" }] }] }, approved);
    await expect(repairQuickDraftPages(options)).rejects.toThrow("scope");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("does not accept incomplete review coverage or a failed reviewer", async () => {
    const { options } = setup(coordinated, { targetChecks: [{ pageIndex: 15, resolved: true }], regressions: [] });
    await expect(repairQuickDraftPages(options)).rejects.toThrow("cover");
    const failed = setup(coordinated, { broken: true });
    await expect(repairQuickDraftPages(failed.options)).rejects.toThrow();
    expect(failed.generate).toHaveBeenCalledTimes(2);
  });
});
