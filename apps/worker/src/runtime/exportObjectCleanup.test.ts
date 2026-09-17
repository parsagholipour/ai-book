import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStore, setObjectStoreForTests } from "@book-maker/storage";
import { sweepStaleExportObjects } from "./exportObjectCleanup.js";

const backup = "books/.export-backups/p/.book-superseded-11111111-1111-4111-8111-111111111111.pdf";
const ageMs = 24 * 60 * 60 * 1000;

describe("abandoned export object cleanup", () => {
  let store: MemoryObjectStore;
  beforeEach(() => { store = new MemoryObjectStore(); setObjectStoreForTests(store); });
  async function oldObject(key: string) {
    await store.put(key, "old");
    store.metadata.set(key, { size: 3, lastModified: new Date(Date.now() - ageMs) });
  }

  it("deletes only old publication backups, preserving books, logs and unrelated objects", async () => {
    for (const key of [backup, "books/p/book.pdf", "books/p/book.pdf.provenance.json", "books/p/runs/a.jsonl.events/1.json", "books/.export-backups/p/.book-superseded-keep.pdf"]) await oldObject(key);
    expect(await sweepStaleExportObjects()).toBe(1);
    expect(await store.get(backup)).toBeNull();
    expect(await store.list("books/")).toHaveLength(4);
  });

  it("keeps a backup whose metadata changed after listing", async () => {
    await oldObject(backup);
    vi.spyOn(store, "head").mockResolvedValue({ size: 3, lastModified: new Date() });
    expect(await sweepStaleExportObjects()).toBe(0);
    expect(await store.get(backup)).not.toBeNull();
  });

  it("keeps young objects even if the configured retention is zero", async () => {
    await store.put(backup, "new");
    expect(await sweepStaleExportObjects({ minAgeMs: 0 })).toBe(0);
    expect(await store.get(backup)).not.toBeNull();
  });
});
