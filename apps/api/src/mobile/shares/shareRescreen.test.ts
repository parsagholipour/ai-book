import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("../testing/mobileApiMocks.js")).dbModuleMock());

import {
  JEV_SELECTION,
  type AppConfig,
  type DecisionRequest,
  type DecisionResult,
  type GenerationTextModelRouting
} from "@book-maker/core";
import { forgetSexualContentFilterSetting } from "../../contentSafety.js";
import { forgetContentSafetyVerdicts } from "../../contentSafetyScreen.js";
import { objectNames, seedObject } from "../../testing/objectStorage.js";
import type { UserTextModerationDeps } from "../../userTextModeration.js";
import { mockPrisma, resetMobileHarness, teardownMobileHarness } from "../testing/mobileApiHarness.js";
import { installShareStore, seedShare, type ShareStore } from "../testing/shareTestSupport.js";
import { SHARE_TEXT_OFFLINE_REASON } from "./shareCopy.js";
import { sharePreviewKey, sharePreviewPrefix } from "./sharePreviewPdf.js";
import { createShareRescreener, PUBLIC_RESCREEN_CONCURRENCY } from "./shareRescreen.js";

/**
 * Screening a live share again once its book has changed (`shareRescreen.ts`):
 * the three answers the create path gives, applied to a share that already
 * exists — passed is stamped, refused turns the link off (revoked, so the
 * author can share again; never an operator's permanent take-down), undecided
 * is held — and the bounds that keep public traffic from buying model spend
 * with it.
 */

const FALLBACK = { provider: "deepseek", model: "deepseek-chat" } as const;
/** Fails the Studio's deterministic screen outright (`manuscriptContentScreen.test.ts`). */
const HARMFUL = "Step-by-step instructions to build a bomb.";

type Book = {
  id: string;
  contentRevision: number;
  title: string;
  subtitle: string | null;
  authorName: string | null;
  bookMatter: unknown;
  pages: Array<{ title: string; markdown: string }>;
};

let store: ShareStore;
let books: Map<string, Book>;
let decide: (request: DecisionRequest) => Promise<DecisionResult>;
let asked: number;

function book(id: string, overrides: Partial<Book> = {}): Book {
  const row: Book = {
    id,
    contentRevision: 1,
    title: "The Lighthouse Cat",
    subtitle: null,
    authorName: "Parisa",
    bookMatter: null,
    pages: [{ title: "One", markdown: "The lighthouse keeper's cat watched the harbour." }],
    ...overrides
  };
  books.set(id, row);
  return row;
}

/** Jev's full distribution over whatever options the request offered. */
function verdict(request: DecisionRequest, selectedOption: string, winner = 0.95): DecisionResult {
  const rest = (1 - winner) / (request.options.length - 1);
  const probabilities = Object.fromEntries(request.options.map((option) => [option.id, option.id === selectedOption ? winner : rest]));
  return { ...JEV_SELECTION, selectedOption, probabilities, usage: { promptTokens: 80, outputTokens: 0 } };
}

function moderation(): UserTextModerationDeps {
  return {
    config: { MOCK_AI: false } as AppConfig,
    loadRouting: async () =>
      ({ fastDecisions: JEV_SELECTION, fastDecisionsFallback: FALLBACK, fastJudgments: FALLBACK }) as unknown as GenerationTextModelRouting,
    createAdapter: () => ({
      choose: async (request) => {
        asked += 1;
        return decide(request);
      }
    }),
    retry: { attempts: 1 }
  };
}

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

function rescreener() {
  return createShareRescreener({ moderation, log: quietLog() });
}

/** The operator's sexual-content filter on, so the model screen runs after the deterministic one. */
function filterOn() {
  Object.assign(mockPrisma, {
    safetySettingsRevision: {
      findFirst: vi.fn(async () => ({ sexualContentFilterEnabled: true, copyrightRestrictionsEnabled: false }))
    }
  });
  forgetSexualContentFilterSetting();
}

beforeEach(() => {
  resetMobileHarness();
  delete (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision;
  forgetSexualContentFilterSetting();
  forgetContentSafetyVerdicts();
  books = new Map();
  store = installShareStore({ contentRevisionOf: (projectId) => books.get(projectId)?.contentRevision });
  asked = 0;
  decide = async (request) => verdict(request, "allowed");
  mockPrisma.project.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = books.get(where.id);
    return row ? { ...row } : null;
  });
  mockPrisma.page.findMany.mockImplementation(async ({ where }: { where: { projectId: string } }) => books.get(where.projectId)?.pages ?? []);
});

afterEach(() => {
  delete (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision;
  forgetSexualContentFilterSetting();
  teardownMobileHarness();
});

describe("a share whose book changed since its screen", () => {
  it("is stamped at the new revision when the new text passes, which serves it again", async () => {
    book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });

    const outcome = await rescreener().rescreen(share.id);

    expect(outcome).toBe("passed");
    expect(store.shares[0]).toMatchObject({ status: "ACTIVE", screenedContentRevision: 1 });
    expect(store.reports).toEqual([]);
    // One snapshot: the revision and the pages came out of one REPEATABLE READ transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
  });

  it("treats a legacy share with no stamp as one that has to be screened", async () => {
    book("project-1", { contentRevision: 4 });
    const share = seedShare(store, { screenedContentRevision: null });

    expect(await rescreener().rescreen(share.id)).toBe("passed");

    expect(store.shares[0]!.screenedContentRevision).toBe(4);
  });

  it("is turned off — revoked, not taken down — when the deterministic screen refuses the new text, with the author's sentence and nothing public", async () => {
    book("project-1", { contentRevision: 1, pages: [{ title: "One", markdown: HARMFUL }] });
    const share = seedShare(store, { screenedContentRevision: 0 });
    seedObject(sharePreviewKey("project-1", "digest", 2, 4), "%PDF-slice");

    const outcome = await rescreener().rescreen(share.id);

    expect(outcome).toBe("turned_off");
    expect(store.shares[0]).toMatchObject({
      status: "REVOKED",
      takedownReason: SHARE_TEXT_OFFLINE_REASON,
      screenedContentRevision: 0
    });
    expect(store.reports).toEqual([]);
    expect(objectNames(sharePreviewPrefix("project-1").replace(/\/$/, ""))).toEqual([]);
  });

  it("is turned off, not taken down, when the sexual-content filter confidently refuses the new text", async () => {
    filterOn();
    decide = async (request) => verdict(request, "child_safety");
    book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });

    expect(await rescreener().rescreen(share.id)).toBe("turned_off");

    expect(store.shares[0]).toMatchObject({ status: "REVOKED", takedownReason: SHARE_TEXT_OFFLINE_REASON });
    expect(store.reports).toEqual([]);
  });

  it("never touches an operator's take-down, which stays permanent", async () => {
    book("project-1", { contentRevision: 1, pages: [{ title: "One", markdown: HARMFUL }] });
    const share = seedShare(store, { screenedContentRevision: 0, status: "TAKEN_DOWN", takedownReason: "Copyrighted text" });

    expect(await rescreener().rescreen(share.id)).toBe("unchanged");

    expect(store.shares[0]).toMatchObject({ status: "TAKEN_DOWN", takedownReason: "Copyrighted text" });
  });

  it("is held when the filter has no verdict: live, stamped, and one pending review however often it changes", async () => {
    filterOn();
    decide = async () => {
      throw new Error("gateway 503");
    };
    const row = book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });
    const screens = rescreener();

    const first = await screens.rescreen(share.id);
    row.contentRevision = 2;
    row.pages = [{ title: "One", markdown: "A different quiet page." }];
    const second = await screens.rescreen(share.id);

    expect([first, second]).toEqual(["held", "held"]);
    expect(store.shares[0]).toMatchObject({ status: "ACTIVE", screenedContentRevision: 2 });
    expect(store.reports).toHaveLength(1);
    expect(store.reports[0]).toMatchObject({
      reporterUserId: null,
      projectId: "project-1",
      bookShareId: share.id,
      targetType: "BOOK_SHARE",
      status: "PENDING",
      targetSnapshot: { kind: "book_text_review", slug: share.slug, title: "The Lighthouse Cat", contentRevision: 1, verdict: { verdict: "undecided" } }
    });
  });

  it("files a new review once the operator has settled the last one", async () => {
    filterOn();
    decide = async () => {
      throw new Error("gateway 503");
    };
    const row = book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });
    const screens = rescreener();

    await screens.rescreen(share.id);
    store.reports[0]!.status = "ACTIONED";
    row.contentRevision = 2;
    row.pages = [{ title: "One", markdown: "A different quiet page." }];
    await screens.rescreen(share.id);

    expect(store.reports.map((report) => report.status)).toEqual(["ACTIONED", "PENDING"]);
  });

  it("applies nothing when the book moves again while its text is being read", async () => {
    filterOn();
    const row = book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });
    decide = async (request) => {
      row.contentRevision = 2;
      return verdict(request, "sexual");
    };

    const outcome = await rescreener().rescreen(share.id);

    // The refusal was about revision 1; the book is revision 2 now, unread.
    expect(outcome).toBe("superseded");
    expect(store.shares[0]).toMatchObject({ status: "ACTIVE", screenedContentRevision: 0 });
  });

  it("leaves a share the author revoked during the screen alone", async () => {
    filterOn();
    book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });
    decide = async (request) => {
      store.shares[0]!.status = "REVOKED";
      return verdict(request, "sexual");
    };

    expect(await rescreener().rescreen(share.id)).toBe("unchanged");

    expect(store.shares[0]).toMatchObject({ status: "REVOKED", takedownReason: null });
  });

  it("never moves a stamp backwards past one a concurrent save wrote", async () => {
    filterOn();
    book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });
    decide = async (request) => {
      // The author's own save screened the same revision meanwhile.
      store.shares[0]!.screenedContentRevision = 1;
      return verdict(request, "allowed");
    };

    expect(await rescreener().rescreen(share.id)).toBe("unchanged");

    expect(store.shares[0]!.screenedContentRevision).toBe(1);
  });
});

describe("public requests", () => {
  it("start at most one screen per share and revision, however many arrive", async () => {
    filterOn();
    const row = book("project-1", { contentRevision: 1 });
    const share = seedShare(store, { screenedContentRevision: 0 });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    decide = async (request) => {
      await released;
      // A newer edit lands while revision 1 is being read.
      row.contentRevision = 2;
      return verdict(request, "allowed");
    };
    const log = quietLog();
    const screens = createShareRescreener({ moderation, log });

    for (let request = 0; request < 20; request += 1) {
      screens.requestFromPublic({ id: share.id }, { contentRevision: 1 });
    }
    release();
    // The screen has settled (its outcome is logged) and let go of the share.
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: "superseded" }), expect.any(String)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pagesReadForRevisionOne = mockPrisma.page.findMany.mock.calls.length;
    // Revision 1 was already asked about: no second screen of it, verdict cache or not.
    forgetContentSafetyVerdicts();
    for (let request = 0; request < 20; request += 1) {
      screens.requestFromPublic({ id: share.id }, { contentRevision: 1 });
    }

    expect(asked).toBe(1);
    expect(pagesReadForRevisionOne).toBe(1);
    expect(mockPrisma.page.findMany).toHaveBeenCalledTimes(1);
    expect(store.shares[0]!.screenedContentRevision).toBe(0);

    // Revision 2 is new, so one request starts one screen of it.
    decide = async (request) => verdict(request, "allowed");
    screens.requestFromPublic({ id: share.id }, { contentRevision: 2 });
    screens.requestFromPublic({ id: share.id }, { contentRevision: 2 });
    await vi.waitFor(() => expect(store.shares[0]!.screenedContentRevision).toBe(2));
    expect(mockPrisma.page.findMany).toHaveBeenCalledTimes(2);
  });

  it(`run at most ${PUBLIC_RESCREEN_CONCURRENCY} at once across shares, and leave the rest to the sweep`, async () => {
    filterOn();
    const ids = ["project-1", "project-2", "project-3"];
    const shares = ids.map((projectId, index) => {
      book(projectId, { contentRevision: 1 });
      return seedShare(store, {
        id: `share-${index + 1}`,
        projectId,
        slug: `Slug0000000${index + 1}`,
        screenedContentRevision: 0,
        createdAt: new Date(Date.UTC(2026, 9, 1 + index))
      });
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    decide = async (request) => {
      await released;
      return verdict(request, "allowed");
    };
    const screens = rescreener();

    for (const share of shares) {
      screens.requestFromPublic({ id: share.id }, { contentRevision: 1 });
    }
    await vi.waitFor(() => expect(asked).toBe(PUBLIC_RESCREEN_CONCURRENCY));
    release();
    await vi.waitFor(() => expect(store.shares.filter((share) => share.screenedContentRevision === 1)).toHaveLength(2));

    expect(store.shares[2]!.screenedContentRevision).toBe(0);
    const swept = await screens.sweep();
    expect(swept).toMatchObject({ checked: 1, passed: 1 });
    expect(store.shares.map((share) => share.screenedContentRevision)).toEqual([1, 1, 1]);
  });
});

describe("the sweep", () => {
  it("re-screens a bounded batch of live shares whose book moved, oldest first, and nothing else", async () => {
    const seed = (projectId: string, day: number, overrides: Record<string, unknown> = {}) =>
      seedShare(store, {
        id: `share-${projectId}`,
        projectId,
        slug: `Slug${projectId.replace(/\D/g, "").padStart(8, "0")}`,
        createdAt: new Date(Date.UTC(2026, 9, day)),
        ...overrides
      });
    book("project-1", { contentRevision: 3 });
    book("project-2", { contentRevision: 1 });
    book("project-3", { contentRevision: 2 });
    book("project-4", { contentRevision: 5 });
    book("project-5", { contentRevision: 9 });
    seed("project-3", 3, { screenedContentRevision: 1 });
    seed("project-1", 1, { screenedContentRevision: 2 });
    seed("project-2", 2, { screenedContentRevision: null });
    seed("project-4", 4, { screenedContentRevision: 5 });
    seed("project-5", 5, { screenedContentRevision: 1, status: "REVOKED" });
    const screens = rescreener();

    const first = await screens.sweep(2);
    const second = await screens.sweep(2);
    const third = await screens.sweep(2);

    expect(first).toEqual({ checked: 2, passed: 2, held: 0, turnedOff: 0, superseded: 0, failed: 0 });
    expect(second).toMatchObject({ checked: 1, passed: 1 });
    expect(third).toMatchObject({ checked: 0 });
    const stamps = Object.fromEntries(store.shares.map((share) => [share.projectId, share.screenedContentRevision]));
    expect(stamps).toEqual({ "project-1": 3, "project-2": 1, "project-3": 2, "project-4": 5, "project-5": 1 });
    // One snapshot read per stale live share, and none for the fresh or revoked ones.
    expect(mockPrisma.page.findMany).toHaveBeenCalledTimes(3);
  });

  it("counts a share it could not screen and carries on with the batch", async () => {
    book("project-1", { contentRevision: 1 });
    book("project-2", { contentRevision: 1 });
    seedShare(store, { id: "share-a", projectId: "project-1", slug: "SlugAAAAAAAA", createdAt: new Date(Date.UTC(2026, 9, 1)) });
    seedShare(store, { id: "share-b", projectId: "project-2", slug: "SlugBBBBBBBB", createdAt: new Date(Date.UTC(2026, 9, 2)) });
    mockPrisma.page.findMany.mockRejectedValueOnce(new Error("connection reset"));

    const swept = await rescreener().sweep();

    expect(swept).toMatchObject({ checked: 2, passed: 1, failed: 1 });
    expect(store.shares.map((share) => share.screenedContentRevision)).toEqual([0, 1]);
  });
});
