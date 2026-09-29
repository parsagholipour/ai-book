import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, inputWithSelectedPageCount, makeFallbackPlan, manuscriptCoverageSchema,
  type GenerateJsonOptions } from "@book-maker/core";
vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";

// The upper-bound inventory emitted in Quick's September 28 run.
const brief = "Write 30–33 story pages, never fewer than 30.";
const requirement = { kind: "page_count" as const, text: "Story-page maximum", quote: "Write 30–33 story pages", expectedCount: 33,
  scope: { extent: "whole_book" as const, quote: brief } };
const input = createProjectSchema.parse({ category: "KIDS", targetPages: 30, prompt: brief });
const pagesFor = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `page-${index + 1}`, index: index + 1,
  title: "Lantern", markdown: "Rabbit and Turtle restore the lantern path together.", revision: 1, images: [] }));
const inventory = { version: 1 as const, brief, status: "available" as const, complete: true, requirements: [requirement] };

it("corrects a serialized maximum verdict from a cached finalization without another model read", async () => {
  const textModel = new FakeTextModelAdapter(input), generate = vi.spyOn(textModel, "generateJson");
  const cached = JSON.parse(JSON.stringify({ status: "reviewed", assessmentComplete: true, requirements: [
    { ...requirement, id: "brief-1", source: "brief", status: "missing", reason: "Expected 33 pages", evidence: [] }
  ] }));
  for (const [selectedCount, deliveredCount, status] of [[30, 30, "fulfilled"], [33, 33, "fulfilled"], [33, 32, "missing"]] as const) {
    const selected = inputWithSelectedPageCount(input, selectedCount), pages = pagesFor(deliveredCount);
    const result = await finalizationCoverageForCompile({ operation: {
      state: { key: "operation", inputFingerprint: "configuration" },
      exportCheck: async request => {
        const restored = request.parse(cached);
        if (!restored) throw new Error("Saved coverage was rejected");
        return restored;
      }
    }, brief, promises: [], pages, chapters: [], inventory, textModel,
    evidenceContext: buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages, images: [] }) });
    expect(result.stored.review.requirements[0]?.status).toBe(status);
    expect(result.issues).toHaveLength(status === "fulfilled" ? 0 : 1);
    expect(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(result.stored.review))).requirements[0]?.pageCountConstraint)
      .toEqual({ kind: "range", minimum: 30, maximum: 33 });
  }
  expect(generate).not.toHaveBeenCalled();
});

it("keeps the upper bound out of semantic assessment on a fresh finalization read", async () => {
  const selected = inputWithSelectedPageCount(input, 30), pages = pagesFor(30), textModel = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  textModel.generateJson = async request => {
    calls.push(request);
    const data = request.schema.parse({ complete: true, requirements: [] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  };
  const result = await finalizationCoverageForCompile({ operation: {
    state: { key: "operation", inputFingerprint: "configuration" },
    exportCheck: async request => JSON.parse(JSON.stringify(await request.compute()))
  }, brief, promises: [], pages, chapters: [], inventory, textModel,
  evidenceContext: buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages, images: [] }) });
  expect(result.issues).toEqual([]);
  expect(result.stored.review.requirements[0]?.status).toBe("fulfilled");
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toEqual([]);
});
