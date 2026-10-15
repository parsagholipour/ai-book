import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processNextSource } from "./sourceProcessing.js";
import { currentProviderSpendUserId } from "./providerSpendUser.js";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(), refund: vi.fn(), chunks: vi.fn(), count: vi.fn(), overview: vi.fn(),
  tx: { $queryRaw: vi.fn(), sourceExtraction: { updateMany: vi.fn() }, sourceChunk: { update: vi.fn() } },
  config: { MOCK_AI: true, GEMINI_TEXT_MODEL: "gemini-text", GEMINI_OCR_MODEL: undefined as string | undefined },
  createProviders: vi.fn(), createTextModelAdapter: vi.fn(), createSourceOcr: vi.fn(),
  extractSource: vi.fn(), summarizeSource: vi.fn(),
  createLoggedProviders: vi.fn(), recordProviderUsage: vi.fn(), storageGet: vi.fn()
}));
vi.mock("./config.js", () => ({ config: mocks.config }));
vi.mock("./sourceBackfill.js", () => ({ backfillLegacySources: vi.fn() }));
vi.mock("./sourceLegacyPlans.js", () => ({ backfillLegacyPlanSources: vi.fn() }));
vi.mock("@book-maker/core", () => ({
  createProviders: mocks.createProviders, createSourceOcr: mocks.createSourceOcr,
  createTextModelAdapter: mocks.createTextModelAdapter,
  resolveTextModelSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }),
  chunkSourceSection: vi.fn(), extractSource: mocks.extractSource, summarizeSource: mocks.summarizeSource, summarizeSourceOverview: mocks.overview
}));
vi.mock("@book-maker/storage", () => ({ objectKey: (...parts: string[]) => parts.join("/"), objectStore: () => ({ get: mocks.storageGet }) }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: mocks.createLoggedProviders }));
vi.mock("../providers/usageAccounting.js", () => ({ recordProviderUsage: mocks.recordProviderUsage }));
vi.mock("@book-maker/db/billing", () => ({ refundAiProcessingUsageTx: mocks.refund }));
vi.mock("@book-maker/db", () => ({ prisma: {
  $queryRaw: mocks.claim,
  $transaction: (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx),
  sourceDocument: { findUniqueOrThrow: async () => ({ id: "source-a", userId: "user-a", storageDraftId: "draft-a", name: "page.png", mimeType: "image/png" }) },
  sourceChunk: { findMany: mocks.chunks, count: mocks.count },
  sourceExtraction: { findUniqueOrThrow: async () => ({ unreadable: [] }), updateMany: mocks.tx.sourceExtraction.updateMany }
} }));

const job = { sourceId: "source-a", version: 2, extractionComplete: true, usage: {}, checkpoints: [], attempts: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.MOCK_AI = true;
  mocks.createProviders.mockReturnValue({});
  mocks.createSourceOcr.mockReturnValue(undefined);
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

describe("source processing provider calls", () => {
  const text = { generateJson: vi.fn(), generateText: vi.fn(), generateWithTools: vi.fn(), streamText: vi.fn() };
  const embedding = { embed: vi.fn() };
  beforeEach(() => {
    mocks.config.MOCK_AI = false;
    mocks.createProviders.mockReturnValue({ text: { sdkRetrying: true }, embedding: { raw: true } });
    mocks.createTextModelAdapter.mockReturnValue({ withoutSdkRetries: true });
    mocks.createLoggedProviders.mockReturnValue({ text, embedding });
    embedding.embed.mockResolvedValue([0.1]);
    mocks.summarizeSource.mockImplementation(async (content: string, model: { generateJson: (options: unknown) => Promise<{ data: { summary: string } }> }) =>
      (await model.generateJson({ messages: [{ role: "user", content }] })).data.summary);
    mocks.chunks.mockResolvedValue([{ ordinal: 0, content: "chunk one", summary: "", locator: "page 1", embedding: null }]);
  });
  afterEach(() => vi.useRealTimers());

  it("builds the text model with no SDK retries and routes it through the logging decorators, costed to the owner", async () => {
    let spentFor: string | null | undefined;
    text.generateJson.mockImplementation(async () => {
      spentFor = await currentProviderSpendUserId();
      return { data: { summary: "a summary" }, usage: { promptTokens: 10, outputTokens: 5 } };
    });

    await processNextSource();

    expect(mocks.createTextModelAdapter).toHaveBeenCalledWith(mocks.config, { provider: "deepseek", model: "deepseek-chat" }, { maxRetries: 0 });
    const [loggedJob, wrapped] = mocks.createLoggedProviders.mock.calls[0]!;
    // The SDK-retrying model never reaches a call; the embedding is wrapped too.
    expect(wrapped).toEqual({ text: { withoutSdkRetries: true }, embedding: { raw: true } });
    // No project and no GenerationJob row: the run log is the owner's, and no
    // row id reaches a cost row's foreign key or a stop poll.
    expect(loggedJob.data).toEqual({ userId: "user-a" });
    expect(text.generateJson).toHaveBeenCalled();
    expect(embedding.embed).toHaveBeenCalledWith("chunk one");
    expect(spentFor).toBe("user-a");
  });

  it("aborts the call in flight, and makes no more, when the lease renewal finds the source gone", async () => {
    vi.useFakeTimers();
    let leaseLost = false;
    mocks.tx.sourceExtraction.updateMany.mockImplementation(async () => ({ count: leaseLost ? 0 : 1 }));
    let callSignal: AbortSignal | undefined;
    text.generateJson.mockImplementation((options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      callSignal = options.signal;
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
    }));
    mocks.chunks.mockResolvedValue([
      { ordinal: 0, content: "chunk one", summary: "", locator: "page 1", embedding: null },
      { ordinal: 1, content: "chunk two", summary: "", locator: "page 2", embedding: null }
    ]);

    const processing = processNextSource();
    await vi.advanceTimersByTimeAsync(0);
    expect(callSignal?.aborted).toBe(false);
    // Deleted with its draft: the next renewal claims nothing.
    leaseLost = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await processing;

    expect(callSignal?.aborted).toBe(true);
    expect(text.generateJson).toHaveBeenCalledTimes(1);
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("writes a cost row for each cloud OCR page, against the owner, from Gemini's own counts", async () => {
    mocks.chunks.mockResolvedValue([]);
    mocks.storageGet.mockResolvedValue(Buffer.from("png"));
    mocks.claim.mockResolvedValue([{ ...job, extractionComplete: false }]);
    mocks.createSourceOcr.mockReturnValue(async () => ({ content: "page text", unreadable: [], inputTokens: 1200, outputTokens: 300 }));
    let spentFor: string | null | undefined;
    mocks.recordProviderUsage.mockImplementation(async () => { spentFor = await currentProviderSpendUserId(); });
    mocks.extractSource.mockImplementation(async (_input: unknown, options: { ocr: (data: Buffer, mimeType: string) => Promise<unknown> }) => {
      await options.ocr(Buffer.from("png"), "image/png");
      return [];
    });

    await processNextSource();

    expect(mocks.recordProviderUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: "gemini",
      model: "gemini-text",
      purpose: "source-ocr",
      projectId: undefined,
      generationJobId: undefined,
      usage: { promptTokens: 1200, outputTokens: 300 }
    }));
    expect(spentFor).toBe("user-a");
  });

  it("writes no OCR cost row for a page the local OCR read", async () => {
    mocks.chunks.mockResolvedValue([]);
    mocks.storageGet.mockResolvedValue(Buffer.from("png"));
    mocks.claim.mockResolvedValue([{ ...job, extractionComplete: false }]);
    mocks.createSourceOcr.mockReturnValue(async () => ({ content: "page text", unreadable: [] }));
    mocks.extractSource.mockImplementation(async (_input: unknown, options: { ocr: (data: Buffer, mimeType: string) => Promise<unknown> }) => {
      await options.ocr(Buffer.from("png"), "image/png");
      return [];
    });

    await processNextSource();
    expect(mocks.recordProviderUsage).not.toHaveBeenCalled();
  });
});
