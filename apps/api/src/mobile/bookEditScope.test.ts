import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { planSummaryForClassifier } from "./bookEditScope.js";
import { approvedPlanRecord } from "./testing/mobileApiHarness.js";

function continuationPlan() {
  const plan = approvedPlanRecord();
  const planningPackage = plan.planningPackage as { chapters: Array<Record<string, unknown>> };
  return {
    planningPackage: {
      ...planningPackage,
      chapters: [
        ...planningPackage.chapters,
        { index: 2, title: "", summary: "Continue the story from where it left off.", targetPages: 2, keyBeats: [] }
      ]
    }
  };
}

describe("planSummaryForClassifier", () => {
  it("names an untitled continuation chapter instead of handing the classifier a blank title", () => {
    const summary = planSummaryForClassifier(continuationPlan());

    expect(summary).toContain("1. The Race:");
    expect(summary).toContain("2. Chapter 2: Continue the story from where it left off.");
    expect(summary).not.toMatch(/\n2\. : /);
  });

  it("names an untitled continuation in the book's language", () => {
    const summary = planSummaryForClassifier(continuationPlan(), "persian");

    expect(summary).toContain("2. فصل 2: Continue the story from where it left off.");
    expect(summary).not.toContain("Chapter 2");
  });
});
