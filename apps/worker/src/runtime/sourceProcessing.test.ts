import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processNextSource } from "./sourceProcessing.js";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), refund: vi.fn(), chunks: vi.fn(), count: vi.fn(), overview: vi.fn(),
  tx: { $queryRaw: vi.fn(), sourceExtraction: { updateMany: vi.fn() }, sourceChunk: { update: vi.fn() } }
}));
vi.mock("./config.js", () => ({ config: { MOCK_AI: true } }));
vi.mock("./sourceBackfill.js", () => ({ backfillLegacySources: vi.fn() }));
vi.mock("./sourceLegacyPlans.js", () => ({ backfillLegacyPlanSources: vi.fn() }));
vi.mock("@book-maker/core", () => ({
  createProviders: () => ({}), createSourceOcr: () => undefined,
  chunkSourceSection: vi.fn(), extractSource: vi.fn(), summarizeSource: vi.fn(), summarizeSourceOverview: mocks.overview
}));
vi.mock("@book-maker/db/billing", () => ({ refundAiProcessingUsageTx: mocks.refund }));
vi.mock("@book-maker/db", () => ({ prisma: {
  $queryRaw: mocks.claim,
  $transaction: (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx),
  sourceDocument: { findUniqueOrThrow: async () => ({ id: "source-a", userId: "user-a" }) },
  sourceChunk: { findMany: mocks.chunks, count: mocks.count },
  sourceExtraction: { findUniqueOrThrow: async () => ({ unreadable: [] }), updateMany: mocks.tx.sourceExtraction.updateMany }
} }));

const job = { sourceId: "source-a", version: 2, extractionComplete: true, usage: {}, checkpoints: [], attempts: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.claim.mockResolvedValue([job]);
  mocks.chunks.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.overview.mockResolvedValue("");
  mocks.tx.sourceExtraction.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe("source processing credit refunds", () => {
  it("refunds an unreadable source in the transaction that marks it failed", async () => {
    expect(await processNextSource()).toBe(true);
    expect(mocks.tx.sourceExtraction.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
    expect(mocks.refund).toHaveBeenCalledExactlyOnceWith(mocks.tx, "user-a", "processing:source:source-a:2");
  });

  it.each([
    { attempts: 1, readable: 0, status: "queued", refunds: 0 },
    { attempts: 3, readable: 0, status: "failed", refunds: 1 },
    { attempts: 3, readable: 1, status: "partial", refunds: 0 }
  ])("settles a failed attempt as $status", async ({ attempts, readable, status, refunds }) => {
    mocks.claim.mockResolvedValue([{ ...job, attempts }]);
    mocks.overview.mockRejectedValue(new Error("provider unavailable"));
    mocks.count.mockResolvedValue(readable);
    await processNextSource();
    expect(mocks.tx.sourceExtraction.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status }) }));
    expect(mocks.refund).toHaveBeenCalledTimes(refunds);
  });

  it("does not refund after another worker takes the lease", async () => {
    mocks.claim.mockResolvedValue([{ ...job, attempts: 3 }]);
    mocks.tx.sourceExtraction.updateMany.mockResolvedValue({ count: 0 });
    await processNextSource();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("keeps the charge when readable content is delivered", async () => {
    mocks.chunks.mockResolvedValue([{ ordinal: 0, content: "readable text", summary: "summary", locator: "page 1", embedding: [1] }]);
    await processNextSource();
    expect(mocks.tx.sourceExtraction.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }));
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});
