import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import { objectNames, seedObject } from "../testing/objectStorage.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  bearer,
  buildMobileApp,
  buildOperatorApp,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  mockQueue,
  openJobRow,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { AUTH, createStudioBook, finishCompile, getManuscript, publish, saveChapter } from "./testing/manuscriptTestSupport.js";

/** A real 1x1 PNG, so the optimizer can decode and re-encode it. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

async function writtenBook(app: FastifyInstance) {
  const { body } = await createStudioBook(app);
  const projectId = body.project.id as string;
  await saveChapter(app, projectId, { id: body.chapter.id, revision: 1, title: "The Keeper" }, "The keeper climbed the stairs.");
  return projectId;
}

/** Published, compiled, and wearing the designed cover the worker drew. */
async function publishedBook(app: FastifyInstance) {
  const projectId = await writtenBook(app);
  expect((await publish(app, projectId, "request-publish-0001")).statusCode).toBe(200);
  finishCompile(db, projectId);
  db.images.push({
    id: "cover-design",
    projectId,
    pageId: null,
    type: "COVER",
    path: `http://localhost:4001/assets/images/${projectId}/cover.jpg`,
    metadata: { coverArtSource: "design", coverDesignId: "moonlit-sea" },
    createdAt: new Date("2026-09-20T10:00:00.000Z")
  });
  db.enqueued.length = 0;
  mockQueue.dispatchGenerationJob.mockClear();
  return projectId;
}

function uploadCover(app: FastifyInstance, projectId: string, query = "filename=cover.png&contentType=image%2Fpng", payload = ONE_PIXEL_PNG) {
  return app.inject({
    method: "PUT",
    url: `/api/mobile/projects/${projectId}/manuscript/cover?${query}`,
    headers: { ...AUTH, "content-type": "application/octet-stream" },
    payload
  });
}

function generateCover(app: FastifyInstance, projectId: string, requestId = "request-cover-0001") {
  return app.inject({
    method: "POST",
    url: `/api/mobile/projects/${projectId}/manuscript/cover/generate`,
    headers: AUTH,
    payload: { requestId }
  });
}

function deleteCover(app: FastifyInstance, projectId: string) {
  return app.inject({ method: "DELETE", url: `/api/mobile/projects/${projectId}/manuscript/cover`, headers: AUTH });
}

/** The `?v=` every cover URL ends in (`versionedImageAssetUrl`). */
const VERSION = "\\?v=[A-Za-z0-9_-]{12}";

/** The stored file a cover URL names, without its version. */
function fileOf(url: string): string | undefined {
  return new URL(url, "http://api.test").pathname.split("/").pop();
}

/** An open cover job as the status read sees one; every other open-job read answers empty. */
function coverJobOpen(): void {
  mockPrisma.generationJob.findMany.mockImplementation(async ({ where }: { where: { type?: unknown } }) =>
    where.type === "GENERATE_IMAGE" ? [{ payload: { assetType: "COVER" } }] : []
  );
}

describe("the cover in the manuscript DTO", () => {
  it("is a designed cover with no picture before the first one exists", async () => {
    const app = await buildMobileApp();
    const projectId = await writtenBook(app);

    const manuscript = (await getManuscript(app, projectId)).json().manuscript;

    expect(manuscript.cover).toEqual({ source: "design", imageUrl: null, pending: false });
    expect(manuscript.castCharacterIds).toEqual([]);
  });

  it("is a new URL when a redraw lands at the same path, and the same URL until then", async () => {
    // The worker rewrites cover.<ext> in place for every drawn or designed
    // cover; the bare path would hand the app yesterday's picture from cache.
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);
    const detailCoverUrl = async () =>
      (await app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}`, headers: AUTH })).json().project.coverImage.url as string;

    const before = (await getManuscript(app, projectId)).json().manuscript.cover.imageUrl as string;
    const detailBefore = await detailCoverUrl();
    expect((await getManuscript(app, projectId)).json().manuscript.cover.imageUrl).toBe(before);
    expect(await detailCoverUrl()).toBe(detailBefore);

    // What generateCover commits: the COVER rows go and one is created, same file.
    const drawn = db.images.find((image) => image.type === "COVER")!;
    db.images.splice(db.images.indexOf(drawn), 1);
    db.images.push({ ...drawn, id: "cover-redrawn", createdAt: new Date("2026-09-21T10:00:00.000Z") });

    const after = (await getManuscript(app, projectId)).json().manuscript.cover.imageUrl as string;
    expect(after).not.toBe(before);
    expect(fileOf(after)).toBe(fileOf(before));
    expect(after).toMatch(new RegExp(`^/assets/images/${projectId}/cover\\.jpg${VERSION}$`));
    expect(await detailCoverUrl()).not.toBe(detailBefore);

    // The version is for caches only: the asset route serves and authorizes by path.
    seedObject(`images/${projectId}/cover.jpg`, "redrawn-bytes");
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    const assets = await buildOperatorApp();
    const own = await assets.inject({ method: "GET", url: after, headers: AUTH });
    const other = await assets.inject({ method: "GET", url: after, headers: bearer("token-b") });
    expect([own.statusCode, own.body, own.headers["cache-control"]]).toEqual([200, "redrawn-bytes", "private, max-age=300"]);
    expect(other.statusCode).toBe(404);
    await assets.close();
  });
});

describe("PUT /manuscript/cover", () => {
  it("stores an unpublished book's upload as its cover, and the first publish draws none", async () => {
    const app = await buildMobileApp();
    const projectId = await writtenBook(app);

    const response = await uploadCover(app, projectId);

    expect(response.statusCode).toBe(200);
    const cover = response.json().manuscript.cover;
    expect(cover).toEqual({ source: "upload", imageUrl: expect.stringMatching(new RegExp(`^/assets/images/${projectId}/cover-upload-[0-9a-f-]{36}\\.jpg${VERSION}$`)), pending: false });
    expect(objectNames(`images/${projectId}`)).toEqual([fileOf(cover.imageUrl)]);
    expect(db.images.filter((image) => image.type === "COVER")).toEqual([
      expect.objectContaining({ provider: "upload", metadata: expect.objectContaining({ source: "upload", width: 1, height: 1 }) })
    ]);
    expect(db.enqueued).toEqual([]);

    await publish(app, projectId, "request-publish-0001");
    expect(db.enqueued.map((job) => job.type)).toEqual(["COMPILE_EXPORT", "WRITING_ASSIST"]);
  });

  it("recompiles a published book as a presentation change, and replaces the upload it supersedes", async () => {
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);

    const first = await uploadCover(app, projectId);
    expect(first.statusCode).toBe(200);
    const project = db.projects[0]!;
    expect(project).toMatchObject({ status: "EDITING", contentRevision: 2 });
    expect(project.mediaSettings).toMatchObject({ coverArtSource: "design" });
    expect(db.enqueued.map((job) => [job.type, job.dispatch])).toEqual([["COMPILE_EXPORT", false]]);
    expect(db.enqueued[0]!.payload).toMatchObject({
      contentRevision: 2,
      skipFinalReview: true,
      presentationOnlyRecompile: true,
      exportPublicationProjectStatus: "EDITING"
    });
    expect(mockQueue.dispatchGenerationJob).toHaveBeenCalledWith(db.enqueued[0]!.id);

    finishCompile(db, projectId);
    const firstFile = fileOf(first.json().manuscript.cover.imageUrl);
    const second = await uploadCover(app, projectId);
    const secondFile = fileOf(second.json().manuscript.cover.imageUrl);
    expect(secondFile).not.toBe(firstFile);
    expect(objectNames(`images/${projectId}`)).toEqual([secondFile]);
    expect(db.images.filter((image) => image.type === "COVER")).toHaveLength(1);
  });

  it("keeps the uploaded object when the transaction committed but the call reported a failure", async () => {
    // A connection dropped at COMMIT: the rows landed, the caller saw an error.
    // Deleting on the strength of that throw left the book's cover row naming
    // an object that no longer exists.
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);
    const commit = mockPrisma.$transaction.getMockImplementation()!;
    mockPrisma.$transaction.mockImplementationOnce(async (...args: unknown[]) => {
      await commit(...args);
      throw new Error("Connection terminated unexpectedly");
    });

    const response = await uploadCover(app, projectId);

    expect(response.statusCode).toBe(500);
    const covers = db.images.filter((image) => image.type === "COVER");
    expect(covers).toEqual([expect.objectContaining({ provider: "upload" })]);
    expect(objectNames(`images/${projectId}`)).toEqual([fileOf(covers[0]!.path)]);
  });

  it("removes the uploaded object when the transaction really rolled back", async () => {
    const app = await buildMobileApp();
    const projectId = await writtenBook(app);
    const create = mockPrisma.imageAsset.create.getMockImplementation()!;
    mockPrisma.imageAsset.create.mockImplementationOnce(async () => {
      throw new Error("could not serialize access");
    });

    const response = await uploadCover(app, projectId);

    expect(response.statusCode).toBe(500);
    expect(db.images.filter((image) => image.type === "COVER")).toEqual([]);
    expect(objectNames(`images/${projectId}`)).toEqual([]);
    mockPrisma.imageAsset.create.mockImplementation(create);
  });

  it("refuses what is not a picture, and a book another job still owns", async () => {
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);

    const svg = await uploadCover(app, projectId, "filename=cover.svg&contentType=image%2Fsvg%2Bxml", Buffer.from("<svg/>"));
    expect([svg.statusCode, svg.json().error.code]).toEqual([415, "UNSUPPORTED_IMAGE"]);
    const garbage = await uploadCover(app, projectId, "filename=cover.jpg&contentType=image%2Fjpeg", Buffer.from("not a picture"));
    expect(garbage.statusCode).toBe(415);

    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow()]);
    const busy = await uploadCover(app, projectId);
    expect([busy.statusCode, busy.json().error.code]).toEqual([409, "PROJECT_BUSY"]);
    expect(objectNames(`images/${projectId}`)).toEqual([]);
  });
});

describe("POST /manuscript/cover/generate", () => {
  it("charges the cover price and queues AI artwork plus the recompile that prints it, the attempt on the cover alone", async () => {
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);
    coverJobOpen();

    const response = await generateCover(app, projectId);

    expect(response.statusCode).toBe(200);
    // The job is drawing: the source is already "ai", the picture still the old one.
    expect(response.json().manuscript.cover).toEqual({
      source: "ai",
      imageUrl: expect.stringMatching(new RegExp(`^/assets/images/${projectId}/cover\\.jpg${VERSION}$`)),
      pending: true
    });
    expect(mockBilling.reserveCredits).toHaveBeenCalledWith(expect.objectContaining({ operation: "COVER_REGENERATION", amountCredits: 120 }));
    const [attempt] = state.generationAttempts;
    expect(attempt).toMatchObject({ operation: "COVER_REGENERATION", quotedCredits: 120 });
    const project = db.projects[0]!;
    expect(project).toMatchObject({ status: "EDITING", contentRevision: 2 });
    expect(project.mediaSettings).toMatchObject({ coverArtSource: "ai", includeCover: true });
    // The cover job reads its source off the plan snapshot, so that says it too.
    expect(db.planVersions[0]!.inputSnapshot.mediaSettings).toMatchObject({ coverArtSource: "ai", includeCover: true });
    expect(db.enqueued.map((job) => job.type)).toEqual(["COMPILE_EXPORT", "GENERATE_IMAGE"]);
    const planId = project.currentPlanId;
    expect(db.enqueued[1]!.payload).toEqual({
      planId,
      assetType: "COVER",
      contentRevision: 2,
      exportPublicationProjectStatus: "EDITING",
      coverPurchase: true,
      billingLedgerEntryId: "ledger-COVER_REGENERATION"
    });
    expect(db.enqueued[0]!.payload).toMatchObject({ presentationOnlyRecompile: true, contentRevision: 2 });
    // The purchase is the cover job's alone: a reprint carrying it would be stood
    // down as stale by a refunded cover, and could never settle a delivered one.
    expect(mockQueue.enqueueGenerationJob.mock.calls.slice(-2).map((call) => call[0].attemptId)).toEqual([undefined, attempt.id]);
    expect(attempt.primaryJobId).toBe(db.enqueued[1]!.id);
    expect(mockQueue.dispatchGenerationJob.mock.calls.map((call) => call[0])).toEqual(db.enqueued.map((job) => job.id));
  });

  it("charges a replayed request once", async () => {
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);

    await generateCover(app, projectId);
    finishCompile(db, projectId);
    const again = await generateCover(app, projectId);

    expect(again.statusCode).toBe(200);
    expect(mockBilling.reserveCredits).toHaveBeenCalledTimes(1);
    expect(db.enqueued).toHaveLength(2);
  });

  it("waits for a first publish, refuses a busy book, and answers 402 without the credits — charging nothing", async () => {
    const app = await buildMobileApp();
    const unpublished = await writtenBook(app);
    const early = await generateCover(app, unpublished);
    expect([early.statusCode, early.json().error.code]).toEqual([409, "PUBLISH_FIRST"]);

    const projectId = await publishedBook(app);
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow()]);
    const busy = await generateCover(app, projectId, "request-cover-0002");
    expect([busy.statusCode, busy.json().error.code]).toEqual([409, "PROJECT_BUSY"]);
    mockPrisma.generationJob.findMany.mockResolvedValue([]);

    mockBilling.reserveCredits.mockRejectedValueOnce(
      new mockBilling.InsufficientCreditsError({ requiredCredits: 120, availableCredits: 5, reservedCredits: 0 })
    );
    const broke = await generateCover(app, projectId, "request-cover-0003");
    expect(broke.statusCode).toBe(402);
    expect(broke.json().error).toMatchObject({ requiredCredits: 120 });

    expect(db.enqueued).toEqual([]);
    expect(db.projects.find((project) => project.id === projectId)).toMatchObject({ status: "COMPLETE", contentRevision: 1 });
  });
});

describe("DELETE /manuscript/cover", () => {
  it("puts a published book back on a designed cover for free", async () => {
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);
    await uploadCover(app, projectId);
    finishCompile(db, projectId);
    db.enqueued.length = 0;
    mockBilling.reserveCredits.mockClear();

    const response = await deleteCover(app, projectId);

    expect(response.statusCode).toBe(200);
    expect(db.enqueued.map((job) => job.type)).toEqual(["COMPILE_EXPORT", "GENERATE_IMAGE"]);
    expect(db.enqueued[1]!.payload).toEqual({
      planId: db.projects[0]!.currentPlanId,
      assetType: "COVER",
      contentRevision: 3,
      exportPublicationProjectStatus: "EDITING"
    });
    expect(mockQueue.enqueueGenerationJob.mock.calls.slice(-2).every((call) => call[0].attemptId === undefined)).toBe(true);
    expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
    expect(db.projects[0]!.mediaSettings).toMatchObject({ coverArtSource: "design", includeCover: false });
  });

  it("does nothing to a book already wearing a designed cover", async () => {
    const app = await buildMobileApp();
    const projectId = await publishedBook(app);

    expect((await deleteCover(app, projectId)).statusCode).toBe(200);

    expect(db.enqueued).toEqual([]);
    expect(db.projects[0]).toMatchObject({ status: "COMPLETE", contentRevision: 1 });
  });

  it("drops an unpublished book's upload, so its first publish draws a design", async () => {
    const app = await buildMobileApp();
    const projectId = await writtenBook(app);
    await uploadCover(app, projectId);

    const response = await deleteCover(app, projectId);

    expect(response.json().manuscript.cover).toEqual({ source: "design", imageUrl: null, pending: false });
    expect(objectNames(`images/${projectId}`)).toEqual([]);
    await publish(app, projectId, "request-publish-0001");
    expect(db.enqueued.map((job) => job.type)).toEqual(["COMPILE_EXPORT", "GENERATE_IMAGE", "WRITING_ASSIST"]);
  });
});
