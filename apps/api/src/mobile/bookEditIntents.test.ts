import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { contentCardForTarget } from "./bookEditIntents.js";
import type { ProjectForChat } from "./projectChat.js";
import { approvedPlanRecord, projectRecord } from "./testing/mobileApiHarness.js";

/**
 * The chat's content cards name chapters, and a continuation whose outline call
 * failed writes chapters with no name (`UNTITLED_CONTINUATION_CHAPTER`,
 * apps/worker/src/handlers/continueBookSupport.ts). Every label here used to
 * interpolate the stored title, so those chapters reached the reader as "5. "
 * and "Chapter 5: " with nothing after the colon.
 */
describe("contentCardForTarget", () => {
  const chapterRows = [
    { id: "chapter-1", index: 1, title: "The Race", summary: "Rabbit and Turtle begin their race." },
    { id: "chapter-2", index: 2, title: "", summary: "Continue the story from where it left off." }
  ];

  function chatProject(overrides: Record<string, unknown> = {}): ProjectForChat {
    return projectRecord({
      status: "COMPLETE",
      chapters: chapterRows,
      pages: [],
      ...overrides
    }) as unknown as ProjectForChat;
  }

  it("labels an untitled chapter in the outline card instead of dangling its number", async () => {
    const card = await contentCardForTarget(chatProject(), { type: "outline" });

    expect(card?.sections.map((section) => section.label)).toEqual(["1. The Race", "Chapter 2"]);
  });

  it("labels an untitled chapter in the outline card built from the plan", async () => {
    const plan = approvedPlanRecord();
    const planningPackage = plan.planningPackage as { chapters: Array<Record<string, unknown>> };
    const card = await contentCardForTarget(
      chatProject({
        currentPlanId: "plan-1",
        currentPlan: {
          ...plan,
          planningPackage: {
            ...planningPackage,
            chapters: [
              ...planningPackage.chapters,
              { index: 2, title: "", summary: "Continue the story.", targetPages: 2, keyBeats: [] }
            ]
          }
        }
      }),
      { type: "outline" }
    );

    expect(card?.sections.map((section) => section.label)).toEqual(["1. The Race", "Chapter 2"]);
  });

  it("never leaves the chapter card's title hanging on a colon", async () => {
    const titled = await contentCardForTarget(chatProject(), { type: "chapter", index: 1 });
    const untitled = await contentCardForTarget(chatProject(), { type: "chapter", index: 2 });

    expect(titled?.title).toBe("Chapter 1: The Race");
    expect(untitled?.title).toBe("Chapter 2");
    // With no pages drafted yet the chapter's own row is the only section, and
    // its label was the empty title too.
    expect(untitled?.sections).toEqual([{ label: "2", body: "Continue the story from where it left off." }]);
  });

  it("names the chapter in the book's own language", async () => {
    const card = await contentCardForTarget(chatProject({ language: "persian" }), { type: "chapter", index: 2 });

    expect(card?.title).toBe("فصل 2");
  });
});
