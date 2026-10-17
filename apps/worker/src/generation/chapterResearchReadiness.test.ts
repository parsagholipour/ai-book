import { describe, expect, it } from "vitest";
import { chapterResearchQuery, makeFallbackPlan, type CreateProjectInput } from "@book-maker/core";
import { chapterResearchReadiness } from "./chapterResearchReadiness.js";

const input = { prompt: "A history of treaties", category: "HISTORY", targetPages: 40, complexity: 5, temperature: 0.7, language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverTemplate: "auto", finalReview: true, toneProfile: "neutral" } } as CreateProjectInput;
const plan = makeFallbackPlan(input);
const [first, second] = plan.chapters;

function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5))]);
}

describe("chapterResearchReadiness", () => {
  it("lets a chapter go once its own search has settled, reading the rows settled so far until they are written", async () => {
    const readiness = chapterResearchReadiness(plan);
    let finish!: () => void;
    readiness.started({ chapterIndexes: [first!.index, second!.index], researchQueries: [] }, new Promise<void>((resolve) => { finish = resolve; }));
    expect(await settled(readiness.readyFor(first!.index))).toBe(false);
    const row = { query: chapterResearchQuery(plan, first!), title: "A source", url: "https://example.org", summary: "S" };
    readiness.onQuery(row.query, [row]);
    expect(await settled(readiness.readyFor(first!.index))).toBe(true);
    expect(await settled(readiness.readyFor(second!.index))).toBe(false);
    expect(readiness.pendingRows()).toEqual([row]);
    finish();
    expect(await settled(readiness.readyFor(second!.index))).toBe(true);
    // Written: the table holds them now.
    expect(readiness.pendingRows()).toEqual([]);
  });

  it("never holds a chapter the expansion does not search, nor any chapter of a book that never expands", async () => {
    const readiness = chapterResearchReadiness(plan);
    expect(await settled(readiness.readyFor(first!.index))).toBe(true);
    readiness.started({ chapterIndexes: [second!.index], researchQueries: ["an open question"] }, new Promise(() => undefined));
    expect(await settled(readiness.readyFor(first!.index))).toBe(true);
    expect(await settled(readiness.readyFor(second!.index))).toBe(false);
  });
});
