import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { ensureProjectExportEntitlementOrSpend } from "@book-maker/db/billing";
import { EXPORT_REPAIR_FORMAT } from "@book-maker/core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { exportRepairDedupeKey } from "./exportRepair.js";
// The races these surfaces can lose — two callers, or a compile publishing
// underneath the decision — are `exportRepairPublicationRace.test.ts`.
import { fakeDedupingQueue } from "./testing/exportRepairHarness.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
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

describe("mobile export repair queueing", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("queues the compile and answers EXPORT_NOT_READY instead of rendering in the request", async () => {
    // A user edit deletes the compiled files and queues the rebuild a moment
    // later, so this window is reachable. It used to run a whole unbounded
    // Chromium render inside the Fastify handler, once per request.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EXPORT_NOT_READY");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        type: "COMPILE_EXPORT",
        contentRevision: 7,
        // A repair key, not the edit recompile's normalized revision/policy
        // intent, which is spent as soon as that job settles.
        dedupeKey: expect.stringContaining("compile-export:project-a:plan-1:repair-7-"),
        // Load-bearing: without it the worker treats a failed repair as the
        // book failing, marks a COMPLETE project FAILED and refunds the reader's
        // whole book charge.
        payload: expect.objectContaining({
          detachedFromProjectLifecycle: true,
          [EXPORT_REPAIR_FORMAT]: "pdf"
        })
      })
    );
    // Nothing was charged for a file that was not delivered.
    expect(vi.mocked(ensureProjectExportEntitlementOrSpend)).not.toHaveBeenCalled();
    await app.close();
  });

  it("queues repair for a stat-able path that the download cannot read", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    // `stat` calls this available, but the route's read gets EISDIR. Repair must
    // use that same read predicate or this path can never heal.
    mkdirSync(join(state.bookStorageDir!, "project-a", "book.pdf"), { recursive: true });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EXPORT_NOT_READY");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ [EXPORT_REPAIR_FORMAT]: "pdf" }) })
    );
    await app.close();
  });

  it("dispatches a real compile once that revision's own compile has settled", async () => {
    // The failure this guards is permanent: an edit deletes the exports and
    // *then* queues its recompile, so a recompile that ends badly leaves a book
    // with no files. Borrowing that job's dedupe key meant every later download
    // enqueued nothing, and the app polled "preparing" until it gave up.
    //
    // Asserting the key alone would not have caught it — `enqueueGenerationJob`
    // is mocked, so a call always "succeeds". The queue below dedupes the way
    // the real one does (a row already under that key is returned, and nothing
    // is created), so the assertion is that a job actually exists afterwards.
    for (const settledStatus of ["COMPLETED", "FAILED"] as const) {
      mockAccessTokens({ "token-a": "user-a" });
      mockPrisma.project.findFirst.mockResolvedValue({
        id: "project-a",
        title: "Owned Mobile Book",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        contentRevision: 7
      });
      // Nothing is running: the edit's recompile for revision 7 already ended.
      mockPrisma.generationJob.findFirst.mockResolvedValue(null);
      const queued = fakeDedupingQueue();
      const editKey = "compile-export:project-a:plan-1:revision-7:policy-r1v0seoo";
      queued.set(editKey, { id: "job-edit", status: settledStatus, dedupeKey: editKey });
      const app = await buildMobileApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-a/export/pdf",
        headers: bearer("token-a")
      });

      expect(response.statusCode, settledStatus).toBe(404);
      // A second row exists, and it is QUEUED — not the settled one handed back.
      expect(queued.size, settledStatus).toBe(2);
      const dispatched = [...queued.values()].find((job) => job.id !== "job-edit");
      expect(dispatched?.status, settledStatus).toBe("QUEUED");
      expect(dispatched?.dedupeKey, settledStatus).not.toBe(editKey);
      expect(dispatched?.dedupeKey, settledStatus).toContain("repair-7-");
      await app.close();
    }
  });

  it("queues the repair from the status stream, which is the surface the app actually opens", async () => {
    // The status *stream* is what `projectStatusProvider` subscribes to; it
    // reaches the poll below only after this stream ends. Queueing solely from
    // that fallback left the first settled snapshot with nothing rebuilding,
    // and surfaces that re-subscribed here could repeat that dead end. The
    // stream itself must initiate the repair before it closes.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status/events",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: status");
    expect(queued.size).toBe(1);
    const [streamJob] = [...queued.values()];
    expect(streamJob?.dedupeKey).toContain("repair-7-");
    await app.close();
  });

  it("queues a settled project's repair before publishing the missing-export status", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);

    let markRepairStarted!: () => void;
    const repairStarted = new Promise<void>((resolve) => {
      markRepairStarted = resolve;
    });
    let releaseRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    vi.mocked(enqueueGenerationJob).mockImplementation((async () => {
      markRepairStarted();
      await repairGate;
      return jobRecord({ id: "job-repair", status: "QUEUED" });
    }) as never);

    const app = await buildMobileApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the mobile API to listen on a TCP port.");
    }

    const response = fetch(`http://127.0.0.1:${address.port}/api/mobile/projects/project-a/status/events`, {
      headers: { authorization: "Bearer token-a" }
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await repairStarted;
      const publishedWhileRepairWasBlocked = await Promise.race([
        response.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25))
      ]);

      expect(publishedWhileRepairWasBlocked).toBe(false);

      releaseRepair();
      const streamResponse = await response;
      reader = streamResponse.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = reader!.read();
      const chunk = await firstChunk;
      expect(new TextDecoder().decode(chunk.value)).toContain("event: status");
    } finally {
      releaseRepair();
      await reader?.cancel();
      await app.close();
    }
  });

  it("does not queue a repair from the status stream once both files are there", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-present");
    writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-present");
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status/events",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(queued.size).toBe(0);
    await app.close();
  });

  it("queues the repair from the status poll, the app's fallback when the stream drops", async () => {
    // The dead end this closes: every download surface gates on
    // `export.available` — the card's button is disabled and reads "Preparing
    // PDF", the reader shows "still being written" — so after an edit recompile
    // that never landed, nothing ever called the route that queues a repair.
    // Watching the status is the only signal there is.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.exports.pdf.available).toBe(false);
    expect(queued.size).toBe(1);
    const [job] = [...queued.values()];
    expect(job?.dedupeKey).toContain("repair-7-");
    await app.close();
  });

  it("does not advertise a stat-able directory as a downloadable export", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    // A plain stat succeeds for this path, while opening it as a downloadable
    // regular file must not. Status and repair suppression need one predicate
    // or the UI can disable download forever without queueing the repair.
    mkdirSync(join(state.bookStorageDir!, "project-a", "book.pdf"), { recursive: true });
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status.exports.pdf.available).toBe(false);
    expect(queued.size).toBe(1);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ [EXPORT_REPAIR_FORMAT]: "pdf" }) })
    );
    await app.close();
  });

  it("does not queue a repair from the status poll once both files are there", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-present");
    writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-present");
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(queued.size).toBe(0);
    await app.close();
  });

  it("repairs an EPUB-only outage, which no download surface can ask for", async () => {
    // The EPUB used to be excluded from this hook, on the grounds that its own
    // download route repaired it on demand. It cannot: every surface gates on
    // `export.available`, so the button that would reach that route is disabled
    // for exactly as long as the file is missing. With the PDF present nothing
    // else ever fires, and the book kept its missing EPUB until some unrelated
    // edit happened to bump the revision.
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-present");
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

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

    expect(poll.json().status.exports).toMatchObject({
      pdf: { available: true },
      epub: { available: false }
    });
    expect(stream.statusCode).toBe(200);
    // Both surfaces, one job: the stream is what the app subscribes to and the
    // poll is its fallback, so a hook on only one of them misses half the cases.
    expect(queued.size).toBe(1);
    const [job] = [...queued.values()];
    expect(job?.dedupeKey).toContain("compile-export:project-a:plan-1:repair-epub-7-");
    await app.close();
  });

  it("retries a settled EPUB repair in the next window", async () => {
    // A terminal row remains under its unique key forever. The window keeps
    // repeated status reads deduped while ensuring a transient conversion
    // failure does not spend this manuscript revision permanently.
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-present");
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 })
    );
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();
    const poll = () =>
      app.inject({ method: "GET", url: "/api/mobile/projects/project-a/status", headers: bearer("token-a") });
    const windowStart = 5_954_371 * 300_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(windowStart);

    try {
      await poll();
      for (const job of queued.values()) {
        job.status = "FAILED";
      }
      await poll();
      await poll();

      expect(queued.size).toBe(1);

      now.mockReturnValue(windowStart + 300_000);
      await poll();

      expect(queued.size).toBe(2);
      expect([...queued.keys()]).toEqual([
        "compile-export:project-a:plan-1:repair-epub-7-5954371",
        "compile-export:project-a:plan-1:repair-epub-7-5954372"
      ]);
    } finally {
      now.mockRestore();
      await app.close();
    }
  });

  it("does not queue a repair from the status poll while the book is still generating", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "GENERATING", currentPlanId: "plan-1", contentRevision: 2 })
    );
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status",
      headers: bearer("token-a")
    });

    expect(queued.size).toBe(0);
    await app.close();
  });

  it("bounds a failed repair to the rest of its window, not forever", async () => {
    // Operationally the important property: unlike the non-windowed compile-intent key it
    // replaced, a spent repair key expires. A repair that fails blocks further
    // attempts only until the window rolls, and the window is wall-clock
    // aligned rather than measured from the attempt — so the wait is anywhere
    // from a moment to five minutes, never longer.
    const key = (now: number) =>
      exportRepairDedupeKey({ projectId: "project-a", planId: "plan-1", contentRevision: 7, now });

    const windowStart = 5_954_371 * 300_000;
    expect(key(windowStart)).toBe(key(windowStart + 299_999));
    expect(key(windowStart)).not.toBe(key(windowStart + 300_000));
    // A failure a second before the boundary is retryable a second later.
    expect(key(windowStart + 299_000)).not.toBe(key(windowStart + 300_000));
    // The revision is part of the key, so an edit never waits on it at all.
    expect(key(windowStart)).not.toBe(
      exportRepairDedupeKey({ projectId: "project-a", planId: "plan-1", contentRevision: 8, now: windowStart })
    );

    // EPUB repairs use the same bounded retry cadence while retaining a
    // format-specific key.
    const epubKey = (now: number) =>
      exportRepairDedupeKey({ projectId: "project-a", planId: "plan-1", contentRevision: 7, format: "epub", now });
    expect(epubKey(windowStart)).toBe(epubKey(windowStart + 299_999));
    expect(epubKey(windowStart)).not.toBe(epubKey(windowStart + 300_000));
    expect(epubKey(windowStart)).not.toBe(key(windowStart));
  });

  it("dispatches nothing more when a repair for this window already exists", async () => {
    // The other half of the same key: a compile that keeps failing must not
    // turn the app's four-second poll into a job per poll.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    for (let poll = 0; poll < 5; poll += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-a/export/pdf",
        headers: bearer("token-a")
      });
      expect(response.statusCode).toBe(404);
    }

    expect(queued.size).toBe(1);
    await app.close();
  });

  it("answers EXPORT_NOT_READY when the repair's own database read fails", async () => {
    // The repair is best-effort for the whole decision, not just for the write.
    // Its first statement is a read — the pending-compile look — and a caller
    // that let that escape would turn a transient database blip into a 500 on
    // the download and status routes, which is a *worse* answer than the one it
    // was already going to give: the file is missing either way, and the app
    // knows how to poll through "not ready".
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    mockPrisma.generationJob.findFirst.mockRejectedValue(new Error("connection terminated unexpectedly"));
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    fakeDedupingQueue();
    const app = await buildMobileApp();

    const download = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status",
      headers: bearer("token-a")
    });

    expect(download.statusCode).toBe(404);
    expect(download.json().error.code).toBe("EXPORT_NOT_READY");
    expect(status.statusCode).toBe(200);
    await app.close();
  });

  it("answers instead of hanging when the queue hand-off never settles", async () => {
    // `apps/api/src/queue.ts` builds ioredis with `maxRetriesPerRequest: null`,
    // which BullMQ requires and which means a command issued while Redis is
    // unreachable waits in the offline queue rather than failing. `bookQueue.add`
    // then neither resolves nor rejects for the length of the outage, so awaiting
    // the hand-off held the request open for exactly that long — to finish
    // deciding something the caller had already decided before it touched the
    // queue at all: the file is missing, so the answer is "not ready". Every
    // caller here is a Fastify handler the app polls, and they all share this
    // helper, so bounding it once covers the downloads, `GET …/status` and each
    // tick of the status stream.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    let failDispatch!: (error: Error) => void;
    const outage = new Promise<never>((_, reject) => {
      failDispatch = reject;
    });
    vi.mocked(dispatchGenerationJob).mockReturnValue(outage as never);
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    const app = await buildMobileApp();

    let hangTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = app.inject({
        method: "GET",
        url: "/api/mobile/projects/project-a/export/pdf",
        headers: bearer("token-a")
      });
      // A generous ceiling: the assertion is that the request is bounded at all,
      // not that it lands on a particular millisecond. Without the bound this
      // resolves to null, because nothing ever settles the hand-off.
      const answered = await Promise.race([
        request.then((response) => response),
        new Promise<null>((resolve) => {
          hangTimer = setTimeout(() => resolve(null), 15_000);
        })
      ]);

      expect(answered).not.toBeNull();
      expect(answered?.statusCode).toBe(404);
      expect(answered?.json().error.code).toBe("EXPORT_NOT_READY");

      // Giving up on the wait is not giving up on the repair. The row stays
      // QUEUED with no bullJobId, which is exactly what
      // `reconcileUndispatchedGenerationJobs` republishes once Redis is back.
      expect(queued.size).toBe(1);
      const [row] = [...queued.values()];
      expect(row?.status).toBe("QUEUED");
      expect(row?.dedupeKey).toContain("repair-7-");
      // The abandoned hand-off settles whenever Redis comes back — long after
      // the request it was started for. `withTimeout` attached its handler
      // before the race, so that must not surface as an unhandled rejection.
      failDispatch(new Error("connection is closed"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      if (hangTimer) {
        clearTimeout(hangTimer);
      }
      process.off("unhandledRejection", recordUnhandled);
      await app.close();
    }
  });

  it("still publishes the repair itself when the queue is healthy", async () => {
    // The bound is on the wait, not on the hand-off: a healthy dispatch must
    // still happen inline, so the compile is running before the app's next poll
    // rather than waiting on the five-second reconcile sweep.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    const queued = fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    const [row] = [...queued.values()];
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith(row?.id);
    await app.close();
  });

  it("keeps the status stream alive when the repair cannot re-read the project", async () => {
    // `ensureExportRepairQueuedFor` re-reads the row because the stream was
    // opened against a status, plan and revision that have since moved. That
    // read is the helper's own, so it belongs inside the same best-effort net as
    // everything after it: failing it must not replace the settled snapshot the
    // client is waiting for with a stream error.
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst
      // The route's ownership check succeeds; the repair's re-read is what fails.
      .mockResolvedValueOnce(projectRecord({ id: "project-a", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 }))
      .mockRejectedValue(new Error("connection terminated unexpectedly"));
    mockProjectStatus.buildProjectStatus.mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));
    fakeDedupingQueue();
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/status/events",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: status");
    expect(response.body).not.toContain("event: error");
    await app.close();
  });

  it("does not queue a compile for a project that is not exportable yet", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Still Generating",
      status: "GENERATING",
      currentPlanId: "plan-1",
      contentRevision: 2
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EXPORT_NOT_READY");
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });
});
