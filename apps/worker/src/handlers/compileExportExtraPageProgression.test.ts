import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, inputWithSelectedPageCount, makeFallbackPlan,
  manuscriptRequirementInventorySchema, type GenerateJsonOptions } from "@book-maker/core";
import captures from "../../../../packages/core/src/generation/testing/extraPageProgression.json" with { type: "json" };
vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";

type Operation = Parameters<typeof finalizationCoverageForCompile>[0]["operation"];
type Request<T> = { slot: string; fingerprint: string; parse: (value: unknown) => T | undefined; compute: () => Promise<T> };
function durableOperation(cache: Map<string, unknown>): Operation {
  return { state: { key: "operation", inputFingerprint: "configuration" },
    exportCheck: async <T>(request: Request<T>) => {
      const key = `${request.slot}:${request.fingerprint}`;
      const cached = request.parse(cache.get(key));
      if (cached !== undefined) return cached;
      const value = await request.compute();
      cache.set(key, JSON.parse(JSON.stringify(value)));
      return value;
    }
  };
}

it.each(captures)("settles $tier's optional-page requirement through export and durable restart without a reread", async capture => {
  const input = createProjectSchema.parse({ category: "KIDS", targetPages: 30, prompt: capture.brief });
  const inventory = manuscriptRequirementInventorySchema.parse({ version: 1, status: "available", complete: true,
    brief: capture.brief, requirements: [capture.requirement] });
  const cache = new Map<string, unknown>();
  const calls: GenerateJsonOptions<unknown>[] = [];
  const textModel = new FakeTextModelAdapter(input);
  textModel.generateJson = async request => {
    calls.push(request);
    const data = request.schema.parse({ complete: true, requirements: [{ ...capture.verdict, id: "brief-1" }] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  };
  const compile = (count: number) => {
    const selected = inputWithSelectedPageCount(input, count);
    const pages = Array.from({ length: count }, (_, i) => ({ id: `page-${i + 1}`, index: i + 1,
      title: "Lantern", revision: 1, images: [], markdown: `Rabbit and Turtle find the next lantern on page ${i + 1}.` }));
    const evidenceContext = buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages, images: [] });
    return finalizationCoverageForCompile({ operation: durableOperation(cache), brief: capture.brief, inventory,
      promises: [], pages, chapters: [], evidenceContext, textModel });
  };
  const first = await compile(30);
  expect(first.stored.review.status).toBe("reviewed");
  expect(first.stored.review.requirements[0]).toMatchObject({ status: "fulfilled", evidence: [],
    applicability: { status: "not_applicable", requestedStoryPages: 30, extraPageIndexes: [] } });
  expect(first.issues).toEqual([]);
  const resumed = await compile(30);
  expect(resumed).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toEqual([]);

  // Selecting 33 pages must retain the original minimum of 30 and must not
  // reuse the prior inapplicable result or accept the captured empty evidence.
  const added = await compile(33);
  expect(added.stored.review.requirements[0]).toMatchObject({ status: "unverified",
    applicability: { status: "applicable", requestedStoryPages: 30, extraPageIndexes: [31, 32, 33] } });
  expect(added.issues.map(issue => issue.code)).toContain("BRIEF_COVERAGE_UNVERIFIED");
  expect(calls).toHaveLength(2);
  expect((await compile(33)).stored.review).toEqual(added.stored.review);
  expect(calls).toHaveLength(2);
});
