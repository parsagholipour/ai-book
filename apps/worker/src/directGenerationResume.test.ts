import { describe, expect, it } from "vitest";
import { directGenerationResumeState, type DirectResumeInput } from "./directGenerationResume.js";

const planChapters = [
  { index: 1, title: "Beginnings", targetPages: 4 },
  { index: 2, title: "Middles", targetPages: 4 }
];

function baseInput(overrides: Partial<DirectResumeInput> = {}): DirectResumeInput {
  return {
    targetPages: 8,
    planChapters,
    storedChapters: planChapters.map((chapter) => ({ ...chapter, hasBrief: true })),
    storedPages: [
      { index: 1, status: "COMPLETED" },
      { index: 2, status: "COMPLETED" },
      { index: 3, status: "FAILED_QA" }
    ],
    requiresBriefs: true,
    requireAllPagesPresent: false,
    ...overrides
  };
}

describe("direct generation resume state", () => {
  it("resumes from the first missing page when the settled prefix matches the plan", () => {
    expect(directGenerationResumeState(baseInput())).toEqual({ kind: "resume", firstMissingPageIndex: 4 });
  });

  it("reports already-complete when every page is settled", () => {
    const storedPages = Array.from({ length: 8 }, (_, offset) => ({
      index: offset + 1,
      status: offset === 5 ? "FAILED_QA" : "COMPLETED"
    }));
    expect(directGenerationResumeState(baseInput({ storedPages }))).toEqual({ kind: "already-complete" });
  });

  it("starts fresh when there are no stored pages or chapters", () => {
    expect(directGenerationResumeState(baseInput({ storedPages: [] }))).toEqual({ kind: "fresh" });
    expect(directGenerationResumeState(baseInput({ storedChapters: [] }))).toEqual({ kind: "fresh" });
  });

  it("starts fresh when the stored chapter structure no longer matches the plan", () => {
    const renamed = [
      { index: 1, title: "Renamed", targetPages: 4, hasBrief: true },
      { index: 2, title: "Middles", targetPages: 4, hasBrief: true }
    ];
    expect(directGenerationResumeState(baseInput({ storedChapters: renamed }))).toEqual({ kind: "fresh" });

    const resized = [
      { index: 1, title: "Beginnings", targetPages: 5, hasBrief: true },
      { index: 2, title: "Middles", targetPages: 4, hasBrief: true }
    ];
    expect(directGenerationResumeState(baseInput({ storedChapters: resized }))).toEqual({ kind: "fresh" });
  });

  it("starts fresh when a required chapter brief is missing", () => {
    const storedChapters = [
      { index: 1, title: "Beginnings", targetPages: 4, hasBrief: true },
      { index: 2, title: "Middles", targetPages: 4, hasBrief: false }
    ];
    expect(directGenerationResumeState(baseInput({ storedChapters }))).toEqual({ kind: "fresh" });
    expect(
      directGenerationResumeState(baseInput({ storedChapters, requiresBriefs: false }))
    ).toEqual({ kind: "resume", firstMissingPageIndex: 4 });
  });

  it("starts fresh when settled pages are not a contiguous prefix", () => {
    const storedPages = [
      { index: 1, status: "COMPLETED" },
      { index: 3, status: "COMPLETED" }
    ];
    expect(directGenerationResumeState(baseInput({ storedPages }))).toEqual({ kind: "fresh" });
  });

  it("starts fresh when a stored page is still mid-generation or out of range", () => {
    expect(
      directGenerationResumeState(
        baseInput({ storedPages: [{ index: 1, status: "COMPLETED" }, { index: 2, status: "GENERATING" }] })
      )
    ).toEqual({ kind: "fresh" });
    expect(
      directGenerationResumeState(baseInput({ storedPages: [{ index: 1, status: "COMPLETED" }, { index: 9, status: "COMPLETED" }] }))
    ).toEqual({ kind: "fresh" });
  });

  describe("draft-then-polish (all pages checkpointed as PENDING)", () => {
    const fullDraft = (polishedThrough: number) =>
      Array.from({ length: 8 }, (_, offset) => ({
        index: offset + 1,
        status: offset < polishedThrough ? "COMPLETED" : "PENDING"
      }));

    it("resumes at the first unpolished page without redrafting", () => {
      expect(
        directGenerationResumeState(baseInput({ requireAllPagesPresent: true, storedPages: fullDraft(3) }))
      ).toEqual({ kind: "resume", firstMissingPageIndex: 4 });
    });

    it("resumes from page one when the draft was checkpointed but nothing was polished", () => {
      expect(
        directGenerationResumeState(baseInput({ requireAllPagesPresent: true, storedPages: fullDraft(0) }))
      ).toEqual({ kind: "resume", firstMissingPageIndex: 1 });
    });

    it("reports already-complete once every page is polished", () => {
      expect(
        directGenerationResumeState(baseInput({ requireAllPagesPresent: true, storedPages: fullDraft(8) }))
      ).toEqual({ kind: "already-complete" });
    });

    it("starts fresh when the checkpointed draft is incomplete", () => {
      expect(
        directGenerationResumeState(
          baseInput({ requireAllPagesPresent: true, storedPages: fullDraft(3).slice(0, 6) })
        )
      ).toEqual({ kind: "fresh" });
    });
  });
});
