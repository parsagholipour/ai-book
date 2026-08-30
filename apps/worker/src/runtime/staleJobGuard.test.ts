import { describe, expect, it } from "vitest";
import { staleGenerationTargetReason } from "./staleJobGuard.js";

const current = {
  durableProjectId: "project-1",
  payloadProjectId: "project-1",
  type: "GENERATE_PAGE",
  planId: "plan-current",
  currentPlanId: "plan-current",
  pageId: "page-1",
  pageProjectId: "project-1",
  contentRevision: null,
  projectContentRevision: 4
};

describe("stale generation target guard", () => {
  it("cancels superseded plan work", () => {
    expect(staleGenerationTargetReason({ ...current, planId: "plan-old" })).toContain("superseded");
    expect(
      staleGenerationTargetReason({ ...current, planId: "plan-old", jobCreatedCurrentPlan: true })
    ).toContain("superseded");
  });

  it("does not treat a structural apply that created the current plan as stale", () => {
    const apply = {
      ...current,
      type: "APPLY_BOOK_EDIT",
      planId: "plan-old",
      pageId: null,
      pageProjectId: null
    };
    expect(staleGenerationTargetReason({ ...apply, jobCreatedCurrentPlan: true })).toBeNull();
    expect(staleGenerationTargetReason(apply)).toContain("superseded");
    expect(staleGenerationTargetReason({ ...apply, jobCreatedCurrentPlan: false })).toContain(
      "superseded"
    );
  });

  it("admits only a proven staged GENERATE_BOOK successor", () => {
    const staged = {
      ...current,
      type: "GENERATE_BOOK",
      planId: "plan-staged",
      pageId: null,
      pageProjectId: null
    };
    expect(staleGenerationTargetReason({ ...staged, jobTargetsStagedReplan: true })).toBeNull();
    expect(staleGenerationTargetReason(staged)).toContain("superseded");
    expect(
      staleGenerationTargetReason({ ...staged, type: "GENERATE_PAGE", jobTargetsStagedReplan: true })
    ).toContain("superseded");
  });

  it("cancels cross-project page work", () => {
    expect(staleGenerationTargetReason({ ...current, pageProjectId: "project-2" })).toContain("another project");
  });

  it("cancels obsolete export revisions without rejecting current work", () => {
    expect(
      staleGenerationTargetReason({
        ...current,
        type: "COMPILE_EXPORT",
        pageId: null,
        pageProjectId: null,
        contentRevision: 3
      })
    ).toContain("changed");
    expect(staleGenerationTargetReason(current)).toBeNull();
  });

  it("cancels a revision-owned replan cover after its manuscript or EDITING handoff changes", () => {
    const cover = {
      ...current,
      type: "GENERATE_IMAGE",
      pageId: null,
      pageProjectId: null,
      contentRevision: 7,
      projectContentRevision: 7,
      expectedProjectStatus: "EDITING",
      projectStatus: "EDITING"
    };
    expect(staleGenerationTargetReason(cover)).toBeNull();
    expect(staleGenerationTargetReason({ ...cover, projectContentRevision: 8 })).toContain("changed");
    expect(staleGenerationTargetReason({ ...cover, projectStatus: "COMPLETE" })).toContain("status");
  });
});
