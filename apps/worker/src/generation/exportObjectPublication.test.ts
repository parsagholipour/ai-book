import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryObjectStore, setObjectStoreForTests, withTemporaryDirectory } from "@book-maker/storage";
import { installArtifacts, restoreSupersededArtifacts, type ArtifactPublication } from "./exportArtifacts.js";

/** Exercise bytes and failure outcomes against the object-store contract, not a POSIX mock. */
describe("object export publication rollback", () => {
  let store: MemoryObjectStore;
  beforeEach(() => { store = new MemoryObjectStore(); setObjectStoreForTests(store); });

  async function candidates(directory: string): Promise<ArtifactPublication[]> {
    return Promise.all(["md", "pdf"].map(async (format) => {
      const pending = join(directory, `candidate.${format}`);
      await writeFile(pending, `new-${format}`);
      return { pending, live: `books/p/book.${format}`, superseded: `books/p/.backup.${format}`, parked: false, installed: false };
    }));
  }

  it("restores all prior bytes after a partially installed set", async () => {
    await store.put("books/p/book.md", "old-md");
    await store.put("books/p/book.pdf", "old-pdf");
    const original = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, data, options) => {
      if (key === "books/p/book.pdf" && data.toString() === "new-pdf") throw new Error("upload failed");
      return original(key, data, options);
    });
    await withTemporaryDirectory("publication-test", async (directory) => {
      const set = await candidates(directory);
      await expect(installArtifacts(set)).rejects.toThrow("upload failed");
      await restoreSupersededArtifacts(set);
    });
    expect((await store.get("books/p/book.md"))?.toString()).toBe("old-md");
    expect((await store.get("books/p/book.pdf"))?.toString()).toBe("old-pdf");
    expect((await store.list("books/p/")).map((item) => item.key)).toEqual(["books/p/book.md", "books/p/book.pdf"]);
  });

  it("removes an upload that landed before its acknowledgement failed on a first publication", async () => {
    const original = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, data, options) => {
      await original(key, data, options);
      if (key === "books/p/book.pdf") throw new Error("connection lost after upload");
    });
    await withTemporaryDirectory("publication-test", async (directory) => {
      const set = await candidates(directory);
      await expect(installArtifacts(set)).rejects.toThrow("connection lost");
      await restoreSupersededArtifacts(set);
    });
    expect(await store.list("books/p/")).toEqual([]);
  });

  it("leaves live objects intact when copying the predecessor is denied", async () => {
    await store.put("books/p/book.md", "old-md");
    vi.spyOn(store, "copy").mockRejectedValue(new Error("AccessDenied"));
    await withTemporaryDirectory("publication-test", async (directory) => {
      const set = await candidates(directory);
      await expect(installArtifacts(set)).rejects.toThrow("AccessDenied");
      await restoreSupersededArtifacts(set);
    });
    expect((await store.get("books/p/book.md"))?.toString()).toBe("old-md");
    expect(await store.get("books/p/book.pdf")).toBeNull();
  });

  it("propagates a missing bucket instead of treating its 404 as a missing predecessor", async () => {
    vi.spyOn(store, "copy").mockRejectedValue(Object.assign(new Error("bucket missing"), {
      name: "NoSuchBucket", $metadata: { httpStatusCode: 404 }
    }));
    const uploaded = vi.spyOn(store, "put");
    await withTemporaryDirectory("publication-test", async (directory) => {
      await expect(installArtifacts(await candidates(directory))).rejects.toThrow("bucket missing");
    });
    expect(uploaded).not.toHaveBeenCalled();
  });

});
