import { beforeEach, describe, expect, it, vi } from "vitest";
import { retrySourceUpload, saveSourceUpload } from "./sourceAttachments.js";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  tx: {
    $queryRaw: vi.fn(),
    mobileCreationDraft: { findFirstOrThrow: vi.fn(), update: vi.fn() },
    sourceDocument: { findUnique: vi.fn(), findFirstOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() },
    sourceExtraction: { create: vi.fn() }
  }
}));
vi.mock("@book-maker/db", () => ({ prisma: { $transaction: (work: (tx: typeof mocks.tx) => unknown) => work(mocks.tx) } }));
vi.mock("@book-maker/db/billing", () => ({ consumeAiProcessingUsageTx: mocks.consume }));

const upload = { userId: "user-a", draftId: "draft-a", root: "/unused", filename: "notes.txt", data: Buffer.from("notes"), requestId: "upload-a" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tx.mobileCreationDraft.findFirstOrThrow.mockResolvedValue({ id: "draft-a", revision: 1, payload: {} });
  mocks.tx.sourceDocument.findFirstOrThrow.mockResolvedValue({
    id: "source-a", currentVersion: 1,
    extractions: [{ version: 1, status: "failed", extractionComplete: true, unreadable: [], chunks: [], checkpoints: [], fullContent: "", totalSections: 0 }]
  });
});

describe("durable source processing admission", () => {
  it.each(["MESSAGE_LIMIT_REACHED", "INSUFFICIENT_CREDITS"])("does not enqueue uploads or retries when admission fails: %s", async (code) => {
    const error = Object.assign(new Error(code), { code });
    mocks.consume.mockRejectedValue(error);
    await expect(saveSourceUpload(upload)).rejects.toBe(error);
    await expect(retrySourceUpload("user-a", "draft-a", "source-a", "retry-a", 1)).rejects.toBe(error);
    expect(mocks.tx.sourceDocument.create).not.toHaveBeenCalled();
    expect(mocks.tx.sourceExtraction.create).not.toHaveBeenCalled();
    expect(mocks.tx.sourceDocument.update).not.toHaveBeenCalled();
    expect(mocks.tx.mobileCreationDraft.update).not.toHaveBeenCalled();
  });

  it("admits new uploads and retry versions in the job transaction", async () => {
    const saved = await saveSourceUpload(upload);
    expect(mocks.consume).toHaveBeenNthCalledWith(1, mocks.tx, {
      userId: "user-a", requestKey: `processing:source:${saved.attachment.id}:1`, description: "File processing"
    });
    expect(mocks.tx.sourceDocument.create).toHaveBeenCalledOnce();
    await retrySourceUpload("user-a", "draft-a", "source-a", "retry-a", 1);
    expect(mocks.consume).toHaveBeenNthCalledWith(2, mocks.tx, {
      userId: "user-a", requestKey: "processing:source:source-a:2", description: "File processing retry"
    });
    expect(mocks.tx.sourceExtraction.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 2, retryKey: "retry-a" }) }));
  });

  it("replays a saved upload even when the allowance is exhausted", async () => {
    const saved = await saveSourceUpload(upload);
    const source = mocks.tx.sourceDocument.create.mock.calls[0]![0].data;
    mocks.tx.sourceDocument.findUnique.mockResolvedValue(source);
    mocks.tx.mobileCreationDraft.findFirstOrThrow.mockResolvedValue({ id: "draft-a", revision: saved.revision, payload: { attachments: [saved.attachment] } });
    mocks.consume.mockRejectedValue(new Error("exhausted"));
    expect(await saveSourceUpload(upload)).toEqual(saved);
    expect(mocks.consume).toHaveBeenCalledOnce();
    expect(mocks.tx.sourceDocument.create).toHaveBeenCalledOnce();
  });

  it("replays a retry without consuming another allowance or making another job", async () => {
    mocks.tx.sourceDocument.findFirstOrThrow.mockResolvedValue({ currentVersion: 2, extractions: [{ version: 2, retryKey: "retry-a", status: "queued" }] });
    mocks.consume.mockRejectedValue(new Error("exhausted"));
    await retrySourceUpload("user-a", "draft-a", "source-a", "retry-a", 1);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.tx.sourceExtraction.create).not.toHaveBeenCalled();
  });
});
