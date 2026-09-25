import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectSchema, type BookPlan, type BookGenerationStrategy } from "@book-maker/core";

const mocks = vi.hoisted(() => ({
  project: { contentRevision: 0, currentPlanId: "plan", status: "GENERATING" },
  query: vi.fn(), pages: vi.fn(), assets: vi.fn(), upsert: vi.fn(), attempt: vi.fn(), dispatch: vi.fn(),
  transaction: vi.fn(), committed: false
}));
vi.mock("@book-maker/db", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("../runtime/dispatch.js", () => ({ dispatchWorkerGenerationJob: mocks.dispatch }));
import { enqueueFinalizationIllustrations } from "./finalizationIllustrations.js";
import { runWithGenerationAttempt } from "../runtime/generationAttemptContext.js";
import { pageIllustrationKeeperToken } from "./pageIllustrationOwnership.js";
import { pageIllustrationVisualContract } from "./pageIllustrationVisualContract.js";

const input = createProjectSchema.parse({ title: "Lantern Path", prompt: "Rabbit and Turtle restore the lantern path.",
  category: "KIDS", targetPages: 30, complexity: 3, language: "en", temperature: 0.8,
  mediaSettings: { finalReview: true, fullIllustrations: true } });
const plan = { characters: [], illustrationPlan: { globalStyle: "Watercolor", pageRules: [] } } as unknown as BookPlan;
const strategy = { shouldIllustratePage: () => true } as unknown as BookGenerationStrategy;
const options = { projectId: "project", planId: "plan", contentRevision: 0, input, plan, strategy };
const page = () => ({ id: "page-1", projectId: "project", index: 1, title: "Lantern", markdown: "Rabbit raises a lantern.",
  summary: "Rabbit raises it.", imagePrompt: "Rabbit holding a lantern", revision: 3, status: "COMPLETED", imageFailureReason: null, images: [] as unknown[] });

describe("finalization illustration handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.project = { contentRevision: 0, currentPlanId: "plan", status: "GENERATING" };
    mocks.committed = false;
    mocks.query.mockImplementation(async () => [mocks.project]);
    mocks.pages.mockResolvedValue([page()]);
    mocks.assets.mockResolvedValue([]);
    mocks.attempt.mockResolvedValue({ status: "ACTIVE" });
    mocks.upsert.mockResolvedValue({ id: "image-job", status: "QUEUED" });
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      const result = await run({ $queryRaw: mocks.query, page: { findMany: mocks.pages }, imageAsset: { findMany: mocks.assets },
        generationJob: { upsert: mocks.upsert }, generationAttempt: { findUnique: mocks.attempt } });
      mocks.committed = true;
      return result;
    });
    mocks.dispatch.mockImplementation(async () => { expect(mocks.committed).toBe(true); });
  });

  it("persists exact keeper jobs before dispatch and reuses the same dedupe on redelivery", async () => {
    await runWithGenerationAttempt("paid-attempt", async () => {
      expect(await enqueueFinalizationIllustrations(options)).toEqual({ kind: "ready", pendingJobIds: ["image-job"], missingPageIndexes: [] });
      await enqueueFinalizationIllustrations(options);
    });
    const first = mocks.upsert.mock.calls[0]![0];
    expect(first.where.dedupeKey).toMatch(/^generate-image:page-1:plan:3:v2-.+:attempt:paid-attempt$/);
    expect(mocks.upsert.mock.calls[1]![0].where).toEqual(first.where);
    expect(first.create).toMatchObject({ attemptId: "paid-attempt", contentRevision: 0, ownsQualityVerdict: false });
  });

  it("refuses a stale manuscript and a canceled paid operation", async () => {
    mocks.project.contentRevision = 1;
    expect(await enqueueFinalizationIllustrations(options)).toEqual({ kind: "superseded" });
    mocks.project.contentRevision = 0;
    mocks.attempt.mockResolvedValue({ status: "CANCELED" });
    expect(await runWithGenerationAttempt("stopped", () => enqueueFinalizationIllustrations(options))).toEqual({ kind: "superseded" });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("reuses only an illustration with this page owner and visual contract", async () => {
    const current = page();
    const keeper = { ...current, pageId: current.id };
    const asset = { id: "asset", path: "images/project/page.jpg", metadata: {
      keeperToken: pageIllustrationKeeperToken(keeper), keeperProjectId: "project", keeperPageId: current.id,
      visualContract: pageIllustrationVisualContract({ prompt: current.imagePrompt, input, plan, referenceAssets: [] })
    } };
    current.images = [asset]; mocks.pages.mockResolvedValue([current]);
    expect(await enqueueFinalizationIllustrations(options)).toEqual({ kind: "ready", pendingJobIds: [], missingPageIndexes: [] });
    expect(mocks.upsert).not.toHaveBeenCalled();
    asset.metadata.keeperPageId = "another-page";
    await enqueueFinalizationIllustrations(options);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps failed renders terminal instead of starting an endless image retry", async () => {
    mocks.upsert.mockResolvedValue({ id: "image-job", status: "COMPLETED" });
    expect(await enqueueFinalizationIllustrations(options)).toEqual({ kind: "ready", pendingJobIds: [], missingPageIndexes: [1] });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    mocks.pages.mockResolvedValue([{ ...page(), revision: 4, imagePrompt: "A new scene", imageFailureReason: "Previous scene failed" }]);
    mocks.upsert.mockResolvedValue({ id: "new-image-job", status: "QUEUED" });
    expect(await enqueueFinalizationIllustrations(options)).toMatchObject({ pendingJobIds: ["new-image-job"] });
  });

  it("preserves the durable pending handoff when Redis dispatch fails", async () => {
    mocks.dispatch.mockRejectedValue(new Error("Redis unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await enqueueFinalizationIllustrations(options)).toMatchObject({ pendingJobIds: ["image-job"] });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
