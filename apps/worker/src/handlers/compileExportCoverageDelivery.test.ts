import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, manuscriptCoverageSchema, type GenerateJsonOptions } from "@book-maker/core";
import captures from "../../../../packages/core/src/generation/testing/compoundDeliveryPromises.json" with { type: "json" };

vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";

type Operation = Parameters<typeof finalizationCoverageForCompile>[0]["operation"];
type Request<T> = { slot: string; fingerprint: string; parse: (value: unknown) => T | undefined; compute: () => Promise<T> };
function durableOperation(cache = new Map<string, unknown>()): Operation {
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

it.each(captures)("finalizes $tier's compound delivery with fresh assets after a durable restart and no reread", async ({ requirement, pages: capturedPages }) => {
  const pages = capturedPages.map(p => ({ ...p, id: `page-${p.index}`, title: `Page ${p.index}`, revision: 1, images: [] }));
  const input = createProjectSchema.parse({ prompt: "Exactly 30 story pages.", category: "KIDS", targetPages: 30, mediaSettings: { includeCover: false } });
  const plan = makeFallbackPlan(input);
  const cache = new Map<string, unknown>();
  const model = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  const replies: unknown[] = [{ complete: true, requirements: [
    { text: input.prompt, quote: input.prompt, kind: "page_count", expectedCount: 30 }
  ] }, { complete: true, requirements: [] }];
  model.generateJson = async (request) => {
    calls.push(request);
    if (!replies.length) throw new Error("Unexpected model call in test");
    const reply = replies.shift();
    return { data: request.schema.parse(reply), text: JSON.stringify(reply), model: "fixture", provider: "fixture" };
  };
  const evidenceContext = buildManuscriptCoverageContext({ input, plan, pages, images: [] });
  const options = { operation: durableOperation(cache), brief: input.prompt, promises: [requirement.quote], pages, chapters: [], evidenceContext, textModel: model };
  const first = await finalizationCoverageForCompile({ ...options, evidenceContext: { ...evidenceContext, mediaInventory: {} } });
  expect(first.stored.review.requirements[1]?.status).toBe("unverified");
  const final = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(final.stored.review.status).toBe("reviewed");
  expect(final.stored.review.requirements[1]?.status).toBe("fulfilled");
  expect(final.stored.review.requirements[1]?.deliveryChecks).toHaveLength(4);
  expect(final.issues).toEqual([]);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1]!.messages[1]!.content).requirements).toEqual([]);
  expect(JSON.parse(calls[1]!.messages[1]!.content).evidenceContext.mediaInventory).toEqual({});
  expect(manuscriptCoverageSchema.parse(final.stored.review)).toEqual(final.stored.review);
  const prohibited = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache), evidenceContext: {
    ...evidenceContext, mediaInventory: { ...evidenceContext.mediaInventory, coverArtworkCount: 1 }
  } });
  expect(prohibited.stored.review.requirements[1]?.status).toBe("missing");
  expect(prohibited.issues[0]?.code).toBe("UNPAID_PROMISE");
  expect(calls).toHaveLength(2);
});

it("counts project reference assets independently from saved profiles and source portrait provenance", () => {
  const input = createProjectSchema.parse({ prompt: "A children's story.", category: "KIDS", targetPages: 30 });
  const plan = makeFallbackPlan(input);
  plan.characters = [{ name: "Rabbit", role: "Lead", description: "Playful", traits: [], visualRules: [] }];
  const pages = [{ index: 1, markdown: "Rabbit carries a lantern.", images: [] }];
  const empty = buildManuscriptCoverageContext({ input, plan, pages, images: [] });
  expect(empty.characters).toHaveLength(1);
  expect(empty.mediaInventory?.characterReferenceCount).toBe(0);
  const reference = { id: "reference", type: "CHARACTER_REFERENCE", path: "reference.png", metadata: {} };
  const withReference = buildManuscriptCoverageContext({ input, plan, pages, images: [reference] });
  expect(withReference.mediaInventory).toEqual({ storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 1 });
  expect(withReference.storyPageWordCounts).toEqual([{ index: 1, words: 4 }]);
});

it("persists a generic no-images binding across restart and rechecks all three asset scopes without a model call", async () => {
  const promise = "Keep every planned page text-only: zero interior illustrations, no cover image, and no character reference images.";
  const brief = "Do not create interior illustrations, a cover image, or character reference images.";
  const requirements = [
    { text: "No interior illustrations", quote: "Do not create interior illustrations", kind: "media_absence", mediaScope: "story_pages" },
    { text: "No cover image", quote: "a cover image", kind: "media_absence", mediaScope: "cover" },
    { text: "No character reference images", quote: "character reference images", kind: "media_absence", mediaScope: "character_references" }
  ];
  const input = createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 30, mediaSettings: { includeCover: false } });
  const pages = Array.from({ length: 30 }, (_, i) => ({ id: `page-${i + 1}`, index: i + 1, title: "", revision: 1,
    markdown: "Rabbit and Turtle carried their lantern home.", images: [] }));
  const model = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  const replies = [{ complete: true, requirements }, { complete: true, requirements: [{ id: "promise-1", status: "unverified",
    reason: "Asset facts are pending.", evidence: [], deliveryBinding: { promiseQuote: promise, fullyRepresented: true,
      requirements: requirements.map((r, i) => ({ id: `brief-${i + 1}`, quote: r.quote })) } }] }];
  model.generateJson = async request => {
    calls.push(request);
    if (!replies.length) throw new Error("Unexpected extra review");
    const reply = replies.shift();
    return { data: request.schema.parse(reply), text: JSON.stringify(reply), model: "fixture", provider: "fixture" };
  };
  const cache = new Map<string, unknown>();
  const evidenceContext = buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input), pages, images: [] });
  const options = { brief, promises: [promise], pages, chapters: [], evidenceContext, textModel: model };
  const first = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache), evidenceContext: { ...evidenceContext, mediaInventory: {} } });
  expect(first.stored.review.requirements.at(-1)?.status).toBe("unverified");
  const final = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(final.stored.review.status).toBe("reviewed");
  expect(final.stored.review.requirements.at(-1)?.deliveryChecks).toHaveLength(3);
  for (const mediaInventory of [
    { storyPagesWithArtwork: [1], coverArtworkCount: 0, characterReferenceCount: 0 },
    { storyPagesWithArtwork: [], coverArtworkCount: 1, characterReferenceCount: 0 },
    { storyPagesWithArtwork: [], coverArtworkCount: 0, characterReferenceCount: 1 }
  ]) {
    const changed = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache), evidenceContext: { ...evidenceContext, mediaInventory } });
    expect(changed.stored.review.requirements.at(-1)?.status).toBe("missing");
    expect(changed.issues.some(i => i.code === "UNPAID_PROMISE")).toBe(true);
  }
  expect(calls).toHaveLength(2); // One inventory, one coverage review; no correction or reread.
});
