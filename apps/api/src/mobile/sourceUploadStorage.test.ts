import { describe, expect, it, vi } from "vitest";
import { seedObject, testObjectStore } from "../testing/objectStorage.js";
import { saveSourceUpload } from "./sourceAttachments.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: { $transaction: mocks.transaction } }));

const upload = (data: string) => ({
  userId: "user-a", draftId: "draft-a", root: "/unused-local-path",
  filename: "notes.txt", mimeType: "text/plain", requestId: "request-a", data: Buffer.from(data)
});

describe("source upload object identity", () => {
  it("retains original bytes when simultaneous retries reuse a request ID", async () => {
    mocks.transaction.mockResolvedValue({ attachment: {}, revision: 1 });
    const results = await Promise.allSettled([saveSourceUpload(upload("original")), saveSourceUpload(upload("different"))]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "REQUEST_CONFLICT" });
    expect([...testObjectStore.objects.values()].map((bytes) => bytes.toString())).toEqual(["original"]);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("allows an idempotent retry with identical bytes", async () => {
    mocks.transaction.mockClear().mockResolvedValue({ attachment: {}, revision: 1 });
    await saveSourceUpload(upload("original"));
    await saveSourceUpload(upload("original"));
    expect(testObjectStore.objects.size).toBe(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
  });

  it("propagates object storage failures before creating database records", async () => {
    mocks.transaction.mockClear();
    const failure = vi.spyOn(testObjectStore, "putIfAbsent").mockRejectedValueOnce(new Error("S3 unavailable"));
    try {
      await expect(saveSourceUpload(upload("original"))).rejects.toThrow("S3 unavailable");
      expect(mocks.transaction).not.toHaveBeenCalled();
    } finally {
      failure.mockRestore();
    }
  });

  it("keeps independent draft uploads isolated", async () => {
    mocks.transaction.mockResolvedValue({ attachment: {}, revision: 1 });
    seedObject("attachments/draft-b/unrelated", "another user");
    await saveSourceUpload(upload("original"));
    expect(testObjectStore.objects.get("attachments/draft-b/unrelated")?.toString()).toBe("another user");
    expect([...testObjectStore.objects.keys()].some((key) => key.startsWith("attachments/draft-a/src_"))).toBe(true);
  });
});
