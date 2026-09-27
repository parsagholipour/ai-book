import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, manuscriptCoverageSchema, type GenerateJsonOptions } from "@book-maker/core";
import captures from "../../../../packages/core/src/generation/testing/mixedDeliveryPromises2124.json" with { type: "json" };

vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";
import { finalizationFingerprint, manuscriptFinalizationFingerprint } from "./compileFinalization.js";

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

it.each(captures)("finalizes $tier's mixed promise, invalidates the old contract and reuses narrative evidence after restart", async capture => {
  const input = createProjectSchema.parse({ prompt: capture.brief, category: "KIDS", targetPages: 30, mediaSettings: { includeCover: false } });
  const pages = capture.pages.map(p => ({ ...p, id: `page-${p.index}`, title: `Page ${p.index}`, revision: 1, images: [] }));
  const evidenceContext = buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input), pages, images: [] });
  const inventory = { brief: capture.brief, status: "available", complete: true, requirements: capture.requirements };
  const cache = new Map<string, unknown>();
  cache.set(`inventory:${finalizationFingerprint({ version: 5, brief: capture.brief })}`, inventory);
  cache.set(`coverage:${finalizationFingerprint({ version: 11, requirementTargets: [], operation: "operation", configuration: "configuration",
    manuscript: manuscriptFinalizationFingerprint(pages), brief: capture.brief, promises: [capture.promise], chapters: [],
    evidenceContext: { ...evidenceContext, illustratedPageIndexes: [], mediaInventory: {} } })}`,
  { status: "incomplete", assessmentComplete: true, requirements: [{ ...capture.recordedVerdict,
    id: "promise-1", source: "promise", kind: "content", text: capture.promise, quote: capture.promise }] });

  const model = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  // New response contract; the historical response had only the combined verdict.
  const response = { complete: true, requirements: [{ ...capture.recordedVerdict, id: "promise-1", mixedPromiseAssessment: {
    promiseQuote: capture.promise,
    deliveryRequirements: capture.requirements.map((r, i) => ({ id: `brief-${i + 1}`, quote: r.quote })),
    narrative: { status: "fulfilled", reason: "The complete gentle story resolves at the picnic.", evidence: capture.recordedVerdict.evidence }
  } }] };
  model.generateJson = async request => {
    calls.push(request);
    if (calls.length > 1) throw new Error("Unexpected paid reread of an unchanged manuscript");
    return { data: request.schema.parse(response), text: JSON.stringify(response), model: "fixture", provider: "fixture" };
  };
  const options = { brief: capture.brief, promises: [capture.promise], pages, chapters: [], evidenceContext, textModel: model };
  const first = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache), evidenceContext: { ...evidenceContext, mediaInventory: {} } });
  expect(first.stored.review.requirements.at(-1)?.status).toBe("unverified");
  const final = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(final.stored.review.status).toBe("reviewed");
  expect(final.stored.review.requirements.at(-1)?.status).toBe("fulfilled");
  expect(final.issues).toEqual([]);
  expect(manuscriptCoverageSchema.parse(JSON.parse(JSON.stringify(final.stored.review)))).toEqual(final.stored.review);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]!.messages[1]!.content).evidenceContext.mediaInventory).toEqual({});

  const withArtwork = buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input),
    pages: pages.map(p => ({ ...p, images: p.index === 4 ? [{ type: "SCENE_ILLUSTRATION" }] : [] })), images: [] });
  const failed = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache), evidenceContext: withArtwork });
  expect(failed.stored.review.requirements.at(-1)?.status).toBe("missing");
  expect(failed.issues.some(issue => issue.code === "UNPAID_PROMISE")).toBe(true);
  expect(calls).toHaveLength(1);
});
