import { expect, it } from "vitest";
import type { ManuscriptQualityIssue } from "@book-maker/core";
import { chapterTransitionRepairIssues } from "./chapterTransitionRepairs.js";

const pages = Array.from({ length: 12 }, (_, offset) => ({ index: offset + 1, chapter: { index: offset < 6 ? 1 : 2 } }));
const handoff: ManuscriptQualityIssue = {
  code: "CHAPTER_TRANSITION", source: "model", severity: "warning", affectedPageIndexes: [6, 7],
  message: "The lantern moves from Rabbit to Turtle without a handoff.",
  guidance: "Connect the closing scene to the next opening by showing the handoff."
};

it("targets both actual sides of a chapter handoff and keeps its repair guidance", () => {
  expect(chapterTransitionRepairIssues([{ ...handoff, affectedPageIndexes: [7, 6] }], [...pages].reverse()))
    .toEqual([handoff]);
});

it("keeps target selection independent of page references in the finding's prose", () => {
  const issue = { ...handoff, message: "Unlike page 1, the lantern handoff is missing here." };
  expect(chapterTransitionRepairIssues([issue], pages)[0]?.affectedPageIndexes).toEqual([6, 7]);
});

it.each([
  { code: "CHAPTER_COHERENCE" }, { code: "CHAPTER_REVIEW_UNAVAILABLE" },
  { guidance: " " }, { message: " " }, { affectedPageIndexes: [] },
  { affectedPageIndexes: [6] }, { affectedPageIndexes: [5, 6] },
  { affectedPageIndexes: [6, 8] }, { affectedPageIndexes: [6, 7, 8] },
  { affectedPageIndexes: [12, 13] }
])("does not rewrite pages for an unsupported or unlocated concern: %j", (change) => {
  expect(chapterTransitionRepairIssues([{ ...handoff, ...change }], pages)).toEqual([]);
});

it("uses the reviewer's same fallback boundary when chapter rows are absent", () => {
  const ungrouped = pages.map(({ index }) => ({ index, chapter: null }));
  const issue = { ...handoff, affectedPageIndexes: [8, 9] };
  expect(chapterTransitionRepairIssues([issue], ungrouped)).toEqual([issue]);
});

it("does not bridge a missing page to create an adjacent repair pair", () => {
  expect(chapterTransitionRepairIssues([{ ...handoff, affectedPageIndexes: [6, 8] }], pages.filter((page) => page.index !== 7)))
    .toEqual([]);
});
