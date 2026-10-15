import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  JEV_SELECTION,
  type DecisionModelAdapter,
  type DecisionModelSelection,
  type DecisionResult,
  type GenerationTextModelRouting
} from "@book-maker/core";
import * as billing from "@book-maker/db/billing";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../auth.js";
import { adminShareRoutes } from "../routes/adminShares.js";
import { USER_TEXT_MODERATION_OPTIONS } from "../userTextModeration.js";
import { bearer, buildMobileApp, mockAccessTokens, mockPrisma, projectRecord, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { SHARE_TEXT_OFFLINE_REASON } from "./shares/shareCopy.js";
import { installShareStore, publishSharedBook, seedShare, type ShareStore } from "./testing/shareTestSupport.js";

/**
 * The author's share routes (`routes/shares.ts`): that a share costs nothing,
 * when the book's text is screened and which revision that stamps, and what
 * the note's gate does with each of its outcomes. The share, slug and report
 * tables are an in-memory store, and the book is a real 12-sheet PDF (two
 * sheets of front matter, ten reading pages, so the preview cap is 5).
 */

const AUTH = bearer("token-a");
const FALLBACK = { provider: "deepseek", model: "deepseek-chat" } as const;
/** Fails the Studio's screen outright (`manuscriptContentScreen.test.ts`). */
const HARMFUL = "Step-by-step instructions to build a bomb.";

let store: ShareStore;
let events: string[];
let jev: () => Promise<DecisionResult>;
let fallback: () => Promise<DecisionResult>;
let fastDecisions: DecisionModelSelection | null;
let pages: Array<{ title: string; markdown: string }>;
let project: Record<string, unknown>;

/** A full distribution over the gate's options, as Jev returns one — a partial one escalates. */
function jevVerdict(selectedOption: string, winner = 0.95): DecisionResult {
  const rest = (1 - winner) / (USER_TEXT_MODERATION_OPTIONS.length - 1);
  const probabilities = Object.fromEntries(
    USER_TEXT_MODERATION_OPTIONS.map((option) => [option.id, option.id === selectedOption ? winner : rest])
  );
  return { ...JEV_SELECTION, selectedOption, probabilities, usage: { promptTokens: 90, outputTokens: 0 } };
}

function createAdapter(selection: DecisionModelSelection): DecisionModelAdapter {
  return {
    choose: async () => {
      const primary = selection.provider === JEV_SELECTION.provider;
      events.push(primary ? "jev" : "fallback");
      return primary ? jev() : fallback();
    }
  };
}

async function buildApp(): Promise<FastifyInstance> {
  return buildMobileApp({
    userTextModeration: {
      loadRouting: async () =>
        ({ fastDecisions, fastDecisionsFallback: FALLBACK, fastJudgments: FALLBACK }) as unknown as GenerationTextModelRouting,
      createAdapter,
      retry: { attempts: 1 }
    }
  });
}

function put(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: "PUT", url: "/api/mobile/projects/project-1/share", headers: AUTH, payload });
}

/** What building the app calls on the billing module, before any route runs. */
const APP_BOOT_BILLING_CALLS = new Set(["ensureDefaultProductCatalog"]);

/**
 * Nothing in the billing module ran beyond the app's own boot: no balance
 * read, reservation, spend or entitlement — a share, full or preview, is free
 * (the export unlock is gone).
 */
function expectNothingCharged() {
  const called = Object.entries(billing)
    .filter(([name, value]) => !APP_BOOT_BILLING_CALLS.has(name) && vi.isMockFunction(value) && value.mock.calls.length > 0)
    .map(([name]) => name);
  expect(called).toEqual([]);
}

beforeEach(async () => {
  resetMobileHarness();
  delete (mockPrisma as { safetySettingsRevision?: unknown }).safetySettingsRevision;
  mockAccessTokens({ "token-a": "user-a" });
  store = installShareStore();
  events = [];
  jev = async () => jevVerdict("allowed");
  fallback = async () => ({ ...FALLBACK, selectedOption: "allowed" });
  fastDecisions = JEV_SELECTION;
  pages = [
    { title: "One", markdown: "The lighthouse keeper's cat watched the harbour." },
    { title: "Two", markdown: "Ships came and went." }
  ];
  const published = await publishSharedBook("project-1", 12, 2);
  project = projectRecord({ status: "COMPLETE", pdfPageMap: published.pdfPageMap, title: "The Lighthouse Cat" });
  mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
    where.id === "project-1" && where.userId === "user-a" ? project : null
  );
  mockPrisma.project.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === "project-1" ? project : null));
  mockPrisma.page.findMany.mockImplementation(async () => pages);
  mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
});

afterEach(teardownMobileHarness);

/** The account row as the share routes read it, after an operator turned sharing off (`accountModeration.ts`). */
function turnSharingOff() {
  const queryRaw = mockPrisma.$queryRaw.getMockImplementation()!;
  mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[], ...values: unknown[]) =>
    strings.join("?").includes('FROM "User"') && values[0] === "user-a"
      ? [{ status: "ACTIVE", sharingDisabledAt: new Date("2026-10-13T10:00:00.000Z") }]
      : queryRaw(strings, ...values)
  );
}

describe("share state", () => {
  it("describes a finished, unshared book: reading pages, the preview cap, and an unlock that costs nothing", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/share", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      share: null,
      book: {
        shareable: true,
        unavailableReason: null,
        kind: "generated",
        readingPages: 10,
        maxPreviewPages: 5,
        likenessRequired: false,
        // Installed builds ask for an unlock when these say otherwise; no book carries one any more.
        exportUnlocked: true,
        exportUnlockCredits: 0
      }
    });
    await app.close();
  });

  it("refuses a book that has never been compiled", async () => {
    project = projectRecord({ id: "project-1", status: "PLAN_READY" });
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SHARE_NOT_AVAILABLE");
    expect(store.shares).toEqual([]);
    await app.close();
  });
});

describe("a preview", () => {
  it("is free, needs the rights confirmation, and mints an unguessable slug", async () => {
    const app = await buildApp();

    const unconfirmed = await put(app, { mode: "preview", previewPages: 3 });
    const shared = await put(app, { mode: "preview", previewPages: 3, rightsConfirmed: true });

    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error.code).toBe("SHARE_RIGHTS_REQUIRED");
    expect(shared.statusCode).toBe(200);
    const share = shared.json().share;
    expect(share).toMatchObject({ mode: "preview", previewPages: 3, status: "active", captionStatus: "none" });
    expect(share.slug).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(share.url).toMatch(new RegExp(`/s/${share.slug}$`));
    expect(store.slugs).toEqual([share.slug]);
    expect(shared.json().exportUnlockCharged).toBe(false);
    expectNothingCharged();
    await app.close();
  });

  it("may not show more than half the reading pages", async () => {
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 6, rightsConfirmed: true });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("PREVIEW_TOO_LONG");
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("offers and accepts only one page when a long biography has no measured content boundaries", async () => {
    const published = await publishSharedBook("project-1", 17, 1);
    project.pdfPageMap = {
      kind: "cover-numbering", version: 2, hasCoverPage: true, pages: [], pdfDigest: published.digest
    };
    const app = await buildApp();

    const state = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/share", headers: AUTH });
    const oversized = await put(app, { mode: "preview", previewPages: 8, rightsConfirmed: true });
    const allowed = await put(app, { mode: "preview", previewPages: 1, rightsConfirmed: true });

    expect(state.json().book).toMatchObject({ shareable: true, readingPages: null, maxPreviewPages: 1 });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.code).toBe("PREVIEW_TOO_LONG");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().share.previewPages).toBe(1);
    expectNothingCharged();
    await app.close();
  });
});

describe("a full share", () => {
  it("is free: nothing is asked or charged, with or without the unlock the old app still offers", async () => {
    const app = await buildApp();

    const plain = await put(app, { mode: "full", rightsConfirmed: true, caption: "A cat, a lighthouse, a storm." });
    const state = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/share", headers: AUTH });

    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toMatchObject({
      exportUnlockCharged: false,
      share: { mode: "full", captionStatus: "allowed" },
      book: { exportUnlocked: true, exportUnlockCredits: 0 }
    });
    expect(state.json().book).toMatchObject({ exportUnlocked: true, exportUnlockCredits: 0 });
    expect(events).toEqual(["jev"]);
    expectNothingCharged();
    await app.close();
  });

  it("accepts and ignores acceptExportUnlock from an installed build", async () => {
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true, acceptExportUnlock: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exportUnlockCharged: false, share: { mode: "full", status: "active" } });
    expectNothingCharged();
    await app.close();
  });

  it("is free for an author's own book too, an import or a Studio book", async () => {
    // An imported manuscript (`isAuthorManuscript`), which no plan ever covered under the unlock.
    const settings = (project.mediaSettings ?? {}) as Record<string, unknown>;
    project.mediaSettings = { ...settings, mobile: { ...((settings.mobile ?? {}) as Record<string, unknown>), import: { format: "docx" } } };
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exportUnlockCharged: false, book: { exportUnlocked: true, exportUnlockCredits: 0 } });
    expectNothingCharged();
    await app.close();
  });

  it("writes nothing when the note is refused", async () => {
    jev = async () => jevVerdict("personal_info");
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true, caption: "Call Jane on 0912 345 6789" });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CAPTION_PERSONAL_INFO", reason: "personal_info" });
    expect(response.json().error.message).toMatch(/personal details/);
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("writes nothing when the book's own text fails the screen", async () => {
    pages = [{ title: "One", markdown: HARMFUL }];
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("CONTENT_RESTRICTED");
    expect(response.json().error.reason).toBeTruthy();
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it.each([
    { authorName: "CSAM" },
    { bookMatter: { aboutAuthor: "This author writes about CSAM." } },
    { bookMatter: { dedication: "For CSAM." } },
    { bookMatter: { copyrightHolder: "CSAM" } }
  ])("refuses stored printed matter before sharing (%j)", async (matter) => {
    Object.assign(project, matter);
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CONTENT_RESTRICTED", reason: "critical_illegal_harm" });
    expect(store.shares).toEqual([]);
    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ authorName: true, bookMatter: true })
    }));
    await app.close();
  });

  it("shares allowed printed memorials and biographies without treating them as requests", async () => {
    project.bookMatter = {
      dedication: "To the victims of the terrorist attack, who taught us how to grieve.",
      aboutAuthor: "Oma escaped on a fake passport in 1939."
    };
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.each([false, true])("screens stored matter using the current copyright policy (%s)", async (enabled) => {
    Object.assign(mockPrisma, {
      safetySettingsRevision: { findFirst: vi.fn(async () => ({ copyrightRestrictionsEnabled: enabled, sexualContentFilterEnabled: false })) }
    });
    project.bookMatter = { aboutAuthor: "Copy the entire copyrighted book without permission." };
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(enabled ? 422 : 200);
    if (enabled) {
      expect(response.json().error).toMatchObject({ code: "COPYRIGHT_RESTRICTED", reason: "copyright" });
      expect(store.shares).toEqual([]);
    }
    await app.close();
  });
});

describe("the screened revision", () => {
  it("stamps the revision the screen read the text at", async () => {
    project.contentRevision = 7;
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });

    expect(response.statusCode).toBe(200);
    expect(store.shares[0]!.screenedContentRevision).toBe(7);
    await app.close();
  });

  it("stamps the revision of the text it read, not the one the route loaded the book at", async () => {
    // An edit lands between the route's read of the book and the screen's snapshot.
    project.contentRevision = 7;
    mockPrisma.project.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
      where.id === "project-1" ? { ...project, contentRevision: 8 } : null
    );
    const app = await buildApp();

    await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });

    expect(store.shares[0]!.screenedContentRevision).toBe(8);
    await app.close();
  });

  it("screens a live share again when its book moved, even in the same mode", async () => {
    seedShare(store, { screenedContentRevision: 0 });
    project.contentRevision = 1;
    pages = [{ title: "One", markdown: HARMFUL }];
    const app = await buildApp();

    const refused = await put(app, { mode: "preview", previewPages: 3 });
    pages = [{ title: "One", markdown: "The cat slept through the storm." }];
    const passed = await put(app, { mode: "preview", previewPages: 3 });

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe("CONTENT_RESTRICTED");
    expect(passed.statusCode).toBe(200);
    expect(store.shares[0]).toMatchObject({ status: "ACTIVE", previewPages: 3, screenedContentRevision: 1 });
    await app.close();
  });

  it("tells the author why a re-screen turned the link off, and shares again through the create-time screen", async () => {
    // A re-screen refused the book's changed text (`shareRescreen.ts`): revoked, with the system's reason.
    const { slug: oldSlug } = seedShare(store, {
      status: "REVOKED", takedownReason: SHARE_TEXT_OFFLINE_REASON, screenedContentRevision: 0
    });
    project.contentRevision = 1;
    pages = [{ title: "One", markdown: HARMFUL }];
    const app = await buildApp();

    const state = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/share", headers: AUTH });
    const stillRefused = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });
    const afterRefusal = { ...store.shares[0] };
    pages = [{ title: "One", markdown: "The cat slept through the storm." }];
    project.contentRevision = 2;
    const reshared = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });

    expect(state.json().share).toMatchObject({ status: "revoked", stoppedReason: SHARE_TEXT_OFFLINE_REASON, takedownReason: null });
    expect(stillRefused.statusCode).toBe(422);
    expect(stillRefused.json().error.code).toBe("CONTENT_RESTRICTED");
    expect(afterRefusal).toMatchObject({ status: "REVOKED", slug: oldSlug, takedownReason: SHARE_TEXT_OFFLINE_REASON });
    expect(reshared.statusCode).toBe(200);
    expect(reshared.json().share).toMatchObject({ status: "active", stoppedReason: null, takedownReason: null });
    expect(reshared.json().share.slug).not.toBe(oldSlug);
    expect(store.shares[0]).toMatchObject({ status: "ACTIVE", takedownReason: null, screenedContentRevision: 2 });
    await app.close();
  });

  it("says nothing of a reason on a share its author stopped", async () => {
    seedShare(store);
    const app = await buildApp();

    const stopped = await app.inject({ method: "DELETE", url: "/api/mobile/projects/project-1/share", headers: AUTH });

    expect(stopped.json().share).toMatchObject({ status: "revoked", stoppedReason: null, takedownReason: null });
    await app.close();
  });

  it("does not read the text again for a live share already screened at the current revision", async () => {
    seedShare(store, { screenedContentRevision: 0 });
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 4 });

    expect(response.statusCode).toBe(200);
    expect(mockPrisma.page.findMany).not.toHaveBeenCalled();
    expect(store.shares[0]).toMatchObject({ previewPages: 4, screenedContentRevision: 0 });
    await app.close();
  });
});

describe("the note", () => {
  it("is refused on a link before any model is asked", async () => {
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true, caption: "More at mybook.com" });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("CAPTION_LINK_NOT_ALLOWED");
    expect(events).toEqual([]);
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("refuses a note over 500 characters with its own sentence", async () => {
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true, caption: "a".repeat(501) });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("CAPTION_TOO_LONG");
    await app.close();
  });

  it("is held for review, with a system report, when Jev and the fallback both fail", async () => {
    jev = async () => {
      throw new Error("gateway 503");
    };
    fallback = async () => {
      throw new Error("fallback down");
    };
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true, caption: "A quiet book about grief." });

    expect(response.statusCode).toBe(200);
    expect(response.json().share).toMatchObject({ status: "active", captionStatus: "pending_review", caption: "A quiet book about grief." });
    expect(events).toEqual(["jev", "fallback"]);
    expect(store.reports).toHaveLength(1);
    expect(store.reports[0]).toMatchObject({
      reporterUserId: null,
      projectId: "project-1",
      bookShareId: store.shares[0]!.id,
      targetType: "BOOK_SHARE",
      targetSnapshot: { kind: "caption_review", caption: "A quiet book about grief.", verdict: { verdict: "undecided", reason: "provider_failure" } }
    });
    expect(store.reports[0]!.targetSnapshot.verdict.attempts.map((attempt: { role: string }) => attempt.role)).toEqual(["primary", "fallback"]);
    await app.close();
  });

  it("is held for review when fast decisions are not on Jev", async () => {
    fastDecisions = null;
    const app = await buildApp();

    const response = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true, caption: "For my niece." });

    expect(response.statusCode).toBe(200);
    expect(response.json().share.captionStatus).toBe("pending_review");
    expect(events).toEqual([]);
    expect(store.reports[0]).toMatchObject({ targetSnapshot: { verdict: { verdict: "undecided", reason: "no_route" } } });
    await app.close();
  });

  it("is moderated over a real socket, where a read request body is already destroyed", async () => {
    const app = await buildApp();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await fetch(`${address}/api/mobile/projects/project-1/share`, {
      method: "PUT",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ mode: "preview", previewPages: 2, rightsConfirmed: true, caption: "For my niece." })
    });

    expect(response.status).toBe(200);
    expect((await response.json()).share.captionStatus).toBe("allowed");
    expect(events).toEqual(["jev"]);
    await app.close();
  });

  it("is not moderated again when it has not changed", async () => {
    const app = await buildApp();

    await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true, caption: "For my niece." });
    const again = await put(app, { mode: "preview", previewPages: 4, caption: "For my niece." });

    expect(again.statusCode).toBe(200);
    expect(again.json().share).toMatchObject({ previewPages: 4, captionStatus: "allowed" });
    expect(events).toEqual(["jev"]);
    await app.close();
  });
});

describe("likeness, take-downs and revokes", () => {
  it("demands the likeness confirmation when the cast includes someone drawn from a photo", async () => {
    project = {
      ...project,
      mediaSettings: { mobile: { bookType: "short_story", characters: [{ id: "character-1", name: "Mina", description: "", fields: [] }] } }
    };
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([{ id: "character-1", photoKind: "UNKNOWN", photoPath: "photo.jpg" }]);
    const app = await buildApp();

    const state = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/share", headers: AUTH });
    const refused = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });
    const confirmed = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true, likenessConfirmed: true });

    expect(state.json().book.likenessRequired).toBe(true);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("SHARE_LIKENESS_REQUIRED");
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().share.likenessConfirmed).toBe(true);
    expect(store.shares[0]!.likenessConfirmedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it("keeps a taken-down share down: no re-share, and a revoke does not clear it", async () => {
    seedShare(store, { status: "TAKEN_DOWN", takedownReason: "Copyrighted text" });
    const app = await buildApp();

    const reshare = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });
    const revoke = await app.inject({ method: "DELETE", url: "/api/mobile/projects/project-1/share", headers: AUTH });

    expect(reshare.statusCode).toBe(409);
    expect(reshare.json().error.code).toBe("SHARE_TAKEN_DOWN");
    expect(revoke.json().share).toMatchObject({ status: "taken_down", takedownReason: "Copyrighted text" });
    await app.close();
  });

  it("refuses an account whose sharing an operator turned off, before reading the book", async () => {
    turnSharingOff();
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "SHARING_DISABLED", message: expect.stringContaining("Sharing is turned off") });
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("revokes, then re-shares under a new slug while the old one stays retired", async () => {
    const { slug: oldSlug } = seedShare(store);
    const app = await buildApp();

    const revoked = await app.inject({ method: "DELETE", url: "/api/mobile/projects/project-1/share", headers: AUTH });
    const reshared = await put(app, { mode: "preview", previewPages: 2, rightsConfirmed: true });

    expect(revoked.json().share.status).toBe("revoked");
    expect(reshared.json().share.status).toBe("active");
    expect(reshared.json().share.slug).not.toBe(oldSlug);
    expect(store.slugs).toEqual([oldSlug, reshared.json().share.slug]);
    await app.close();
  });

  it.each(["ACTIVE", "REVOKED"])("refuses an operator takedown during moderation of an %s share", async (status) => {
    const { id, slug } = seedShare(store, { status });
    let moderationStarted!: () => void;
    let releaseModeration!: () => void;
    const started = new Promise<void>((resolve) => { moderationStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseModeration = resolve; });
    jev = async () => {
      moderationStarted();
      await released;
      return jevVerdict("allowed");
    };
    const app = await buildApp();
    const admin = Fastify();
    await registerAuth(admin, { WEB_PASSWORD: "" } as never);
    await admin.register(adminShareRoutes);
    const pending = put(app, {
      mode: "full", rightsConfirmed: true, caption: "For my niece."
    }).then((response) => response);

    try {
      await started;
      const takenDown = await admin.inject({
        method: "POST", url: `/api/admin/shares/${id}/moderation`,
        payload: { action: "take_down", reason: "Copyrighted text" }
      });
      expect(takenDown.statusCode).toBe(200);
      releaseModeration();
      const response = await pending;

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("SHARE_TAKEN_DOWN");
      expect(store.shares[0]).toMatchObject({ slug, status: "TAKEN_DOWN", takedownReason: "Copyrighted text", caption: null });
      expect(store.slugs).toEqual([slug]);
      expect(store.reports).toEqual([]);
    } finally {
      releaseModeration();
      await pending;
      await app.close();
      await admin.close();
    }
  });

  it("returns the takedown conflict when the operator acts after the last preflight", async () => {
    const { id, slug } = seedShare(store, { status: "REVOKED" });
    const app = await buildApp();
    const admin = Fastify();
    await registerAuth(admin, { WEB_PASSWORD: "" } as never);
    await admin.register(adminShareRoutes);
    // The operator acts just as the write starts: after every route check, as
    // the share transaction takes the account's lock.
    const queryRaw = mockPrisma.$queryRaw.getMockImplementation()!;
    let tookDown = false;
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[], ...values: unknown[]) => {
      const sql = strings.join("?");
      if (!tookDown && sql.includes('FROM "User"') && sql.includes("FOR SHARE")) {
        tookDown = true;
        const response = await admin.inject({
          method: "POST", url: `/api/admin/shares/${id}/moderation`,
          payload: { action: "take_down", reason: "Copyrighted text" }
        });
        expect(response.statusCode).toBe(200);
      }
      return queryRaw(strings, ...values);
    });

    try {
      const response = await put(app, { mode: "full", rightsConfirmed: true });

      expect(tookDown).toBe(true);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("SHARE_TAKEN_DOWN");
      expect(store.shares[0]).toMatchObject({ slug, status: "TAKEN_DOWN", takedownReason: "Copyrighted text" });
      expect(store.slugs).toEqual([slug]);
      expect(store.reports).toEqual([]);
    } finally {
      await app.close();
      await admin.close();
    }
  });
});

describe("make a book like this", () => {
  it("answers the book's format and nothing of its content", async () => {
    seedShare(store, { slug: "Remix0Slug12" });
    project = { ...project, prompt: "SECRET BRIEF", mediaSettings: { mobile: { bookType: "short_story", lengthPreset: "short", qualityPreset: "premium", imagesEnabled: true } }, targetPages: 24 };
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual(["presets", "title"]);
    expect(response.json()).toEqual({
      title: "The Lighthouse Cat",
      presets: {
        bookType: "short_story",
        bookTypeChoice: "short_story",
        lengthPreset: "short",
        qualityPreset: "premium",
        coverEnabled: true,
        illustrationsEnabled: true,
        pageCountMode: "custom",
        targetPages: 24,
        pageCountSource: "settings"
      }
    });
    expect(response.body).not.toContain("SECRET BRIEF");
    await app.close();
  });

  it("offers an Ultra or over-long format as one the remixer can start today", async () => {
    seedShare(store, { slug: "Remix0Slug12" });
    project = { ...project, mediaSettings: { mobile: { bookType: "lead_magnet", lengthPreset: "expanded", qualityPreset: "ultra", imagesEnabled: false } }, targetPages: 320 };
    const app = await buildApp();

    const presets = (await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH })).json().presets;

    // Ultra is off at launch and no generated book passes 200 pages yet.
    expect(presets).toMatchObject({ qualityPreset: "premium", targetPages: 200 });
    await app.close();
  });

  it("never sends an automatic book-type choice, which would let the chat drop the format", async () => {
    seedShare(store, { slug: "Remix0Slug12" });
    project = { ...project, mediaSettings: { mobile: { bookType: "workbook", bookTypeChoice: "auto", lengthPreset: "short", qualityPreset: "fast", imagesEnabled: false } } };
    const app = await buildApp();

    const presets = (await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH })).json().presets;

    expect(presets.bookType).toBe("workbook");
    expect(presets).not.toHaveProperty("bookTypeChoice");
    await app.close();
  });

  it("is refused to an account whose sharing an operator turned off", async () => {
    seedShare(store, { slug: "Remix0Slug12" });
    turnSharingOff();
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("SHARING_DISABLED");
    await app.close();
  });

  it("sends no title while the book has changed since the share's last screen", async () => {
    seedShare(store, { slug: "Remix0Slug12", screenedContentRevision: 0 });
    project = { ...project, contentRevision: 1 };
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe("");
    expect(response.body).not.toContain("The Lighthouse Cat");
    expect(response.json().presets).toMatchObject({ pageCountMode: "custom" });
    await app.close();
  });

  it("is gone once the share stops", async () => {
    seedShare(store, { slug: "Remix0Slug12", status: "REVOKED" });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH });

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("REMIX_NOT_AVAILABLE");
    await app.close();
  });

  it("records the share as the origin of the chat it starts", async () => {
    const share = seedShare(store, { slug: "Remix0Slug12" });
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "draft-1",
      revision: 1,
      archived: false,
      createdProjectId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      outputs: [],
      ...data
    }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: AUTH,
      payload: { remixSlug: "Remix0Slug12", presets: { bookType: "short_story", lengthPreset: "short", qualityPreset: "balanced" } }
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.mobileCreationDraft.create.mock.calls[0]![0].data).toMatchObject({ originShareId: share.id });
    await app.close();
  });
});
