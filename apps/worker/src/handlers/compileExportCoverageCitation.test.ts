import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, manuscriptRequirementInventorySchema, type GenerateJsonOptions } from "@book-maker/core";
import capture from "../../../../packages/core/src/generation/testing/balancedCoverageCitation.json" with { type: "json" };

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

it("refreshes Balanced's cached citation warning and reuses the exact corrected evidence after restart", async () => {
  const input = createProjectSchema.parse({ prompt: capture.brief, category: "KIDS", targetPages: 30, mediaSettings: { includeCover: false } });
  const pages = capture.pages.map(page => ({ ...page, id: `page-${page.index}`, title: "", revision: 1, images: [] }));
  const evidenceContext = buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input), pages, images: [] });
  const inventory = manuscriptRequirementInventorySchema.parse({ version: 1, brief: capture.brief, status: "available", complete: true,
    requirements: [capture.requirement] });
  const cache = new Map<string, unknown>();
  cache.set(`coverage:${finalizationFingerprint({ version: 13, inventory, requirementTargets: [], operation: "operation", configuration: "configuration",
    manuscript: manuscriptFinalizationFingerprint(pages), brief: capture.brief, promises: [], chapters: [],
    evidenceContext: { ...evidenceContext, illustratedPageIndexes: [], mediaInventory: {} } })}`,
  { status: "incomplete", assessmentComplete: true, requirements: [{ ...capture.requirement, id: "brief-1",
    status: "unverified", reason: "The quote did not match the source passage.", evidence: [] }] });

  const model = new FakeTextModelAdapter(input);
  const calls: GenerateJsonOptions<unknown>[] = [];
  const replies: unknown[] = [{ complete: true, requirements: [{ ...capture.verdict, id: "brief-1" }] }, capture.recoveredCorrection];
  model.generateJson = async request => {
    calls.push(request);
    if (!replies.length) throw new Error("Unexpected extra coverage call");
    const reply = replies.shift();
    return { data: request.schema.parse(reply), text: JSON.stringify(reply), model: "fixture", provider: "fixture" };
  };
  const options = { brief: capture.brief, promises: [], pages, chapters: [], evidenceContext, inventory, textModel: model };
  const result = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(result.issues).toEqual([]);
  expect(result.stored.review.requirements[0]).toMatchObject({ status: "fulfilled", reason: capture.verdict.reason,
    evidence: [capture.verdict.evidence[0], { pageIndex: 27, quote: capture.exactQuote }] });
  expect(calls).toHaveLength(2);
  const afterRestart = await finalizationCoverageForCompile({ ...options, operation: durableOperation(cache) });
  expect(afterRestart).toEqual(result);
  expect(calls).toHaveLength(2);
});
