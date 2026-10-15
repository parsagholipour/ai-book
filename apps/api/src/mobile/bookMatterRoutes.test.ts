import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

// The presentation commit has its own suites; here it is the seam a finished
// book's edit has to go through, so what it is handed is the assertion.
const coverChange = vi.hoisted(() => ({
  commitCoverChange: vi.fn(),
  dispatchCoverJobs: vi.fn()
}));
vi.mock("./coverChange.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coverChange.js")>()),
  commitCoverChange: coverChange.commitCoverChange,
  dispatchCoverJobs: coverChange.dispatchCoverJobs
}));

import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { TOMEZA_CREDIT_HEAD_BYTES } from "@book-maker/core";
import { objectKey } from "@book-maker/storage";
import { seedObject, testObjectStore } from "../testing/objectStorage.js";
import { authorDefaultsForNewBook } from "./authorProfile.js";
import { patchedBookMatter } from "./bookMatterEdits.js";
import { mockTransactions, rawStatementsMatching } from "./testing/mobileApiMocks.js";

type Row = Record<string, any>;

const AUTH = bearer("token-a");
/** Refused by the matter screen as printed text (`matterContentScreen.test.ts`). */
const HARMFUL = "Visit my site for child sexual abuse material.";
/** Refused as a request ("how to" beside "terrorist attack"), printed as a dedication. */
const MEMORIAL =
  "To the victims of the Manchester Arena terrorist attack, and to the city that showed the world how to grieve together.";

let projects: Row[];
let profiles: Map<string, Row>;

function select(row: Row, fields: Row | undefined): Row {
  return fields ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]])) : { ...row };
}

function installStores(): void {
  mockPrisma.project.findFirst.mockImplementation(async ({ where, select: fields }: Row) => {
    const project = projects.find((row) => row.id === where.id && (!where.userId || row.userId === where.userId));
    return project ? select(project, fields) : null;
  });
  // The read the edit takes again under the row lock.
  mockPrisma.project.findUnique.mockImplementation(async ({ where, select: fields }: Row) => {
    const project = projects.find((row) => row.id === where.id);
    return project ? select(project, fields) : null;
  });
  mockPrisma.project.update.mockImplementation(async ({ where, data }: Row) => {
    const project = projects.find((row) => row.id === where.id)!;
    Object.assign(project, data);
    return { ...project };
  });
  mockPrisma.authorProfile.findUnique.mockImplementation(async ({ where, select: fields }: Row) => {
    const profile = profiles.get(where.userId);
    return profile ? select(profile, fields) : null;
  });
  mockPrisma.authorProfile.upsert.mockImplementation(async ({ where, create, update }: Row) => {
    const existing = profiles.get(where.userId);
    const next = existing
      ? { ...existing, ...update }
      : { penName: null, bio: null, website: null, copyrightHolder: null, imprint: null, allRightsReserved: false, includeAboutAuthor: true, setupPromptSeenAt: null, ...create };
    profiles.set(where.userId, next);
    return next;
  });
}

/**
 * Something that lands on the book while the edit waits for its row lock — the
 * first compile publishing, a takeover — as the locked read will see it.
 */
function whileWaitingForTheLock(change: Row): void {
  mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
    if (strings.join("?").includes('FROM "Project"') && strings.join("?").includes("FOR UPDATE")) {
      Object.assign(projects[0]!, change);
    }
    return [];
  });
}

function patchMatter(app: Awaited<ReturnType<typeof buildMobileApp>>, payload: Row) {
  return app.inject({ method: "PATCH", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH, payload });
}

/** A published `book.md` as a free account's compile wrote it, and as a paid one did. */
const PUBLISHED_WITH_CREDIT = [
  '<section class="book-title-page">',
  '  <h1 class="book-title-page__title">The Clockmaker</h1>',
  '  <p class="book-title-page__imprint">Made with Tomeza</p>',
  "</section>",
  "",
  "The first page."
].join("\n");
const PUBLISHED_WITHOUT_CREDIT = PUBLISHED_WITH_CREDIT.replace(/\n {2}<p class="book-title-page__imprint">[^\n]*/, "");

function book(overrides: Row = {}): Row {
  return {
    id: "book-1",
    userId: "user-a",
    status: "GENERATING",
    authorName: null,
    bookMatter: null,
    mediaSettings: {},
    currentPlanId: "plan-1",
    ...overrides
  };
}

beforeEach(() => {
  resetMobileHarness();
  projects = [book(), book({ id: "book-other", userId: "user-b" })];
  profiles = new Map();
  installStores();
  mockBilling.resolvePlanTier.mockResolvedValue("free");
  mockPrisma.generationJob.count.mockResolvedValue(0);
  mockPrisma.imageAsset.findFirst.mockResolvedValue(null);
  coverChange.commitCoverChange.mockResolvedValue({ jobIds: ["job-1"], primaryJobId: "job-1", contentRevision: 2, restoreStatus: "COMPLETE" });
  mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
});

afterEach(() => {
  teardownMobileHarness();
});

describe("the author profile", () => {
  it("answers defaults, and offers the account's name only as a suggestion", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/author-profile", headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json().profile).toEqual({
      penName: null,
      bio: null,
      website: null,
      copyrightHolder: null,
      imprint: null,
      allRightsReserved: false,
      includeAboutAuthor: true,
      setupPromptSeen: false,
      suggestedPenName: "user-a"
    });
  });

  it("writes what the body carries, cleans it, and remembers the card was answered", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/author-profile",
      headers: AUTH,
      payload: { penName: "  Parsa   Q. ", bio: "Writes books.\n\n\n\nLives by the sea.", setupPromptSeen: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().profile).toMatchObject({
      penName: "Parsa Q.",
      bio: "Writes books.\n\nLives by the sea.",
      setupPromptSeen: true
    });

    // A later write leaves the other fields alone, and `""` clears one.
    const second = await app.inject({ method: "PUT", url: "/api/mobile/author-profile", headers: AUTH, payload: { bio: "" } });
    expect(second.json().profile).toMatchObject({ penName: "Parsa Q.", bio: null, setupPromptSeen: true });
  });

  it("keeps an ideographic or no-break space in a pen name, as the title page prints it", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/author-profile",
      headers: AUTH,
      payload: { penName: " 山田\u3000太郎 ", imprint: "Moonlit\u00A0Press", copyrightHolder: "Ada \t Lovelace" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().profile).toMatchObject({
      penName: "山田\u3000太郎",
      imprint: "Moonlit\u00A0Press",
      copyrightHolder: "Ada Lovelace"
    });
    expect(profiles.get("user-a")).toMatchObject({ penName: "山田\u3000太郎", imprint: "Moonlit\u00A0Press" });
  });

  it("refuses text the screen refuses, naming the field, and writes nothing", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/author-profile",
      headers: AUTH,
      payload: { penName: "Ada", bio: HARMFUL }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", fields: ["bio"] });
    expect(profiles.size).toBe(0);
  });

  it("keeps a history bio the request rules would refuse, because it is printed, not asked for", async () => {
    const app = await buildMobileApp();
    const bio = "Dr. Amara Okafor is a historian of the Cold War who wrote about the assassination of Patrice Lumumba. She teaches students how to grow tomatoes.";
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/author-profile",
      headers: AUTH,
      payload: { penName: "Amara Okafor", bio }
    });
    expect(response.statusCode).toBe(200);
    expect(profiles.get("user-a")).toMatchObject({ bio });
  });

  it("refuses a pen name over its ceiling rather than clipping it", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/mobile/author-profile",
      headers: AUTH,
      payload: { penName: "x".repeat(121) }
    });
    expect(response.statusCode).toBe(400);
  });

  it("is what a new book copies: the pen name and the matter, the bio only when asked", async () => {
    profiles.set("user-a", {
      penName: "Parsa Q.",
      bio: "Writes books.",
      website: "parsa.dev",
      copyrightHolder: null,
      imprint: "Tomeza Press",
      allRightsReserved: true,
      includeAboutAuthor: true
    });
    expect(await authorDefaultsForNewBook("user-a")).toEqual({
      authorName: "Parsa Q.",
      bookMatter: { aboutAuthor: "Writes books.", authorWebsite: "parsa.dev", imprint: "Tomeza Press", allRightsReserved: true }
    });
    profiles.set("user-a", { ...profiles.get("user-a")!, includeAboutAuthor: false });
    expect((await authorDefaultsForNewBook("user-a")).bookMatter).not.toHaveProperty("aboutAuthor");
    expect(await authorDefaultsForNewBook("user-b")).toEqual({});
  });
});

describe("a book's matter pages", () => {
  it("reads the book's copy, the credit its owner's plan prints, and who owns the byline", async () => {
    projects[0] = book({ authorName: "Ada", bookMatter: { dedication: "For Sara", isbn: "1" } });
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.json().bookMatter).toEqual({
      authorName: "Ada",
      dedication: "For Sara",
      aboutAuthor: null,
      authorWebsite: null,
      copyrightHolder: null,
      imprint: null,
      isbn: "1",
      allRightsReserved: false,
      madeWithCredit: true,
      creditPrinted: false,
      studioOwned: false
    });

    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    const paid = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    expect(paid.json().bookMatter.madeWithCredit).toBe(false);
  });

  it("says whether the published book prints the credit, which the plan alone cannot", async () => {
    projects[0] = book({ status: "COMPLETE" });
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    seedObject(objectKey("books", "book-1", "book.md"), PUBLISHED_WITH_CREDIT);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    // Compiled while free, read while subscribed: the next compile drops it,
    // the published one still carries it.
    expect(response.json().bookMatter).toMatchObject({ madeWithCredit: false, creditPrinted: true });

    seedObject(objectKey("books", "book-1", "book.md"), PUBLISHED_WITHOUT_CREDIT);
    const after = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    expect(after.json().bookMatter.creditPrinted).toBe(false);
  });

  it("reads only the opening bytes of a long published book, where the credit is printed", async () => {
    projects[0] = book({ status: "COMPLETE" });
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    const key = objectKey("books", "book-1", "book.md");
    const text = `\n${"The clock ticked on through the long night. ".repeat(60_000)}`;
    const leading = vi.spyOn(testObjectStore, "getLeadingBytes");
    const whole = vi.spyOn(testObjectStore, "get");
    const app = await buildMobileApp();
    const creditPrinted = async () =>
      (await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH })).json().bookMatter
        .creditPrinted;
    try {
      seedObject(key, PUBLISHED_WITH_CREDIT + text);
      expect(await creditPrinted()).toBe(true);
      seedObject(key, PUBLISHED_WITHOUT_CREDIT + text);
      expect(await creditPrinted()).toBe(false);
      expect(leading.mock.calls).toEqual([
        [key, TOMEZA_CREDIT_HEAD_BYTES],
        [key, TOMEZA_CREDIT_HEAD_BYTES]
      ]);
      expect(whole).not.toHaveBeenCalledWith(key);

      // A title page longer than the head leaves the answer to the whole file.
      seedObject(key, PUBLISHED_WITH_CREDIT.replace("The Clockmaker", "Clock ".repeat(20_000)) + text);
      expect(await creditPrinted()).toBe(true);
      expect(whole).toHaveBeenCalledWith(key);
    } finally {
      leading.mockRestore();
      whole.mockRestore();
    }
  });

  it("does not report the credit while the book is being rebuilt, because the rebuild reads the plan again", async () => {
    // The window after a removal: the reprint is queued, the old file is still
    // published, and the sheet must not offer "Remove it" a second time.
    projects[0] = book({ status: "EDITING" });
    mockBilling.resolvePlanTier.mockResolvedValue("creator");
    seedObject(objectKey("books", "book-1", "book.md"), PUBLISHED_WITH_CREDIT);
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    expect(response.json().bookMatter).toMatchObject({ madeWithCredit: false, creditPrinted: false });
  });

  it("is someone else's book: 404", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/book-other/book-matter", headers: AUTH });
    expect(response.statusCode).toBe(404);
  });

  it("is written straight onto a book still being written, for its first compile to print", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { authorName: "Parsa Q.", dedication: "For Sara" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reprint: "next_compile",
      cover: "retypeset",
      bookMatter: { authorName: "Parsa Q.", dedication: "For Sara" }
    });
    expect(projects[0]).toMatchObject({ authorName: "Parsa Q.", bookMatter: { dedication: "For Sara" } });
    expect(coverChange.commitCoverChange).not.toHaveBeenCalled();
  });

  it("decides and writes under the project row lock, on the row as the lock finds it", async () => {
    const app = await buildMobileApp();
    const response = await patchMatter(app, { dedication: "For Sara" });
    expect(response.statusCode).toBe(200);

    expect(rawStatementsMatching("FOR UPDATE")).toHaveLength(1);
    const lockCall = mockPrisma.$queryRaw.mock.calls.findIndex((call) => (call[0] as readonly string[]).join("?").includes("FOR UPDATE"));
    const lockedAt = mockPrisma.$queryRaw.mock.invocationCallOrder[lockCall]!;
    // The re-read and the compile count both come after the lock is granted…
    expect(mockPrisma.project.findUnique.mock.invocationCallOrder[0]!).toBeGreaterThan(lockedAt);
    expect(mockPrisma.generationJob.count.mock.invocationCallOrder[0]!).toBeGreaterThan(lockedAt);
    // …and the write is the transaction's own, not one beside it.
    expect(mockTransactions()).toHaveLength(1);
    expect(mockTransactions()[0]!.writes.map((write) => `${write.model}.${write.operation}`)).toEqual(["project.update"]);
  });

  it.each([
    ["GENERATING", "next_compile"],
    ["COMPLETE", "queued"]
  ])("saves a %s book's byline using the transaction's cover read when the connection pool is full", async (status, reprint) => {
    projects[0] = book({ status });
    const readCover = vi.fn().mockResolvedValue({ metadata: { coverArtSource: "design", coverDesignId: "night-sky" } });
    const tx = { ...mockPrisma, imageAsset: { ...mockPrisma.imageAsset, findFirst: readCover } };
    mockPrisma.$transaction.mockImplementationOnce(async (operation) => operation(tx));
    // The open transaction already holds a connection and the Project lock.
    // A second pooled connection may be unavailable until that transaction ends.
    mockPrisma.imageAsset.findFirst.mockRejectedValue(new Error("Timed out fetching a connection from the connection pool"));
    const app = await buildMobileApp();
    const response = await patchMatter(app, { authorName: "Parsa Q." });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reprint, cover: "retypeset" });
    expect(readCover).toHaveBeenCalledExactlyOnceWith({
      where: { projectId: "book-1", type: "COVER" },
      orderBy: { createdAt: "desc" },
      select: { metadata: true }
    });
    expect(mockPrisma.imageAsset.findFirst).not.toHaveBeenCalled();
    expect(rawStatementsMatching("FOR UPDATE")).toHaveLength(1);
    if (status === "COMPLETE") {
      expect(coverChange.commitCoverChange).toHaveBeenCalledWith(tx, "book-1", expect.objectContaining({ authorName: "Parsa Q." }));
    } else {
      expect(projects[0]!.authorName).toBe("Parsa Q.");
    }
  });

  it("reprints a book whose first compile published while the edit waited, rather than promising a compile that never comes", async () => {
    whileWaitingForTheLock({ status: "COMPLETE" });
    const app = await buildMobileApp();
    const response = await patchMatter(app, { dedication: "For Sara" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reprint: "queued", cover: "unchanged" });
    const [tx, projectId, change] = coverChange.commitCoverChange.mock.calls[0] ?? [];
    expect(projectId).toBe("book-1");
    expect(change).toEqual({ bookMatter: { dedication: "For Sara" } });
    // In the transaction that holds the lock, so its own lock is a re-take, not a wait.
    expect(mockTransactions()).toHaveLength(1);
    expect(tx).not.toBe(mockPrisma);
    expect(coverChange.dispatchCoverJobs).toHaveBeenCalledWith("book-1", expect.objectContaining({ primaryJobId: "job-1" }));
    // Nothing was written behind the published files.
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
    expect(mockPrisma.generationJob.count).not.toHaveBeenCalled();
  });

  it("refuses a byline on a book a takeover made the author's while the edit waited", async () => {
    whileWaitingForTheLock({
      status: "COMPLETE",
      mediaSettings: { mobile: { studio: { layout: "flow", kind: "story", createdAt: "2026-09-30T00:00:00.000Z", origin: "takeover" } } }
    });
    const app = await buildMobileApp();
    const response = await patchMatter(app, { authorName: "Parsa Q." });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SET_IN_STUDIO");
    expect(coverChange.commitCoverChange).not.toHaveBeenCalled();
    expect(projects[0]!.authorName).toBeNull();
  });

  // The worker's fan-in re-sets exactly the covers answered "retypeset" here,
  // including the rows with no `typeset` record: the same metadata shapes are
  // pinned in apps/worker/src/runtime/dispatchCoverRetypeset.test.ts.
  it.each([
    ["a design", { metadata: { coverArtSource: "design", coverDesignId: "night-sky", typeset: { title: "A Book", subtitle: "", authorName: "" } } }, {}, "retypeset"],
    ["a design typeset before covers recorded their words", { metadata: { coverArtSource: "design", coverDesignId: "night-sky" } }, {}, "retypeset"],
    ["a drawn cover that kept its artwork", { metadata: { coverArtSource: "ai", artworkObjectKey: "images/book-1/cover-art.jpg" } }, {}, "retypeset"],
    ["a drawn cover from before artwork was kept", { metadata: { coverArtSource: "ai", model: "imagen" } }, {}, "keeps_old_name"],
    ["an uploaded cover", { metadata: { source: "upload" } }, {}, "unchanged"],
    ["no cover yet, on a book that will draw one", null, { coverArtSource: "design" }, "retypeset"],
    ["no cover yet, on a book that will have AI art", null, { coverArtSource: "ai", includeCover: true }, "retypeset"],
    ["no cover, on a book that never has one", null, { coverArtSource: "none" }, "unchanged"]
  ])("tells a book still being written what its cover does with the byline: %s", async (_name, asset, mediaSettings, cover) => {
    projects[0] = book({ mediaSettings });
    mockPrisma.imageAsset.findFirst.mockResolvedValue(asset);
    const app = await buildMobileApp();
    const response = await patchMatter(app, { authorName: "Parsa Q." });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reprint: "next_compile", cover });
    expect(projects[0]).toMatchObject({ authorName: "Parsa Q." });
  });

  it("leaves the cover alone when only the matter pages change", async () => {
    mockPrisma.imageAsset.findFirst.mockResolvedValue({ metadata: { coverArtSource: "design", coverDesignId: "night-sky" } });
    const app = await buildMobileApp();
    const response = await patchMatter(app, { isbn: "978-0-306-40615-7" });
    expect(response.json()).toMatchObject({ reprint: "next_compile", cover: "unchanged" });
  });

  it("keeps a wide space in a one-line field, as the page prints it, and folds only ASCII runs and line breaks", async () => {
    const app = await buildMobileApp();
    const response = await patchMatter(app, {
      authorName: "山田\u3000太郎",
      imprint: "  Moonlit\u00A0Press \t\n Books ",
      copyrightHolder: "Ada\n\nLovelace"
    });
    expect(response.statusCode).toBe(200);
    expect(projects[0]).toMatchObject({
      authorName: "山田\u3000太郎",
      bookMatter: { imprint: "Moonlit\u00A0Press Books", copyrightHolder: "Ada Lovelace" }
    });
    expect(response.json().bookMatter).toMatchObject({ authorName: "山田\u3000太郎", imprint: "Moonlit\u00A0Press Books" });
  });

  it.each([
    ["an ISBN-13 with its hyphens", "978-0-306-40615-7", "978-0-306-40615-7"],
    ["an ISBN-13 with spaces", "978 0 306 40615 7", "978 0 306 40615 7"],
    ["an ISBN-10 whose check digit is X", "0-8044-2957-X", "0-8044-2957-X"],
    ["an ISBN in the reader's own numerals", "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷", "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷"],
    // The page prints "ISBN" itself; kept, it would say it twice.
    ["an ISBN typed with its label", "ISBN 978-0-306-40615-7", "978-0-306-40615-7"],
    ["an ISBN-10 typed with its label", "isbn: 0-8044-2957-X", "0-8044-2957-X"],
    // 26 characters typed, 17 stored: the limit is the stored value's, so the label cannot cost it.
    ["an ISBN-13 typed with its long label", "ISBN-13: 978-0-306-40615-7", "978-0-306-40615-7"],
    ["an ISBN-13 with its long label and spaces", "  ISBN-13 :  978 0 306 40615 7 ", "978 0 306 40615 7"],
    // A 10 or 13 a digit follows is the number's, not the label's.
    ["an ISBN-10 beginning 10 after a bare label", "ISBN 1040123457", "1040123457"],
    ["an ISBN-10 beginning 13 after a bare label", "ISBN 1302015435", "1302015435"]
  ])("stores %s as the reader typed it", async (_name, typed, stored) => {
    const app = await buildMobileApp();
    const response = await patchMatter(app, { isbn: typed });
    expect(response.statusCode).toBe(200);
    expect(projects[0]!.bookMatter).toEqual({ isbn: stored });
    expect(response.json().bookMatter.isbn).toBe(stored);
  });

  it.each([
    ["ISBN-۱۳: ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷", "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷"],
    ["ISBN-١٣: ٩٧٨-٠-٣٠٦-٤٠٦١٥-٧", "٩٧٨-٠-٣٠٦-٤٠٦١٥-٧"],
    ["ISBN-१३: ९७८-०-३०६-४०६१५-७", "९७८-०-३०६-४०६१५-७"],
    ["ISBN-১৩: ৯৭৮-০-৩০৬-৪০৬১৫-৭", "৯৭৮-০-৩০৬-৪০৬১৫-৭"],
    ["ISBN-๑๓: ๙๗๘-๐-๓๐๖-๔๐๖๑๕-๗", "๙๗๘-๐-๓๐๖-๔๐๖๑๕-๗"],
    ["ISBN-１３: ９７８-０-３０６-４０６１５-７", "９７８-０-３０６-４０６１５-７"],
    ["ISBN-۱۰: ۰-۸۰۴۴-۲۹۵۷-X", "۰-۸۰۴۴-۲۹۵۷-X"],
    // The initial 10/13 belongs to the number when another native digit follows.
    ["ISBN ۱۰۴۰۱۲۳۴۵۷", "۱۰۴۰۱۲۳۴۵۷"],
    ["ISBN ۱۳۰۲۰۱۵۴۳۵", "۱۳۰۲۰۱۵۴۳۵"],
    ["ISBN 10۴۰۱۲۳۴۵۷", "10۴۰۱۲۳۴۵۷"],
    ["ISBN 13۰۲۰۱۵۴۳۵", "13۰۲۰۱۵۴۳۵"]
  ])("saves the ISBN after a localized label without changing its numerals: %s", async (typed, stored) => {
    const app = await buildMobileApp();
    const response = await patchMatter(app, { isbn: typed });
    expect(response.statusCode).toBe(200);
    expect(response.json().bookMatter.isbn).toBe(stored);
    const saved = await app.inject({ method: "GET", url: "/api/mobile/projects/book-1/book-matter", headers: AUTH });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().bookMatter.isbn).toBe(stored);
  });

  it("still holds the ISBN to its ceiling once the label is gone, refusing rather than clipping", async () => {
    projects[0] = book({ bookMatter: { isbn: "978-0-306-40615-7" } });
    const app = await buildMobileApp();
    // 25 characters after "ISBN-13: " comes off.
    const response = await patchMatter(app, { isbn: "ISBN-13: 978-0-306-40615-7-1234567" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(projects[0]!.bookMatter).toEqual({ isbn: "978-0-306-40615-7" });
  });

  it.each([
    ["words", "ISBN hello"],
    ["a wrong check digit", "978-0-306-40615-8"],
    ["an ISBN-10's wrong check digit", "0-8044-2957-1"],
    ["too few digits", "978-0-306"],
    ["the label alone", "ISBN"]
  ])("refuses an ISBN of %s, naming the field, and writes nothing", async (_name, isbn) => {
    projects[0] = book({ status: "COMPLETE", bookMatter: { isbn: "978-0-306-40615-7" } });
    const app = await buildMobileApp();
    const response = await patchMatter(app, { isbn, dedication: "For Sara" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: "INVALID_ISBN",
      message: "That ISBN isn’t valid. Check its digits, or leave the ISBN field empty."
    });
    expect(projects[0]!.bookMatter).toEqual({ isbn: "978-0-306-40615-7" });
    expect(coverChange.commitCoverChange).not.toHaveBeenCalled();
    expect(mockTransactions()).toHaveLength(0);
  });

  it.each([
    ["empty", ""],
    ["null", null]
  ])("clears the ISBN when it is sent %s", async (_name, isbn) => {
    projects[0] = book({ bookMatter: { isbn: "978-0-306-40615-7", imprint: "Press" } });
    const app = await buildMobileApp();
    const response = await patchMatter(app, { isbn });
    expect(response.statusCode).toBe(200);
    expect(projects[0]!.bookMatter).toEqual({ imprint: "Press" });
  });

  it("waits while the book's compile is running, because that compile already read the row", async () => {
    mockPrisma.generationJob.count.mockResolvedValue(1);
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { dedication: "For Sara" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PROJECT_BUSY");
    expect(projects[0]!.bookMatter).toBeNull();
  });

  it("changes nothing, and reprints nothing, for a save that says what the book already says", async () => {
    projects[0] = book({ status: "COMPLETE", authorName: "Ada", bookMatter: { dedication: "For Sara" } });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { authorName: "Ada", dedication: "For Sara" }
    });
    expect(response.json()).toMatchObject({ reprint: "none", cover: "unchanged" });
    expect(coverChange.commitCoverChange).not.toHaveBeenCalled();
  });

  it.each([
    ["a design", { coverArtSource: "design", coverDesignId: "night-sky" }, "retypeset", { purchase: false, retypeset: true }],
    ["a drawn cover that kept its artwork", { coverArtSource: "ai", artworkObjectKey: "images/book-1/cover-art.jpg" }, "retypeset", { purchase: false, retypeset: true }],
    ["a drawn cover from before artwork was kept", { coverArtSource: "ai", model: "imagen" }, "keeps_old_name", undefined],
    ["an uploaded cover", { source: "upload" }, "unchanged", undefined]
  ])("reprints a finished book for free, and sets %s again only where that is free", async (_name, metadata, cover, drawCover) => {
    projects[0] = book({ status: "COMPLETE", authorName: "Ada" });
    mockPrisma.imageAsset.findFirst.mockResolvedValue({ metadata });
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { authorName: "Parsa Q." }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reprint: "queued", cover });
    const change = coverChange.commitCoverChange.mock.calls[0]?.[2];
    expect(change).toMatchObject({ authorName: "Parsa Q.", bookMatter: {} });
    expect(change?.drawCover).toEqual(drawCover);
    expect(coverChange.dispatchCoverJobs).toHaveBeenCalled();
  });

  it("leaves an author's byline and dedication to the Writing Studio", async () => {
    projects[0] = book({
      status: "COMPLETE",
      mediaSettings: { mobile: { studio: { layout: "flow", kind: "story", createdAt: "2026-09-30T00:00:00.000Z" } } }
    });
    const app = await buildMobileApp();
    const refused = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { dedication: "For Sara" }
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("SET_IN_STUDIO");

    const bio = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { aboutAuthor: "Writes books." }
    });
    expect(bio.statusCode).toBe(200);
    expect(bio.json().bookMatter.studioOwned).toBe(true);
  });

  it("refuses printed text the screen refuses, naming the field", async () => {
    const app = await buildMobileApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/mobile/projects/book-1/book-matter",
      headers: AUTH,
      payload: { dedication: HARMFUL }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual(["dedication"]);
  });

  it("prints a memorial dedication beside a bio that teaches how to do something", async () => {
    // Review round 7: screened as one string, these two were refused together and both named.
    const app = await buildMobileApp();
    const aboutAuthor = "Ana Ruiz is a retired gardener who teaches students how to grow tomatoes.";
    const response = await patchMatter(app, { dedication: MEMORIAL, aboutAuthor });
    expect(response.statusCode).toBe(200);
    expect(projects[0]).toMatchObject({ bookMatter: { dedication: MEMORIAL, aboutAuthor } });
  });

  it("names only the field whose own text is refused, and writes neither", async () => {
    const app = await buildMobileApp();
    const response = await patchMatter(app, { dedication: MEMORIAL, aboutAuthor: HARMFUL, imprint: "Lantern Press" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      code: "CONTENT_RESTRICTED",
      reason: "critical_illegal_harm",
      fields: ["aboutAuthor"]
    });
    expect(projects[0]!.bookMatter).toBeNull();
  });
});

describe("patchedBookMatter", () => {
  it("clears a page on null, keeps it when absent, and takes the rights line back on false", () => {
    expect(
      patchedBookMatter(
        { dedication: "For Sara", isbn: "1", allRightsReserved: true },
        { dedication: null, imprint: "Press", allRightsReserved: false }
      )
    ).toEqual({ isbn: "1", imprint: "Press" });
  });
});
