import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/exportPublicationMocks.js")).dbModuleMock());
vi.mock("node:fs/promises", async () => (await import("./testing/exportPublicationMocks.js")).fsModuleMock());
const storage = vi.hoisted(() => ({ objectStore: vi.fn() }));
vi.mock("@book-maker/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@book-maker/storage")>(),
  objectStore: storage.objectStore
}));

import {
  bookPdfCoverNumbering,
  exportContentDigest,
  exportProvenanceKey,
  readPublishedExport,
  writeExportProvenance
} from "@book-maker/core";
import { MemoryObjectStore } from "@book-maker/storage/testing";
import { pendingExportPaths, publishCompiledExports } from "./exportPublication.js";
import { mocks, RENDERED, resetExportPublicationMocks } from "./testing/exportPublicationMocks.js";

const pending = pendingExportPaths("/books/project-1", "token");
const formats = ["pdf", "epub", "docx"] as const;
const live = (format: string) => `books/project-1/book.${format}`;
const pdfRecord = exportProvenanceKey("project-1", "pdf");
let store: MemoryObjectStore;

const publish = (overrides: Partial<Parameters<typeof publishCompiledExports>[0]> = {}) =>
  publishCompiledExports({
    projectId: "project-1",
    generationJobId: "job-1",
    generationAttemptId: "attempt-1",
    pending,
    companionsProduced: { epub: true, docx: true },
    pdfPageMap: bookPdfCoverNumbering(false),
    contentRevision: 7,
    expectedProjectStatus: "GENERATING",
    status: "COMPLETE",
    ownsProjectStatus: true,
    ...overrides
  });

beforeEach(async () => {
  resetExportPublicationMocks();
  store = new MemoryObjectStore();
  storage.objectStore.mockReturnValue(store);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await store.put(live("md"), "# Old manuscript");
  for (const format of formats) {
    const bytes = Buffer.from(`old-${format}`);
    await store.put(live(format), bytes);
    await writeExportProvenance({
      projectId: "project-1", format, revision: 6,
      digest: exportContentDigest(bytes), byteSize: bytes.length
    });
  }
});

afterEach(() => vi.restoreAllMocks());

describe("publication provenance outages", () => {
  it("commits the rendered book and paid attempt when only the PDF sidecar PUT fails", async () => {
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      if (key === pdfRecord) throw new Error("S3 sidecar upload failed");
      return put(key, bytes, options);
    });

    await expect(publish()).resolves.toMatchObject({ published: true });

    expect(mocks.events).toContain("commit");
    expect(mocks.events).not.toContain("rollback");
    expect(mocks.prisma.generationAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUCCEEDED", refundPending: false })
    }));
    expect(await store.get(live("md"))).toEqual(RENDERED[pending.markdown]);
    for (const format of formats) {
      const artifact = await readPublishedExport("project-1", format);
      expect(artifact?.bytes).toEqual(RENDERED[pending[format]]);
      expect(artifact?.provenance).toMatchObject(format === "pdf"
        ? { state: "unknown" }
        : { state: "exact", revision: 7 });
    }
    // The API heals unknown records under its row lock; a stale mismatched
    // record would prevent that metadata-only repair indefinitely.
    expect(await store.get(pdfRecord)).toBeNull();
    expect(await store.list("books/.export-backups/")).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("retires stale metadata and continues other sidecars when its backup COPY fails", async () => {
    const copy = store.copy.bind(store);
    vi.spyOn(store, "copy").mockImplementation(async (from, to) => {
      if (from === pdfRecord) throw new Error("sidecar backup unavailable");
      return copy(from, to);
    });

    await expect(publish()).resolves.toMatchObject({ published: true });

    expect(await readPublishedExport("project-1", "pdf")).toMatchObject({
      bytes: RENDERED[pending.pdf], provenance: { state: "unknown" }
    });
    expect((await readPublishedExport("project-1", "docx"))?.provenance).toMatchObject({
      state: "exact", revision: 7
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("removes an acknowledged-as-failed sidecar PUT that actually reached storage", async () => {
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      await put(key, bytes, options);
      if (key === pdfRecord) throw new Error("sidecar PUT acknowledgement lost");
    });

    await expect(publish()).resolves.toMatchObject({ published: true });

    expect(await readPublishedExport("project-1", "pdf")).toMatchObject({
      bytes: RENDERED[pending.pdf], provenance: { state: "unknown" }
    });
    expect(await store.get(pdfRecord)).toBeNull();
  });

  it("keeps the book readable without claiming a revision when stale-record cleanup also fails", async () => {
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      if (key === pdfRecord) throw new Error("sidecar PUT unavailable");
      return put(key, bytes, options);
    });
    const remove = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      if (key === pdfRecord) throw new Error("sidecar DELETE unavailable");
      return remove(key);
    });

    await expect(publish()).resolves.toMatchObject({ published: true });

    const artifact = await readPublishedExport("project-1", "pdf");
    expect(artifact?.bytes).toEqual(RENDERED[pending.pdf]);
    expect(artifact?.provenance).toMatchObject({ state: "mismatch" });
    expect(artifact?.provenance).not.toHaveProperty("revision");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to remove uncertain export provenance"), expect.any(Error)
    );
  });

  it("retires a failed companion even when deleting its provenance is unavailable", async () => {
    const record = exportProvenanceKey("project-1", "epub");
    const remove = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      if (key === record) throw new Error("sidecar DELETE unavailable");
      return remove(key);
    });

    await expect(publish({ companionsProduced: { epub: false, docx: true } }))
      .resolves.toMatchObject({ published: true });

    expect(await readPublishedExport("project-1", "epub")).toBeNull();
    expect((await readPublishedExport("project-1", "pdf"))?.provenance)
      .toMatchObject({ state: "exact", revision: 7 });
    expect(console.error).toHaveBeenCalled();
  });

  it("does not fail the book when deleting a committed sidecar backup fails", async () => {
    const remove = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      if (key.startsWith("books/.export-backups/") && key.endsWith(".provenance.json")) {
        throw new Error("backup DELETE unavailable");
      }
      return remove(key);
    });

    await expect(publish()).resolves.toMatchObject({ published: true });

    expect((await readPublishedExport("project-1", "pdf"))?.provenance)
      .toMatchObject({ state: "exact", revision: 7 });
    expect(await store.list("books/.export-backups/")).toHaveLength(3);
  });

  it.each([false, true])("rolls sidecars back with SQL even after a tolerated sidecar outage: %s", async (outage) => {
    // Same bytes, two revisions: rollback must restore revision 6, not just
    // leave any record whose digest happens to match the restored PDF.
    const bytes = RENDERED[pending.pdf]!;
    await store.put(live("pdf"), bytes);
    await writeExportProvenance({
      projectId: "project-1", format: "pdf", revision: 6,
      digest: exportContentDigest(bytes), byteSize: bytes.length
    });
    if (outage) {
      const put = store.put.bind(store);
      vi.spyOn(store, "put").mockImplementation(async (key, data, options) => {
        if (key === pdfRecord && JSON.parse(data.toString()).revision === 7) {
          throw new Error("sidecar PUT unavailable");
        }
        return put(key, data, options);
      });
    }
    mocks.prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback(mocks.prisma);
      expect((await readPublishedExport("project-1", "docx"))?.provenance)
        .toMatchObject({ state: "exact", revision: 7 });
      throw new Error("SQL commit failed");
    });

    await expect(publish()).rejects.toThrow("SQL commit failed");

    expect(await store.get(live("md"))).toEqual(Buffer.from("# Old manuscript"));
    for (const format of formats) {
      expect(await readPublishedExport("project-1", format)).toMatchObject({
        bytes: format === "pdf" ? bytes : Buffer.from(`old-${format}`),
        provenance: { state: "exact", revision: 6 }
      });
    }
    expect(await store.list("books/.export-backups/")).toEqual([]);
  });

  it("removes newly installed exports and sidecars after a first publication's SQL failure", async () => {
    await store.deletePrefix("books/project-1");
    mocks.prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback(mocks.prisma);
      throw new Error("SQL commit failed");
    });

    await expect(publish()).rejects.toThrow("SQL commit failed");

    expect(await store.list("books/")).toEqual([]);
  });

  it.each(formats)("still rolls back every predecessor when the actual %s PUT loses its acknowledgement", async (format) => {
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      await put(key, bytes, options);
      if (key === live(format) && Buffer.from(bytes).equals(RENDERED[pending[format]]!)) {
        throw new Error("artifact PUT acknowledgement lost");
      }
    });

    await expect(publish()).rejects.toThrow("artifact PUT acknowledgement lost");

    expect(mocks.events).toContain("rollback");
    expect(await store.get(live("md"))).toEqual(Buffer.from("# Old manuscript"));
    for (const previous of formats) {
      expect(await readPublishedExport("project-1", previous)).toMatchObject({
        bytes: Buffer.from(`old-${previous}`), provenance: { state: "exact", revision: 6 }
      });
    }
  });

  it("still rolls back the export set when retiring an actual companion fails", async () => {
    const remove = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (key) => {
      if (key === live("epub")) throw new Error("artifact DELETE unavailable");
      return remove(key);
    });

    await expect(publish({ companionsProduced: { epub: false, docx: true } }))
      .rejects.toThrow("artifact DELETE unavailable");

    expect(mocks.events).toContain("rollback");
    for (const format of formats) {
      expect(await readPublishedExport("project-1", format)).toMatchObject({
        bytes: Buffer.from(`old-${format}`), provenance: { state: "exact", revision: 6 }
      });
    }
  });

  it("removes a new revision's record when SQL rollback cannot restore its predecessor", async () => {
    // Identical renders still belong to different revisions. A digest check
    // alone cannot reject the uncommitted revision's record after rollback.
    const bytes = RENDERED[pending.pdf]!;
    await store.put(live("pdf"), bytes);
    await writeExportProvenance({
      projectId: "project-1", format: "pdf", revision: 6,
      digest: exportContentDigest(bytes), byteSize: bytes.length
    });
    const copy = store.copy.bind(store);
    vi.spyOn(store, "copy").mockImplementation(async (from, to) => {
      if (from.startsWith("books/.export-backups/") && to === pdfRecord) {
        throw new Error("sidecar restore unavailable");
      }
      return copy(from, to);
    });
    mocks.prisma.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback(mocks.prisma);
      throw new Error("SQL commit failed");
    });

    await expect(publish()).rejects.toThrow("SQL commit failed");

    expect(await readPublishedExport("project-1", "pdf")).toMatchObject({
      bytes, provenance: { state: "unknown" }
    });
    expect(await store.get(live("md"))).toEqual(Buffer.from("# Old manuscript"));
    expect(console.error).toHaveBeenCalled();
  });
});
