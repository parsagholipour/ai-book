import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  together: false,
  extract: vi.fn(),
  persist: vi.fn(),
  progress: vi.fn()
}));
vi.mock("./qualityEnrichment.js", () => ({ keeperStoryExtractForSave: mocks.extract, persistStoryExtract: mocks.persist }));
vi.mock("./qualitySettings.js", () => ({ loadQualityContext: async () => ({ enabled: (feature: string) => (feature === "storyExtractAudit" && mocks.enabled) || (feature === "storyNotesTogether" && mocks.together) }) }));
vi.mock("./storyStateStore.js", () => ({ loadProjectStoryState: async () => ({ label: "start" }) }));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: vi.fn(), updateJobProgress: mocks.progress }));

import { makeFallbackPlan, createProjectSchema, type PageDraft, type ProviderSet } from "@book-maker/core";
import { persistChapterStoryDeltas } from "./composedChaptersFinalize.js";

const input = createProjectSchema.parse({ prompt: "A guide to one-on-one meetings.", category: "BUSINESS", targetPages: 5 });
const draft = (index: number) => ({ title: `Page ${index}`, markdown: `Prose ${index}.`, summary: "", continuityNotes: [] }) as PageDraft;
const keepers = [1, 2, 3, 4, 5].map((pageIndex) => ({ pageIndex, draft: draft(pageIndex), revised: false }));
const chapterIdByIndex = new Map([[1, "a"], [2, "a"], [3, "a"], [4, "b"], [5, "b"]]);
const options = { projectId: "p", input, plan: makeFallbackPlan(input), providers: { text: {} } as ProviderSet, generationJobId: "job", keepers, chapterIdByIndex };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.together = false;
});

it("extracts a chapter's pages together against the state it started from and applies them in page order", async () => {
  const events: string[] = [];
  let inFlight = 0;
  let peak = 0;
  mocks.extract.mockImplementation(async ({ pageIndex, currentState }: { pageIndex: number; currentState: { label: string } }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    events.push(`extract ${pageIndex} from ${currentState.label}`);
    await new Promise((resolve) => setTimeout(resolve, 6 - pageIndex));
    inFlight -= 1;
    return { storyDelta: { page: pageIndex } };
  });
  mocks.persist.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => {
    events.push(`persist ${pageIndex}`);
    return { label: `after ${pageIndex}` };
  });
  await persistChapterStoryDeltas(options);
  expect(peak).toBe(3);
  expect(events.filter((event) => event.startsWith("extract")).sort()).toEqual([
    "extract 1 from start", "extract 2 from start", "extract 3 from start", "extract 4 from after 3", "extract 5 from after 3"
  ]);
  expect(events.filter((event) => event.startsWith("persist"))).toEqual(["persist 1", "persist 2", "persist 3", "persist 4", "persist 5"]);
  expect(events.indexOf("persist 3")).toBeLessThan(events.indexOf("extract 4 from after 3"));
  expect(mocks.progress).toHaveBeenLastCalledWith("job", expect.objectContaining({ progress: 88 }));
});

it("spends no call with the story gate off, and a page with no extract writes nothing", async () => {
  mocks.enabled = false;
  await persistChapterStoryDeltas(options);
  expect(mocks.extract).not.toHaveBeenCalled();
  mocks.enabled = true;
  mocks.extract.mockResolvedValue(null);
  await persistChapterStoryDeltas(options);
  expect(mocks.extract).toHaveBeenCalledTimes(5);
  expect(mocks.persist).not.toHaveBeenCalled();
});

it("extracts the whole book at once against its opening state under storyNotesTogether", async () => {
  // Quick Draft: the notes never reach the prose, and a chapter at a time was ~45 s of finalize.
  mocks.together = true;
  const events: string[] = [];
  let inFlight = 0;
  let peak = 0;
  mocks.extract.mockImplementation(async ({ pageIndex, currentState }: { pageIndex: number; currentState: { label: string } }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    events.push(`extract ${pageIndex} from ${currentState.label}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
    inFlight -= 1;
    return { storyDelta: { page: pageIndex } };
  });
  mocks.persist.mockImplementation(async ({ pageIndex }: { pageIndex: number }) => {
    events.push(`persist ${pageIndex}`);
    return { label: `after ${pageIndex}` };
  });
  await persistChapterStoryDeltas(options);
  expect(peak).toBe(5);
  expect(events.filter((event) => event.startsWith("extract")).every((event) => event.endsWith("from start"))).toBe(true);
  expect(events.filter((event) => event.startsWith("persist"))).toEqual(["persist 1", "persist 2", "persist 3", "persist 4", "persist 5"]);
});
