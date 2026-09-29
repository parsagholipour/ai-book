import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, inputWithSelectedPageCount, makeFallbackPlan, manuscriptCoverageSchema,
  refreshManuscriptCoverageFacts, type GenerateJsonOptions } from "@book-maker/core";
vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";

const promise = "Preserve exactly 30 story pages, all text-only; include no cover image, interior illustrations, or character reference images.";
const input = createProjectSchema.parse({ category: "KIDS", targetPages: 30, prompt: "Exactly 30 story pages. No images." });
const pagesFor = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `page-${index + 1}`, index: index + 1,
  title: "Lantern", markdown: "Rabbit and Turtle restore the lantern path together.", revision: 1, images: [] }));
const review = () => manuscriptCoverageSchema.parse({ status: "incomplete", assessmentComplete: true, requirements: [
  { id: "brief-1", source: "brief", kind: "page_count", expectedCount: 30, text: "Exactly 30 story pages", quote: "Exactly 30 story pages",
    status: "missing", reason: "Expected exactly 30", evidence: [] },
  { id: "promise-1", source: "promise", kind: "content", text: promise, quote: promise,
    status: "unverified", reason: "The export media inventory is unavailable.", evidence: [] }
] });

it.each([30, 31, 33])("settles the captured delivery promise and requested page count for %i selected pages", count => {
  const selected = inputWithSelectedPageCount(input, count);
  const context = buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages: pagesFor(count), images: [] });
  const final = refreshManuscriptCoverageFacts(review(), context);
  expect(final.requirements.map(row => row.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(final.status).toBe("reviewed");
});

it("does not treat allowance as permission to lose a page from a fixed map", () => {
  const selected = inputWithSelectedPageCount(input, 33);
  const context = buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages: pagesFor(32), images: [] });
  expect(refreshManuscriptCoverageFacts(review(), context).requirements.map(row => row.status)).toEqual(["missing", "missing"]);
});

it.each([29, 34])("rejects %i pages outside the original 30–33 allowance", count => {
  const context = buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input), pages: pagesFor(count), images: [] });
  expect(refreshManuscriptCoverageFacts(review(), context).requirements.map(row => row.status)).toEqual(["missing", "missing"]);
});

it.each([31, 33])("accepts %i pages against a legacy target before selection is saved", count => {
  const context = buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input), pages: pagesFor(count), images: [] });
  expect(refreshManuscriptCoverageFacts(review(), context).requirements.map(row => row.status)).toEqual(["fulfilled", "fulfilled"]);
});

it("does not clear missing page indexes, prohibited artwork, or unknown narrative clauses", () => {
  const selected = inputWithSelectedPageCount(input, 33);
  const context = buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages: pagesFor(33), images: [] });
  expect(refreshManuscriptCoverageFacts(review(), { ...context, storyPageIndexes: [1, ...context.storyPageIndexes.slice(0, -1)] })
    .requirements.map(row => row.status)).toEqual(["missing", "missing"]);
  expect(refreshManuscriptCoverageFacts(review(), { ...context, mediaInventory: { ...context.mediaInventory, characterReferenceCount: 1 } })
    .requirements.map(row => row.status)).toEqual(["fulfilled", "missing"]);
  const semantic = review();
  semantic.requirements[1]!.quote = `${promise.slice(0, -1)}; both characters learn to cooperate.`;
  expect(refreshManuscriptCoverageFacts(semantic, context).requirements[1]!.status).toBe("unverified");
});

it("settles deferred assets after serialization without buying a second coverage call", async () => {
  const selected = inputWithSelectedPageCount(input, 33), pages = pagesFor(33);
  const evidenceContext = buildManuscriptCoverageContext({ input: selected, plan: makeFallbackPlan(selected), pages, images: [] });
  const textModel = new FakeTextModelAdapter(selected);
  const calls: GenerateJsonOptions<unknown>[] = [];
  textModel.generateJson = async request => {
    calls.push(request);
    const data = request.schema.parse({ complete: true, requirements: [] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  };
  const result = await finalizationCoverageForCompile({ operation: {
    state: { key: "operation", inputFingerprint: "configuration" },
    exportCheck: async request => JSON.parse(JSON.stringify(await request.compute()))
  }, brief: input.prompt, promises: [promise], pages, chapters: [], evidenceContext, textModel,
  inventory: { version: 1, brief: input.prompt, complete: true, status: "available", requirements: [
    { kind: "page_count", quote: "Exactly 30 story pages", text: "Thirty pages", expectedCount: 30 }
  ] } });
  expect(result.issues).toEqual([]);
  expect(result.stored.review.status).toBe("reviewed");
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).requirements).toEqual([]);
});
