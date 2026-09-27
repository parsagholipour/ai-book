import { expect, it, vi } from "vitest";
import { createProjectSchema, FakeTextModelAdapter, makeFallbackPlan, manuscriptCoverageSchema } from "@book-maker/core";
import capture from "../../../../packages/core/src/generation/testing/balancedDelivery0000.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: { generationJob: { findFirst: mocks.findFirst } } }));
import { buildManuscriptCoverageContext, manuscriptCoverageFingerprint, manuscriptCoverageForCompile } from "../generation/manuscriptCoverageReview.js";
import { finalizationCoverageForCompile } from "./compileExportCoverageCheckpoint.js";
import { finalizationFingerprint } from "./compileFinalization.js";

const brief = "Exactly 30 story pages. Do not create interior illustrations, a cover image, or character reference images.";
const input = createProjectSchema.parse({ prompt: brief, category: "KIDS", targetPages: 30, mediaSettings: { includeCover: false } });
const pages = capture.pages.map(p => ({ ...p, id: `page-${p.index}`, title: `Page ${p.index}`, revision: 1, images: [] }));
const context = () => buildManuscriptCoverageContext({ input, plan: makeFallbackPlan(input), pages, images: [] });
const saved = () => manuscriptCoverageSchema.parse({ status: "incomplete", assessmentComplete: true, requirements: [capture.requirement] });
const promises = [capture.requirement.quote];
type Operation = Parameters<typeof finalizationCoverageForCompile>[0]["operation"];
type Request<T> = { slot: string; fingerprint: string; parse: (value: unknown) => T | undefined; compute: () => Promise<T> };

it("refreshes the captured cached verdict through finalization and a restart without a model call", async () => {
  const model = new FakeTextModelAdapter(input);
  const generate = vi.spyOn(model, "generateJson").mockRejectedValue(new Error("Unexpected model call"));
  const cache = new Map<string, unknown>();
  cache.set(`inventory:${finalizationFingerprint({ version: 5, brief })}`,
    { brief, status: "available", complete: true, requirements: [{ kind: "page_count", text: "30 pages", quote: "Exactly 30 story pages.", expectedCount: 30 }] });
  let seeded = false;
  const operation = (): Operation => ({ state: { key: "operation", inputFingerprint: "configuration" },
    exportCheck: async <T>(request: Request<T>) => {
      const key = `${request.slot}:${request.fingerprint}`;
      if (request.slot === "coverage" && !seeded) {
        // Reuse the historical combined judgment, not a newly invented model answer.
        cache.set(key, JSON.parse(JSON.stringify(saved()))); seeded = true;
      }
      const hit = request.parse(cache.get(key));
      if (hit !== undefined) return hit;
      const result = await request.compute();
      cache.set(key, JSON.parse(JSON.stringify(result)));
      return result;
    }
  });
  const options = { brief, promises, pages, chapters: [], textModel: model };
  const pending = await finalizationCoverageForCompile({ ...options, operation: operation(), evidenceContext: { ...context(), mediaInventory: {} } });
  expect(pending.stored.review.requirements[0]?.status).toBe("unverified");
  const delivered = await finalizationCoverageForCompile({ ...options, operation: operation(), evidenceContext: context() });
  expect(delivered.stored.review.status).toBe("reviewed");
  expect(delivered.stored.review.requirements[0]?.status).toBe("fulfilled");
  expect(delivered.issues).toEqual([]);
  const prohibited = context();
  prohibited.mediaInventory!.characterReferenceCount = 1;
  const failed = await finalizationCoverageForCompile({ ...options, operation: operation(), evidenceContext: prohibited });
  expect(failed.stored.review.requirements[0]?.status).toBe("missing");
  expect(failed.issues.map(issue => issue.code)).toContain("UNPAID_PROMISE");
  expect(generate).not.toHaveBeenCalled();
});

it("refreshes a matching legacy compile cache instead of returning the stale asset warning", async () => {
  const evidenceContext = context();
  const fingerprint = manuscriptCoverageFingerprint(brief, promises, pages, [], evidenceContext);
  mocks.findFirst.mockResolvedValue({ qualityReport: { briefCoverage: { fingerprint, review: saved() } } });
  const model = new FakeTextModelAdapter(input);
  const generate = vi.spyOn(model, "generateJson").mockRejectedValue(new Error("Unexpected model call"));
  const result = await manuscriptCoverageForCompile({ projectId: "captured", brief, promises, pages, chapters: [],
    evidenceContext, allowModelReview: true, textModel: model });
  expect(result.stored.review.requirements[0]?.status).toBe("fulfilled");
  expect(result.issues).toEqual([]);
  expect(generate).not.toHaveBeenCalled();
});
