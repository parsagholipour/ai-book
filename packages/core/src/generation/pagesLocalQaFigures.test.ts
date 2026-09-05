import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { runLocalFinalQa } from "./pagesFinalLocalQa.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";

/**
 * The local checks read a page's prose and never its figure block; kept apart
 * from `pagesLocalQa.test.ts`, which is at the file-size budget.
 */
const input: CreateProjectInput = {
  prompt: "A practical history of city water systems and home filtration.",
  category: "EDUCATION",
  targetPages: 12,
  complexity: 6,
  temperature: 0.4,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "scholarly"
  }
};

describe("figure blocks in the local checks", () => {
  it("reads a page the same with and without its figure", () => {
    const prose = Array.from(
      { length: 6 },
      (_, index) =>
        `The clerks counted the carts at the north gate in ${1500 + index * 10}, and the ledger they kept still names every carrier who paid the toll and every one who argued about it.`
    ).join(" ");
    const fence =
      "```figure\n" +
      JSON.stringify({ kind: "bar", title: "Carts by decade", categories: ["1500", "1510"], series: [{ name: "Carts", values: [120, 140] }], source: "The gate ledger" }) +
      "\n```";
    const review = (markdown: string) =>
      reviewPageDraftLocally({
        input,
        plan: makeFallbackPlan(input),
        pageIndex: 3,
        draft: { title: "The North Gate", markdown, summary: "The carts and their tolls.", continuityNotes: [] },
        previousPages: [],
        continuityNotes: []
      });
    expect(review(`${prose}\n\n${fence}\n\n${prose}`)).toEqual(review(`${prose}\n\n${prose}`));
  });

  it("does not read a figure's caption or source as the final page's ending", () => {
    const prose = Array.from(
      { length: 6 },
      // No resolution word anywhere in the prose, so a vague signal alone would fail the page.
      (_, index) => `The filter plant at the river bend took its first water in ${1900 + index * 5}, and the ledger of its intake still names every clerk who paid for the sand.`
    ).join(" ");
    // Every phrase the vague-ending rule fires on, and no resolution word anywhere.
    const fence =
      "```figure\n" +
      JSON.stringify({
        kind: "line",
        title: "Into the unknown",
        categories: ["1900", "1910"],
        series: [{ name: "Intake", values: [12, 40] }],
        source: "What came next: the beginning of the record",
        caption: "Nothing, then everything; not the end."
      }) +
      "\n```";
    const review = (markdown: string) =>
      reviewPageDraftLocally({
        input,
        plan: makeFallbackPlan(input),
        pageIndex: input.targetPages,
        draft: { title: "The Last Plant", markdown, summary: "The plant and its ledger.", continuityNotes: [] },
        previousPages: [],
        continuityNotes: []
      });
    const withFigure = review(`${prose}\n\n${fence}\n\n${prose}`);
    expect(withFigure.issues).not.toContain("Final page ending is too vague to resolve the book's central promise.");
    expect(withFigure).toEqual(review(`${prose}\n\n${prose}`));
    // The rule itself still reads the prose.
    expect(review(`${prose}\n\nAnd so they walked into the unknown.`).issues).toContain(
      "Final page ending is too vague to resolve the book's central promise."
    );
  });

  it("does not treat a previous page's figure labels as repeated prose", () => {
    const currentProse = Array.from(
      { length: 6 },
      (_, index) =>
        `The clerks counted the carts at the north gate in ${1500 + index * 10}, and the ledger they kept still names every carrier who paid the toll and every one who argued about it.`
    ).join(" ");
    const previousProse = Array.from(
      { length: 6 },
      (_, index) =>
        `The mill office smelled of oil and old paper, and the winter of ${1911 + index} still sits in three different hands on the desk beside the lamp.`
    ).join(" ");
    // Categories, series and title copy the current page's words, so a
    // fence-blind scorer must not read this JSON as the earlier page's body.
    const fence =
      "```figure\n" +
      JSON.stringify({
        kind: "bar",
        title: currentProse,
        categories: currentProse.split(". ").filter(Boolean),
        series: [{ name: currentProse, values: [120, 140, 160, 180, 200, 220] }],
        source: currentProse
      }) +
      "\n```";
    const previousPage = {
      index: 2,
      title: "The Mill Ledger",
      markdown: `${previousProse}\n\n${fence}`,
      summary: "The mill office and its winter lamp."
    };
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: 3,
      draft: { title: "The North Gate", markdown: currentProse, summary: "The carts and their tolls.", continuityNotes: [] },
      previousPages: [previousPage],
      continuityNotes: []
    });
    expect(report.checks.repetitionOk).toBe(true);
    expect(report.issues.join(" ")).not.toMatch(/repeats or substantially overlaps/);

    const finalIssues = runLocalFinalQa(
      { ...input, targetPages: 2 },
      [
        { ...previousPage, index: 1 },
        { index: 2, title: "The North Gate", markdown: currentProse, summary: "The carts and their tolls." }
      ]
    );
    expect(finalIssues.join(" ")).not.toMatch(/repeats or substantially overlaps/);
  });

  it("still rejects two pages whose prose is near-verbatim", () => {
    const prose = Array.from(
      { length: 6 },
      (_, index) =>
        `The clerks counted the carts at the north gate in ${1500 + index * 10}, and the ledger they kept still names every carrier who paid the toll and every one who argued about it.`
    ).join(" ");
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: 3,
      draft: { title: "The North Gate", markdown: prose, summary: "The carts and their tolls.", continuityNotes: [] },
      previousPages: [
        { index: 2, title: "The Mill Ledger", markdown: prose, summary: "The mill office and its winter lamp." }
      ],
      continuityNotes: []
    });
    expect(report.checks.repetitionOk).toBe(false);
    expect(report.issues.join(" ")).toMatch(/repeats or substantially overlaps the beat from page 2/);

    const finalIssues = runLocalFinalQa(
      { ...input, targetPages: 2 },
      [
        { index: 1, title: "The Mill Ledger", markdown: prose, summary: "The mill office and its winter lamp." },
        { index: 2, title: "The North Gate", markdown: prose, summary: "The carts and their tolls." }
      ]
    );
    expect(finalIssues.join(" ")).toMatch(/Page 2:.*repeats or substantially overlaps the beat from page 1/);
  });

  it("does not read a figure caption leaked into the summary as the final page's ending", () => {
    const prose = Array.from(
      { length: 6 },
      // No vague-ending phrase in the prose; the summary below would fail the
      // rule if scored as the page's own words.
      (_, index) =>
        `The filter plant at the river bend took its first water in ${1900 + index * 5}, and the ledger of its intake still names every clerk who paid for the sand.`
    ).join(" ");
    const leakedSummary =
      "```figure\n" +
      JSON.stringify({
        kind: "line",
        title: "Into the unknown",
        categories: ["1900", "1910"],
        series: [{ name: "Intake", values: [12, 40] }],
        source: "What came next: the beginning of the record",
        caption: "Nothing, then everything; not the end."
      }) +
      "\n```";
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: input.targetPages,
      draft: { title: "The Last Plant", markdown: prose, summary: leakedSummary, continuityNotes: [] },
      previousPages: [],
      continuityNotes: []
    });
    expect(report.issues).not.toContain("Final page ending is too vague to resolve the book's central promise.");
  });

  it("does not treat figure JSON in a summary as repeated prose", () => {
    const currentProse = Array.from(
      { length: 6 },
      (_, index) =>
        `The clerks counted the carts at the north gate in ${1500 + index * 10}, and the ledger they kept still names every carrier who paid the toll and every one who argued about it.`
    ).join(" ");
    const previousProse = Array.from(
      { length: 6 },
      (_, index) =>
        `The mill office smelled of oil and old paper, and the winter of ${1911 + index} still sits in three different hands on the desk beside the lamp.`
    ).join(" ");
    // Identical `"kind"` / `categories` JSON in both summaries would look like
    // overlap if the fence were scored as the page's beat.
    const leakedSummary =
      "```figure\n" +
      JSON.stringify({
        kind: "bar",
        title: "Carts by decade",
        categories: ["kind", "categories", "series", "1500", "1510"],
        series: [{ name: "Carts", values: [120, 140, 160, 180, 200, 220] }],
        source: "The gate ledger"
      }) +
      "\n```";
    const previousPage = {
      index: 2,
      title: "The Mill Ledger",
      markdown: previousProse,
      summary: leakedSummary
    };
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: 3,
      draft: { title: "The North Gate", markdown: currentProse, summary: leakedSummary, continuityNotes: [] },
      previousPages: [previousPage],
      continuityNotes: []
    });
    expect(report.checks.repetitionOk).toBe(true);
    expect(report.issues.join(" ")).not.toMatch(/repeats or substantially overlaps/);

    const finalIssues = runLocalFinalQa(
      { ...input, targetPages: 2 },
      [
        { ...previousPage, index: 1 },
        { index: 2, title: "The North Gate", markdown: currentProse, summary: leakedSummary }
      ]
    );
    expect(finalIssues.join(" ")).not.toMatch(/repeats or substantially overlaps/);
  });

  it("does not read fence-free figure JSON leaked into the summary as the final page's ending", () => {
    const prose = Array.from(
      { length: 6 },
      // No vague-ending phrase in the prose; the summary below would fail the
      // rule if scored as the page's own words.
      (_, index) =>
        `The filter plant at the river bend took its first water in ${1900 + index * 5}, and the ledger of its intake still names every clerk who paid for the sand.`
    ).join(" ");
    const leakedSummary = JSON.stringify({
      kind: "line",
      title: "Into the unknown",
      categories: ["1900", "1910"],
      series: [{ name: "Intake", values: [12, 40] }],
      source: "What came next: the beginning of the record",
      caption: "Nothing, then everything; not the end."
    });
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: input.targetPages,
      draft: { title: "The Last Plant", markdown: prose, summary: leakedSummary, continuityNotes: [] },
      previousPages: [],
      continuityNotes: []
    });
    expect(report.issues).not.toContain("Final page ending is too vague to resolve the book's central promise.");
  });

  it("does not treat fence-free figure JSON in a summary as repeated prose", () => {
    const currentProse = Array.from(
      { length: 6 },
      (_, index) =>
        `The clerks counted the carts at the north gate in ${1500 + index * 10}, and the ledger they kept still names every carrier who paid the toll and every one who argued about it.`
    ).join(" ");
    const previousProse = Array.from(
      { length: 6 },
      (_, index) =>
        `The mill office smelled of oil and old paper, and the winter of ${1911 + index} still sits in three different hands on the desk beside the lamp.`
    ).join(" ");
    // Identical `"kind"` / `categories` JSON in both summaries would look like
    // overlap if the fence-free blob were scored as the page's beat.
    const leakedSummary = JSON.stringify({
      kind: "bar",
      title: "Carts by decade",
      categories: ["kind", "categories", "series", "1500", "1510"],
      series: [{ name: "Carts", values: [120, 140, 160, 180, 200, 220] }],
      source: "The gate ledger"
    });
    const previousPage = {
      index: 2,
      title: "The Mill Ledger",
      markdown: previousProse,
      summary: leakedSummary
    };
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: 3,
      draft: { title: "The North Gate", markdown: currentProse, summary: leakedSummary, continuityNotes: [] },
      previousPages: [previousPage],
      continuityNotes: []
    });
    expect(report.checks.repetitionOk).toBe(true);
    expect(report.issues.join(" ")).not.toMatch(/repeats or substantially overlaps/);

    const finalIssues = runLocalFinalQa(
      { ...input, targetPages: 2 },
      [
        { ...previousPage, index: 1 },
        { index: 2, title: "The North Gate", markdown: currentProse, summary: leakedSummary }
      ]
    );
    expect(finalIssues.join(" ")).not.toMatch(/repeats or substantially overlaps/);
  });
});
