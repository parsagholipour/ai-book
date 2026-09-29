import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, inputWithSelectedPageCount, makeFallbackPlan,
  manuscriptRequirementInventorySchema, type GenerateJsonOptions } from "@book-maker/core";
import capture from "../../../../packages/core/src/generation/testing/optionalPagePolicy0928.json" with { type: "json" };
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

it("settles Premium's split policy through compile, restart and a cached pre-fix review without approving new pages", async () => {
  const input = createProjectSchema.parse({ category: "KIDS", targetPages: 30, prompt: capture.brief });
  const inventory = manuscriptRequirementInventorySchema.parse({ version: 1, status: "available", complete: true,
    brief: capture.brief, requirements: capture.requirements });
  const cache = new Map<string, unknown>();
  const calls: GenerateJsonOptions<unknown>[] = [];
  const textModel = new FakeTextModelAdapter(input);
  textModel.generateJson = async request => {
    calls.push(request);
    const data = request.schema.parse({ complete: true, requirements: capture.verdicts.map(v => ({ ...v, id: "brief-1" })) });
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
  expect(first.stored.review.requirements.every(r => r.status === "fulfilled" && r.applicability?.status === "not_applicable")).toBe(true);
  expect(first.issues).toEqual([]);
  expect(await compile(30)).toEqual(first);
  expect(calls).toHaveLength(1);

  // Replace the persisted coverage with the equivalent pre-fix false failure.
  // Its exact original brief is available at refresh; no new read is necessary.
  const key = [...cache.keys()].find(key => key.startsWith("coverage:"))!;
  cache.set(key, { status: "incomplete", assessmentComplete: true, requirements: inventory.requirements.map((r, i) => ({
    ...r, id: `brief-${i + 1}`, source: "brief", status: i ? "fulfilled" : "unverified",
    reason: "The story uses the requested 30 pages.", evidence: []
  })) });
  const legacy = await compile(30);
  expect(legacy.stored.review.status).toBe("reviewed");
  expect(legacy.issues).toEqual([]);
  expect(new Set(legacy.stored.review.requirements.map(r => r.obligationId)).size).toBe(1);
  expect(calls).toHaveLength(1);

  const added = await compile(33);
  expect(added.stored.review.requirements.every(r => r.status === "unverified" &&
    JSON.stringify(r.applicability?.extraPageIndexes) === "[31,32,33]")).toBe(true);
  expect(added.issues.map(issue => issue.code)).toContain("BRIEF_COVERAGE_UNVERIFIED");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1]!.messages[1]!.content).requirements).toHaveLength(1);
  expect((await compile(33)).stored.review).toEqual(added.stored.review);
  expect(calls).toHaveLength(2);
});
