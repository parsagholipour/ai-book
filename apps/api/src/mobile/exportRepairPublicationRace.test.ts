import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import { ensureExportRepairQueued } from "./exportRepair.js";
import {
  fakeDedupingQueue,
  publishAtPendingCompileRead,
  readProjectFile,
  repairStorage,
  serializeTransactions
} from "./testing/exportRepairHarness.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  mockProjectStatus,
  projectRecord,
  resetMobileHarness,
  state,
  statusRecord,
  teardownMobileHarness,
  writeProjectFile
} from "./testing/mobileApiHarness.js";

/**
 * Two callers, or a compile, deciding at the same instant.
 *
 * A repair is ordered on the strength of an observation — "this book has no
 * PDF" — that every caller made before it got here: the download route read the
 * file, both status surfaces stat it through `serializeExportSet`. Between that
 * look and the row being written, the canonical compile can finish and publish
 * the very file the repair is for, and a second caller can be deciding the same
 * thing about the other format. Each of those costs a whole compile of a book
 * that needs none: a Chromium render holding one of the browser pool's two
 * slots, and a reader-chapter grouping, to rebuild what is already on disk.
 *
 * So the decision re-reads both halves — the pending compiles and the file — in
 * one Serializable transaction, in that order. The tests below drive the
 * interleavings deterministically rather than by timing.
 */

const OWNED_PROJECT = {
  id: "project-a",
  title: "Owned Mobile Book",
  status: "COMPLETE",
  currentPlanId: "plan-1",
  contentRevision: 7
};

describe("mobile export repair publication races", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("does not queue a second compile while one is already running", async () => {
    // The collapse the old shared dedupe key was there for, done by reading the
    // job's state instead — so it holds whatever key that compile used.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(OWNED_PROJECT);
    mockPrisma.generationJob.findFirst.mockResolvedValue({ id: "job-in-flight" });
    const app = await buildMobileApp();

    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        app.inject({
          method: "GET",
          url: "/api/mobile/projects/project-a/export/pdf",
          headers: bearer("token-a")
        })
      )
    );

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404]);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("collapses a burst of downloads onto one repair", async () => {
    // The reader, the saved-export card and the actions menu can all fire at
    // once; they must not fork a compile each.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(OWNED_PROJECT);
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const app = await buildMobileApp();

    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        app.inject({
          method: "GET",
          url: "/api/mobile/projects/project-a/export/pdf",
          headers: bearer("token-a")
        })
      )
    );

    // Same key every time, so the unique index on `dedupeKey` leaves one job.
    const keys = new Set(vi.mocked(enqueueGenerationJob).mock.calls.map((call) => call[0].dedupeKey));
    expect(keys.size).toBe(1);
    await app.close();
  });

  it("does not fork a second compile when the PDF and the EPUB are repaired at once", async () => {
    // The burst above collapses on the unique index because every caller
    // computes the same key. A PDF caller and an EPUB caller do not — the two
    // formats carry different keys on purpose — so nothing but the pending-compile
    // read stands between them, and a read followed by an insert is two
    // statements. Both then compile the whole book, taking both of the browser
    // pool's slots and both missing the reader-chapter cache, to rebuild one file.
    const project = { id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 };
    const queued = fakeDedupingQueue();
    // The read the race turns on, answered from the same rows the queue holds
    // rather than a fixed null.
    mockPrisma.generationJob.findFirst.mockImplementation(
      async () => [...queued.values()].find((job) => job.status === "QUEUED" || job.status === "ACTIVE") ?? null
    );
    serializeTransactions();

    await Promise.all([
      ensureExportRepairQueued(project, "pdf", repairStorage()),
      ensureExportRepairQueued(project, "epub", repairStorage())
    ]);

    expect(queued.size).toBe(1);
  });

  it("stands down when the compile publishes the PDF between the caller's look and the decision", async () => {
    // The window the caller's own check cannot cover. A compile finishing in
    // between leaves the pending read with nothing to find, and the repair then
    // bought the book a second whole compile of a manuscript that already has
    // its file.
    //
    // The publication lands *during* the pending read on purpose: that is the
    // interleaving a real compile produces, and it is what pins the check to the
    // serialized decision point — a look taken any earlier would still see the
    // file missing and queue the compile.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(OWNED_PROJECT);
    publishAtPendingCompileRead("book.pdf", "%PDF-from-the-canonical-compile");
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    // The request keeps the answer it had already decided on — it read no bytes
    // — and the app polls through it. What it must not do is order a compile.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EXPORT_NOT_READY");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(queued.size).toBe(0);
    // And the file the compile just published is exactly as it left it.
    expect(readProjectFile("book.pdf")).toBe("%PDF-from-the-canonical-compile");
    await app.close();
  });

  it("stands down when the compile publishes the EPUB between the caller's look and the decision", async () => {
    // The EPUB half of the same race. Its repair carries a key of its own, so
    // nothing but this check stands between an EPUB download that lands a
    // moment late and a whole compile of a book that has both files.
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-present");
    mockPrisma.project.findFirst.mockResolvedValue(OWNED_PROJECT);
    publishAtPendingCompileRead("book.epub", "epub-from-the-canonical-compile");
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    expect(queued.size).toBe(0);
    expect(readProjectFile("book.epub")).toBe("epub-from-the-canonical-compile");
    await app.close();
  });

  it("still repairs the format that is missing when the compile published only the other one", async () => {
    // The check is per file, not per project. A compile that produced a PDF and
    // failed its EPUB conversion publishes one artifact and completes, which is
    // the EPUB-only outage the format-specific key exists for — standing down on
    // "some export appeared" would leave that book with no EPUB and no surface
    // able to ask for one.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(OWNED_PROJECT);
    publishAtPendingCompileRead("book.pdf", "%PDF-from-the-canonical-compile");
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(queued.size).toBe(1);
    const [job] = [...queued.values()];
    expect(job?.dedupeKey).toContain("compile-export:project-a:plan-1:repair-epub-7-");
    await app.close();
  });

  it("stands down on the status surfaces too, and leaves the publication's provenance record alone", async () => {
    // The status poll and the stream are where a missing export is actually
    // noticed — every download surface is gated on `export.available` — so they
    // are also where a compile landing mid-decision costs a redundant one.
    //
    // Presence is the whole predicate, and the record beside the file is neither
    // consulted nor touched: it is written by the publisher inside the
    // transaction that installed the bytes, and it is what tells the reader which
    // compile it downloaded. A repair that rewrote or removed it would strand
    // that download with bytes of unknown provenance.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    const provenance = JSON.stringify({
      revision: 7,
      digest: "a".repeat(64),
      byteSize: 24,
      publishedAt: "2026-06-15T12:00:00.000Z"
    });
    publishAtPendingCompileRead("book.pdf", "%PDF-from-the-canonical-compile", () => {
      writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-from-the-canonical-compile");
      writeProjectFile(state.bookStorageDir, "project-a", "book.pdf.provenance.json", provenance);
    });
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    // The poll route, and the stream the app actually subscribes to — which
    // re-reads the project through `ensureExportRepairQueuedFor` before it
    // decides anything.
    const poll = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status",
      headers: bearer("token-a")
    });
    const stream = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status/events",
      headers: bearer("token-a")
    });

    expect(poll.statusCode).toBe(200);
    expect(stream.statusCode).toBe(200);
    expect(queued.size).toBe(0);
    expect(readProjectFile("book.pdf")).toBe("%PDF-from-the-canonical-compile");
    expect(readProjectFile("book.pdf.provenance.json")).toBe(provenance);
  });

  it("stands down on both formats at once when the compile publishes the whole set", async () => {
    // The concurrent pair from the fork test above, decided against a compile
    // that lands underneath both of them. The pending-compile read cannot
    // separate them — it comes back empty for each — and the two carry different
    // keys by design, so without the file check this is two compiles of a book
    // that has just been compiled.
    const project = { id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 };
    const queued = fakeDedupingQueue();
    let reads = 0;
    mockPrisma.generationJob.findFirst.mockImplementation(async () => {
      reads += 1;
      // The compile finishes while the first of the two is deciding; the second
      // finds both files already there.
      if (reads === 1) {
        writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-published");
        writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-published");
      }
      return [...queued.values()].find((job) => job.status === "QUEUED" || job.status === "ACTIVE") ?? null;
    });
    serializeTransactions();

    await Promise.all([
      ensureExportRepairQueued(project, "pdf", repairStorage()),
      ensureExportRepairQueued(project, "epub", repairStorage())
    ]);

    expect(queued.size).toBe(0);
    expect(reads).toBe(2);
  });

  it("still queues when the file is genuinely gone and an unrelated one was published", async () => {
    // The guard must not become a reason never to repair. A project directory
    // holding the markdown but no PDF is exactly what an interrupted publication
    // leaves behind, and it is the state this lane exists for.
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.md", "# Owned Mobile Book");
    mockPrisma.project.findFirst.mockResolvedValue(OWNED_PROJECT);
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(queued.size).toBe(1);
    const [job] = [...queued.values()];
    expect(job?.dedupeKey).toContain("compile-export:project-a:plan-1:repair-7-");
    await app.close();
  });
});
