import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";

/**
 * The page-time half of the overlap rule `pageBeatDedup.test.ts` pins the
 * plan-time half of: what `runLocalPageQualityChecks` counts as a page
 * repeating one of its last five predecessors. It lives beside
 * `pagesLocalQa.test.ts` rather than in it because that file is at its size
 * budget, and this is the gate that reads `pageOverlap.ts` — as opposed to the
 * deterministic prose gates.
 *
 * Nothing pinned these verdicts while the check tokenized inside its own loop.
 * Both thresholds, the keyword floor and the five-page window are asserted here
 * so the hoisted set-level scoring has to keep answering identically.
 */

const DRAFT_BODY =
  "Mira set the folding rule against the ice and read the number twice before she wrote it down. The river had held four inches in November and two in January, and the mill wheel had not locked once all winter. Her grandmother watched from the bank with the lantern low, saying nothing, because saying it would make it true. On the walk back Mira counted the stones she could still see through the current, and there were far too many of them.";
const LEDGER_BODY =
  "The mill office smelled of oil and old paper, and the ledger on the desk went back to 1911 in three different hands. Mira turned the pages until she found the winter her grandmother had been a girl, and the column of frozen days ran down the sheet like a fence. Somebody had drawn a small star beside February. She copied the figures into her own notebook, closed the ledger, and put the lamp out before she left the room.";
const repetitionIssue = /repeats or substantially overlaps the beat from page (\d+)/;

function storyInput() {
  return {
    prompt: "A winter story about Mira, her grandmother, and the frozen river behind the mill.",
    category: "STORY" as const,
    targetPages: 12,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "narrative" as const
    }
  };
}

function reviewAfter(
  previousPages: { index: number; title: string; markdown: string; summary: string }[],
  summary: string,
  pageIndex = 6
) {
  const input = storyInput();
  return reviewPageDraftLocally({
    input,
    plan: makeFallbackPlan(input),
    pageIndex,
    draft: { title: "Reading the Ice", markdown: DRAFT_BODY, summary, continuityNotes: [] },
    previousPages,
    continuityNotes: []
  });
}

describe("page repetition gate", () => {
  it("names the earlier page a redrafted body repeats verbatim", () => {
    const report = reviewAfter(
      [{ index: 5, title: "The Mill Ledger", markdown: DRAFT_BODY, summary: "The ledger gives up an older winter." }],
      "Mira measures the ice and writes the number down."
    );

    expect(report.issues.join(" ")).toMatch(/overlaps the beat from page 5/);
    expect(report.checks.repetitionOk).toBe(false);
  });

  it("catches two summaries built from one set of keywords, reordered past the trigram bar", () => {
    // The pair shares no trigram at all, so only the keyword half can fire:
    // seven of the shorter side's eight keywords, which is 0.875 against a 0.78
    // bar.
    const report = reviewAfter(
      [
        {
          index: 5,
          title: "The Mill Ledger",
          markdown: LEDGER_BODY,
          summary: "The folding rule measures Mira's frozen river at dawn."
        }
      ],
      "Mira measures the frozen river with her folding rule at dawn."
    );

    expect(report.issues.join(" ")).toMatch(/overlaps the beat from page 5/);
    expect(report.checks.repetitionOk).toBe(false);
  });

  it("waves through two summaries too short for the keyword ratio to mean anything", () => {
    // Identical two-keyword summaries score a perfect 1.0 without the keyword
    // floor, and are too short to share a trigram with anything.
    const report = reviewAfter(
      [{ index: 5, title: "The Mill Ledger", markdown: LEDGER_BODY, summary: "Winter ends." }],
      "Winter ends."
    );

    expect(report.issues.join(" ")).not.toMatch(repetitionIssue);
    expect(report.checks.repetitionOk).toBe(true);
  });

  it("looks no further back than five pages", () => {
    const older = [2, 3, 4, 5, 6].map((index) => ({
      index,
      title: "The Mill Ledger",
      markdown: LEDGER_BODY,
      summary: "The mill ledger records another winter."
    }));
    const report = reviewAfter(
      [{ index: 1, title: "Reading the Ice Again", markdown: DRAFT_BODY, summary: "Mira reads the ice." }, ...older],
      "Mira measures the ice and writes the number down.",
      7
    );

    expect(report.issues.join(" ")).not.toMatch(repetitionIssue);
    expect(report.checks.repetitionOk).toBe(true);
  });
});

/**
 * What the gate skips when there is nothing to score against, measured through
 * the one thing that work reads. `overlapShingles` and `overlapKeywords` live
 * in `pageOverlap.ts`, but the gate calls them as module-local bindings, so no
 * spy on the imported namespace can see whether they ran; `draft.summary` can,
 * because the repetition gate is its only reader on a page that is not the
 * book's last — `hasVagueEnding` takes the other two — so one access is one
 * tokenization of it, and the count is exact rather than indicative.
 */
function countSummaryReads(
  previousPages: { index: number; title: string; markdown: string; summary: string }[],
  pageIndex = 6
) {
  let reads = 0;
  const input = storyInput();
  const report = reviewPageDraftLocally({
    input,
    plan: makeFallbackPlan(input),
    pageIndex,
    draft: {
      title: "Reading the Ice",
      markdown: DRAFT_BODY,
      get summary() {
        reads += 1;
        return "Mira measures the ice and writes the number down.";
      },
      continuityNotes: []
    },
    previousPages,
    continuityNotes: []
  });
  return { reads, report };
}

/**
 * The predecessor side of the same measurement, through the same probe. A
 * previous page's summary is read by both halves of the rule and by nothing
 * else in the checks either, so one access is again one tokenization of it.
 */
function ledgerPredecessor(index: number, onSummaryRead: () => void) {
  return {
    index,
    title: "The Mill Ledger",
    markdown: LEDGER_BODY,
    get summary() {
      onSummaryRead();
      return "The mill ledger records another winter.";
    }
  };
}

describe("page repetition gate cost", () => {
  it("tokenizes nothing for a page with no predecessors", () => {
    const { reads, report } = countSummaryReads([]);

    expect(reads).toBe(0);
    expect(report.issues.join(" ")).not.toMatch(repetitionIssue);
    expect(report.checks.repetitionOk).toBe(true);
  });

  it("tokenizes the draft once per call rather than once per predecessor", () => {
    // Two reads are the summary's shingles and its keywords; scoring per pair
    // instead reads it twice for each of the five pages behind this one.
    const { reads, report } = countSummaryReads(
      [2, 3, 4, 5, 6].map((index) => ({
        index,
        title: "The Mill Ledger",
        markdown: LEDGER_BODY,
        summary: "The mill ledger records another winter."
      })),
      7
    );

    expect(reads).toBe(2);
    expect(report.issues.join(" ")).not.toMatch(repetitionIssue);
    expect(report.checks.repetitionOk).toBe(true);
  });

  it("tokenizes each predecessor's summary once rather than once per half of the rule", () => {
    // Both halves score the same predecessor summary, so one token array per
    // page is five reads; asking the string-taking pair for a set each is ten.
    const reads = [0, 0, 0, 0, 0];
    const input = storyInput();
    const report = reviewPageDraftLocally({
      input,
      plan: makeFallbackPlan(input),
      pageIndex: 7,
      draft: {
        title: "Reading the Ice",
        markdown: DRAFT_BODY,
        summary: "Mira measures the ice and writes the number down.",
        continuityNotes: []
      },
      previousPages: reads.map((_, offset) =>
        ledgerPredecessor(offset + 2, () => {
          reads[offset] = (reads[offset] ?? 0) + 1;
        })
      ),
      continuityNotes: []
    });

    expect(reads).toEqual([1, 1, 1, 1, 1]);
    expect(report.issues.join(" ")).not.toMatch(repetitionIssue);
    expect(report.checks.repetitionOk).toBe(true);
  });
});
