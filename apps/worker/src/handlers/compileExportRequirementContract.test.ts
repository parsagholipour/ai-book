import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, type GenerateJsonOptions, type ManuscriptRequirementInventory } from "@book-maker/core";
vi.mock("@book-maker/db", () => ({ prisma: { generationJob: { findFirst: async () => null } } }));
import { finalizationCoverageForCompile, prepareFinalizationCoverageInventory } from "./compileExportCoverageCheckpoint.js";
import { manuscriptCoverageForCompile, manuscriptCoverageFingerprint } from "../generation/manuscriptCoverageReview.js";
import { finalizationFingerprint, manuscriptFinalizationFingerprint } from "./compileFinalization.js";

type Operation = Parameters<typeof finalizationCoverageForCompile>[0]["operation"];
function operation(cache = new Map<string, unknown>()): Operation {
  return { state: { key: "operation", inputFingerprint: "configuration" }, exportCheck: async request => {
    const key = `${request.slot}:${request.fingerprint}`;
    const saved = request.parse(cache.get(key));
    if (saved !== undefined) return saved;
    const result = await request.compute();
    cache.set(key, JSON.parse(JSON.stringify(result)));
    return result;
  } };
}
const brief = "Use natural dialogue.";
const inventory: ManuscriptRequirementInventory = { version: 1, brief, complete: true, status: "available",
  requirements: [{ text: "Natural dialogue", quote: "natural dialogue", kind: "content", scope: { extent: "whole_book", quote: brief } }] };
const page = { id: "p1", index: 1, title: "The path", revision: 1, markdown: '"Follow me," said Rabbit.', images: [] };
const context = { title: "The path", targetStoryPages: 1, storyPageIndexes: [1], illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [] };
function model() {
  const textModel = new FakeTextModelAdapter(createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 5 }));
  const calls: GenerateJsonOptions<unknown>[] = [];
  textModel.generateJson = async request => {
    calls.push(request);
    const result = { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "Rabbit speaks naturally.", evidence: [{ pageIndex: 1, quote: page.markdown }] }] };
    return { data: request.schema.parse(result), text: JSON.stringify(result), provider: "fixture", model: "fixture" };
  };
  return { textModel, calls };
}

it("reuses the prewriting contract across export restarts and binds coverage to its scope", async () => {
  const fixture = model(), cache = new Map<string, unknown>();
  const options = { brief, promises: [], inventory, pages: [page], chapters: [], evidenceContext: context, textModel: fixture.textModel };
  expect(await prepareFinalizationCoverageInventory(operation(cache), brief, fixture.textModel, inventory)).toBe(inventory);
  const first = await finalizationCoverageForCompile({ ...options, operation: operation(cache) });
  const resumed = await finalizationCoverageForCompile({ ...options, operation: operation(cache) });
  expect(first).toEqual(resumed);
  expect(first.stored.review.status).toBe("reviewed");
  expect(fixture.calls.map(call => call.purpose)).toEqual(["read-manuscript"]);
  const changed: ManuscriptRequirementInventory = { ...inventory, complete: false };
  await finalizationCoverageForCompile({ ...options, inventory: changed, operation: operation(cache) });
  expect(fixture.calls).toHaveLength(2);
  expect(manuscriptCoverageFingerprint(brief, [], [page], [], context, [], inventory))
    .not.toBe(manuscriptCoverageFingerprint(brief, [], [page], [], context, [], changed));
});

it("passes the contract through the legacy compile path too", async () => {
  const fixture = model();
  const result = await manuscriptCoverageForCompile({ projectId: "p1", brief, promises: [], pages: [page], inventory,
    textModel: fixture.textModel, allowModelReview: true, chapters: [], evidenceContext: context });
  expect(result.stored.review.status).toBe("reviewed");
  expect(fixture.calls.map(call => call.purpose)).toEqual(["read-manuscript"]);
  expect(JSON.parse(fixture.calls[0]!.messages.at(-1)!.content).requirements[0].scope).toEqual(inventory.requirements[0]!.scope);
});

it("does not reuse an export checkpoint from before the shared final-page convention", async () => {
  const fixture = model(), cache = new Map<string, unknown>();
  const oldFingerprint = finalizationFingerprint({ version: 14, inventory, requirementTargets: [], operation: "operation",
    configuration: "configuration", manuscript: manuscriptFinalizationFingerprint([page]), brief, promises: [], chapters: [],
    evidenceContext: { ...context, illustratedPageIndexes: [], mediaInventory: {} } });
  cache.set(`coverage:${oldFingerprint}`, { status: "reviewed", requirements: [] });
  const result = await finalizationCoverageForCompile({ brief, promises: [], inventory, pages: [page], chapters: [],
    evidenceContext: context, textModel: fixture.textModel, operation: operation(cache) });
  expect(fixture.calls.map(call => call.purpose)).toEqual(["read-manuscript"]);
  expect(result.stored.review.requirements[0]?.status).toBe("fulfilled");
});

it("keeps a failed prewriting inventory unavailable without paying for a replacement at export", async () => {
  const fixture = model();
  const result = await finalizationCoverageForCompile({ brief, promises: [], pages: [page], chapters: [], evidenceContext: context,
    textModel: fixture.textModel, operation: operation(), inventory: { version: 1, brief, status: "unavailable", complete: false, requirements: [] } });
  expect(result.stored.review.status).toBe("unavailable");
  expect(fixture.calls).toHaveLength(0);
});
