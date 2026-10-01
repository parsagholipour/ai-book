import { describe, expect, it, vi } from "vitest";

import { draftTextEditCandidates, replacementFacts, type TextEditCandidate, type TextEditSourcePage } from "./textEditCandidates.js";

function sourcePage(index: number, markdown: string, title = `Page ${index}`): TextEditSourcePage {
  return {
    id: `page-${index}`,
    index,
    title,
    markdown,
    summary: `Summary ${index}`,
    imagePrompt: null,
    qualityReport: null,
    revision: 1,
    storyDelta: null,
    chapterId: null
  };
}

function changed(page: TextEditSourcePage, markdown: string): TextEditCandidate {
  return {
    page,
    tier: "patch",
    updated: {
      title: page.title,
      markdown,
      summary: page.summary,
      continuityNotes: [],
      qualityReport: {
        approved: true, score: 90, issues: [], requiredRevisions: [], notes: "", groundedOk: true, unsupportedClaims: [],
        checks: { placeholderFree: true, promptLeakFree: true, titleClean: true, repetitionOk: true, progressionOk: true, styleNatural: true }
      }
    }
  };
}

// The router's own wording of the 2026-10-01 word swap: quoted terms, then more.
const ROUTER_INSTRUCTION =
  'Replace every occurrence of the word "tray" with "saucer" throughout the entire book, including plural forms ("trays" → "saucers"). Keep all other wording, meaning, and formatting unchanged.';

describe("what code tells the adherence reviewer about a model-performed swap", () => {
  const pages = [sourcePage(1, "A tray under the pot."), sourcePage(2, "Water drains away."), sourcePage(3, "Empty the trays.")];

  it("says the old term is gone from every page, the untouched ones included", () => {
    const candidates = new Map([
      [1, changed(pages[0]!, "A saucer under the pot.")],
      [3, changed(pages[2]!, "Empty the saucers.")]
    ]);
    const facts = replacementFacts({ editInstruction: ROUTER_INSTRUCTION, pages, bookPageCount: 3 }, candidates);
    expect(facts).toEqual([expect.stringContaining("every page of the book (3)")]);
    expect(facts[0]).toContain("no whole-word “tray” remains");
    // Not the whole book: the fact says only what it searched.
    expect(replacementFacts({ editInstruction: ROUTER_INSTRUCTION, pages, bookPageCount: 12 }, candidates)[0]).toContain(
      "all 3 pages this edit covers"
    );
  });

  it("reports a term still present as plainly, since that is real evidence", () => {
    const candidates = new Map([[1, changed(pages[0]!, "A saucer under the pot.")]]);
    expect(replacementFacts({ editInstruction: ROUTER_INSTRUCTION, pages, bookPageCount: 3 }, candidates)).toEqual([
      "Code found whole-word “tray” still in the edited text of page 3."
    ]);
  });

  it("says nothing about an instruction that names no replacement", () => {
    expect(replacementFacts({ editInstruction: "Make every page warmer.", pages }, new Map())).toEqual([]);
  });
});

describe("the verified word swap the reader approved", () => {
  it("rewrites the plural the preview showed, though the queue payload carries only the terms", async () => {
    const generateJson = vi.fn(async () => {
      throw new Error("An exact swap never calls a model.");
    });
    const result = await draftTextEditCandidates({
      projectId: "project-1",
      pages: [sourcePage(1, "Tray first. Two trays and an ashtray.")],
      input: {} as never,
      plan: {} as never,
      strategy: {} as never,
      providers: { text: { generateJson } } as never,
      editInstruction: "Replace the word tray with saucer everywhere in the book",
      // What `jobPayloads` hands over: its schema keeps from, to and preserveCase.
      exactReplacement: { from: "tray", to: "saucer" },
      mode: "exact",
      quality: {} as never
    });
    expect(result.satisfied).toBe(true);
    expect(result.candidates[0]?.updated.markdown).toBe("Saucer first. Two saucers and an ashtray.");
    expect(generateJson).not.toHaveBeenCalled();
  });
});
