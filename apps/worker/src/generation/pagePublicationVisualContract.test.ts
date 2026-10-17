import { beforeEach, expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan } from "@book-maker/core";
const mocks = vi.hoisted(() => ({
  updatePage: vi.fn(async () => ({ count: 1 })), findAssets: vi.fn(), updateAsset: vi.fn(async () => ({ count: 1 })),
  retire: vi.fn(), enqueue: vi.fn(), transaction: vi.fn(), notes: vi.fn()
}));
vi.mock("@book-maker/db", () => ({ prisma: { page: { updateMany: mocks.updatePage }, $transaction: mocks.transaction, continuityNote: { createMany: mocks.notes } }, Prisma: {}, pageScope: (index: number) => `page:${index}` }));
vi.mock("../runtime/dispatch.js", () => ({ enqueueWorkerJob: mocks.enqueue }));
import { stageGeneratedPageAndBrief, publishStagedGeneratedPage } from "./pagePublication.js";
import { pageIllustrationKeeperToken } from "./pageIllustrationOwnership.js";
import { pageIllustrationVisualContract } from "./pageIllustrationVisualContract.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle carry a lantern.", category: "KIDS", targetPages: 30 });
const plan = makeFallbackPlan(input);
const existing = { id: "page-1", status: "COMPLETED", title: "Lantern", markdown: "Rabbit asked for help.", summary: "Cooperation.", imagePrompt: "Rabbit and Turtle beside a lantern.", revision: 1, updatedAt: new Date("2026-01-01") };
const draft = { ...existing, summary: "Rabbit chooses cooperation.", continuityNotes: [] };
const visualContract = pageIllustrationVisualContract({ prompt: existing.imagePrompt, input, plan, referenceAssets: [] });
const token = pageIllustrationKeeperToken({ ...existing, projectId: "project-1", pageId: existing.id });
const asset = { id: "asset-1", path: "/old-token-asset.webp", metadata: { keeperToken: token, keeperProjectId: "project-1", keeperPageId: existing.id, visualContract } };
const client = { page: { updateMany: mocks.updatePage }, imageAsset: { findMany: mocks.findAssets, updateMany: mocks.updateAsset, deleteMany: mocks.retire } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updatePage.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async (fn) => fn(client));
  mocks.findAssets.mockResolvedValueOnce([asset]).mockResolvedValueOnce([]);
});

it("atomically adopts compatible artwork after the page claim and avoids another image job", async () => {
  const staged = await stageGeneratedPageAndBrief({ projectId: "project-1", chapterId: null, pageIndex: 1,
    draft, revision: 2, qualityReport: {} as never, status: "GENERATING", existingPage: existing,
    illustrationContext: { input, plan, planId: "plan-1" } });
  expect(staged.reusedIllustration).toBe(true);
  expect(mocks.transaction).toHaveBeenCalledOnce();
  expect(mocks.updatePage.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateAsset.mock.invocationCallOrder[0]!);
  expect(mocks.retire).not.toHaveBeenCalled();
  await publishStagedGeneratedPage({ projectId: "project-1", planId: "plan-1", pageIndex: 1, draft,
    stagedPage: staged, willIllustrate: true, continuityTags: [] });
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("cannot rebind an image after losing the exact page claim", async () => {
  mocks.updatePage.mockResolvedValue({ count: 0 });
  await expect(stageGeneratedPageAndBrief({ projectId: "project-1", chapterId: null, pageIndex: 1,
    draft, revision: 2, qualityReport: {} as never, status: "GENERATING", existingPage: existing,
    illustrationContext: { input, plan, planId: "plan-1" } })).rejects.toThrow("publication claim");
  expect(mocks.updateAsset).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("refuses stale artwork when rewritten prose changes the scene but leaves its prompt unchanged", async () => {
  const changedScene = { ...draft, markdown: "Rabbit waited alone beneath a tree. Turtle had stayed home." };
  const staged = await stageGeneratedPageAndBrief({ projectId: "project-1", chapterId: null, pageIndex: 1,
    draft: changedScene, revision: 2, qualityReport: {} as never, status: "GENERATING", existingPage: existing,
    illustrationContext: { input, plan, planId: "plan-1" } });
  expect(staged.reusedIllustration).not.toBe(true);
  expect(mocks.updateAsset).not.toHaveBeenCalled();
  expect(mocks.retire).toHaveBeenCalled();
});
