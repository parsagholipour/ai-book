import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { objectKey } from "@book-maker/storage";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { seedObject } from "../testing/objectStorage.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  openJobRow,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { mockTransactions } from "./testing/mobileApiMocks.js";

/**
 * `POST /api/mobile/projects/:id/book-matter/remove-credit`, through the real
 * presentation commit (`commitCoverChange`) over the mocked database: a
 * subscriber's book is reprinted free, a free account is told it comes with a
 * plan, and a book that is busy or unfinished is answered with why.
 *
 * Not in `bookMatterRoutes.test.ts`, which mocks `coverChange.js`: the module
 * graph is a cycle (coverChange → editOperations → bookEditIntents →
 * tomezaCreditEdits → tomezaCredit → coverChange), so a module first evaluated
 * inside that mock's factory binds the original, and the assertions there would
 * be about a mock this route never calls.
 */
type Row = Record<string, any>;

const AUTH = bearer("token-a");
const PUBLISHED_WITH_CREDIT = [
  '<section class="book-title-page">',
  '  <h1 class="book-title-page__title">The Clockmaker</h1>',
  '  <p class="book-title-page__imprint">Made with Tomeza</p>',
  "</section>",
  "",
  "The first page."
].join("\n");
const PUBLISHED_WITHOUT_CREDIT = PUBLISHED_WITH_CREDIT.replace(/\n {2}<p class="book-title-page__imprint">[^\n]*/, "");

let projects: Row[];

function book(overrides: Row = {}): Row {
  return {
    id: "book-1",
    userId: "user-a",
    status: "COMPLETE",
    authorName: null,
    bookMatter: null,
    mediaSettings: {},
    currentPlanId: "plan-1",
    contentRevision: 1,
    ...overrides
  };
}

function select(row: Row, fields: Row | undefined): Row {
  return fields ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]])) : { ...row };
}

const removeCredit = (app: Awaited<ReturnType<typeof buildMobileApp>>, options: { project?: string; payload?: Row } = {}) =>
  app.inject({
    method: "POST",
    url: `/api/mobile/projects/${options.project ?? "book-1"}/book-matter/remove-credit`,
    headers: AUTH,
    ...(options.payload ? { payload: options.payload } : {})
  });

/** The writes a reprint makes: the row put to EDITING with its revision bumped. */
const reprintWrites = () =>
  mockPrisma.project.update.mock.calls.filter((call: Row[]) => call[0]?.data?.status === "EDITING");

beforeEach(() => {
  resetMobileHarness();
  mockAccessTokens({ "token-a": "user-a" });
  projects = [book(), book({ id: "book-other", userId: "user-b" })];
  mockPrisma.project.findFirst.mockImplementation(async ({ where, select: fields }: Row) => {
    const project = projects.find((row) => row.id === where.id && (!where.userId || row.userId === where.userId));
    return project ? select(project, fields) : null;
  });
  mockPrisma.project.findUnique.mockImplementation(async ({ where, select: fields }: Row) => {
    const project = projects.find((row) => row.id === where.id);
    return project ? select(project, fields) : null;
  });
  mockPrisma.project.update.mockImplementation(async ({ where, data }: Row) => {
    const project = projects.find((row) => row.id === where.id)!;
    const { contentRevision, ...rest } = data;
    Object.assign(project, rest);
    if (contentRevision?.increment) project.contentRevision += contentRevision.increment;
    return { ...project };
  });
  mockPrisma.bookEditOperation.count.mockResolvedValue(0);
  mockPrisma.generationJob.findMany.mockResolvedValue([]);
  vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-compile", type: "COMPILE_EXPORT" }));
  seedObject(objectKey("books", "book-1", "book.md"), PUBLISHED_WITH_CREDIT);
});

afterEach(teardownMobileHarness);

describe("taking the “Made with Tomeza” line off a book", () => {
  it("comes with a plan: a free account is refused with the code the app opens the paywall on, and nothing is written", async () => {
    const app = await buildMobileApp();
    const response = await removeCredit(app);

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: "SUBSCRIPTION_REQUIRED",
      message: "Removing the “Made with Tomeza” line comes with any plan."
    });
    expect(mockBilling.resolvePlanTier).toHaveBeenCalledWith("user-a");
    expect(mockTransactions()).toHaveLength(0);
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("reprints a subscriber's book free in one presentation commit, changing nothing but the revision", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    const app = await buildMobileApp();
    const response = await removeCredit(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reprint: "queued",
      // The old file is still published, but the reprint under way reads the
      // plan again, so the sheet stops offering the removal.
      bookMatter: { madeWithCredit: false, creditPrinted: false }
    });
    // One transaction: the row to EDITING with the revision bumped, and no
    // title, byline, matter or cover written with it.
    expect(mockTransactions()).toHaveLength(1);
    expect(reprintWrites()).toHaveLength(1);
    expect(Object.keys(reprintWrites()[0]![0].data).sort()).toEqual(["contentRevision", "status"]);
    expect(projects[0]).toMatchObject({ status: "EDITING", contentRevision: 2, bookMatter: null });
    // A presentation compile and nothing else: no cover job, no charge.
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "COMPILE_EXPORT", projectId: "book-1", contentRevision: 2, dispatch: false })
    );
    expect(vi.mocked(dispatchGenerationJob)).toHaveBeenCalledWith("job-compile");
    expect(mockBilling.reserveCredits).not.toHaveBeenCalled();
    expect(mockBilling.startGenerationAttempt).not.toHaveBeenCalled();
    await app.close();
  });

  it("tolerates an empty JSON body", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    const app = await buildMobileApp();
    const response = await removeCredit(app, { payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().reprint).toBe("queued");
    await app.close();
  });

  it("answers a second tap in the reprint's window with the book being updated, and reprints once", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    const app = await buildMobileApp();
    expect((await removeCredit(app)).json().reprint).toBe("queued");

    const again = await removeCredit(app);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toEqual({
      code: "PROJECT_BUSY",
      message: "Your book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, tap Remove it again."
    });
    // Not every EDITING window ends in a recompile, so the answer promises none.
    expect(again.json().error.message).not.toMatch(/prints without|new version/);
    expect(reprintWrites()).toHaveLength(1);
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledTimes(1);

    // …and the sheet read in that window does not offer it again.
    const sheet = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    expect(sheet.json().bookMatter.creditPrinted).toBe(false);
    await app.close();
  });

  it("has nothing to do for a book compiled after the owner subscribed", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    seedObject(objectKey("books", "book-1", "book.md"), PUBLISHED_WITHOUT_CREDIT);
    const app = await buildMobileApp();
    const response = await removeCredit(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reprint: "none", bookMatter: { creditPrinted: false } });
    expect(mockTransactions()).toHaveLength(0);
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("has nothing to do for a finished book with no published file", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    projects.push(book({ id: "book-bare" }));
    const app = await buildMobileApp();
    const response = await removeCredit(app, { project: "book-bare" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reprint: "none", bookMatter: { creditPrinted: false } });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["still being written", { status: "GENERATING" }, "This book isn’t finished yet. On your plan it will be put together without the “Made with Tomeza” line."],
    ["never planned", { currentPlanId: null }, "This book isn’t finished yet. On your plan it will be put together without the “Made with Tomeza” line."],
    ["being updated", { status: "EDITING" }, "Your book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, tap Remove it again."]
  ])("waits for a book %s", async (_name, overrides, message) => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    projects[0] = book(overrides);
    const app = await buildMobileApp();
    const response = await removeCredit(app);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({ code: "PROJECT_BUSY", message });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("waits while a job owns a settled book, as the presentation commit finds it under its lock", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    // A narration on a finished book: open work that reprints nothing.
    mockPrisma.generationJob.findMany.mockResolvedValue([openJobRow({ audiobookId: "audiobook-1" })]);
    const app = await buildMobileApp();
    const response = await removeCredit(app);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: "PROJECT_BUSY",
      message: "Your book is being worked on right now. Try again once that finishes."
    });
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
    await app.close();
  });

  it("says the book is being updated when a rebuild started between the read and the lock", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
      if (strings.join("?").includes("FOR UPDATE")) projects[0]!.status = "EDITING";
      return [];
    });
    const app = await buildMobileApp();
    const response = await removeCredit(app);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe("Your book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, tap Remove it again.");
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    await app.close();
  });

  it("is someone else's book: 404, before the plan is asked", async () => {
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    const app = await buildMobileApp();
    const response = await removeCredit(app, { project: "book-other" });
    expect(response.statusCode).toBe(404);
    expect(mockBilling.resolvePlanTier).not.toHaveBeenCalled();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    await app.close();
  });
});
