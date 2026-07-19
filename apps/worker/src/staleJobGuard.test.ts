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
});
