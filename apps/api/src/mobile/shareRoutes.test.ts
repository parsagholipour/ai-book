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
import { ensureProjectExportEntitlementOrSpend, hasActiveProjectEntitlement, InsufficientCreditsError } from "@book-maker/db/billing";
import type { FastifyInstance } from "fastify";
import { USER_TEXT_MODERATION_OPTIONS } from "../userTextModeration.js";
import { bearer, buildMobileApp, mockAccessTokens, mockPrisma, projectRecord, resetMobileHarness, teardownMobileHarness } from "./testing/mobileApiHarness.js";
import { installShareStore, publishSharedBook, seedShare, type ShareStore } from "./testing/shareTestSupport.js";

/**
 * The author's share routes (`routes/shares.ts`): what a share costs, when,
 * and what the note's gate does with each of its outcomes. The share, slug and
 * report tables are an in-memory store, and the book is a real 12-sheet PDF
 * (two sheets of front matter, ten reading pages, so the preview cap is 5).
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

beforeEach(async () => {
  resetMobileHarness();
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
  vi.mocked(hasActiveProjectEntitlement).mockResolvedValue(false);
  vi.mocked(ensureProjectExportEntitlementOrSpend).mockImplementation(async () => {
    events.push("unlock");
    return { entitlement: {} as never, chargedLedgerEntry: {} as never };
  });
});

afterEach(teardownMobileHarness);

describe("share state", () => {
  it("describes a finished, unshared book: reading pages, the preview cap, the unlock price", async () => {
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
        exportUnlocked: false
      }
    });
    expect(response.json().book.exportUnlockCredits).toBeGreaterThan(0);
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
    expect(ensureProjectExportEntitlementOrSpend).not.toHaveBeenCalled();
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
});

describe("a full share", () => {
  it("asks for the unlock on a locked book instead of charging", async () => {
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({ code: "EXPORT_UNLOCK_REQUIRED" });
    expect(response.json().error.creditsRequired).toBeGreaterThan(0);
    expect(ensureProjectExportEntitlementOrSpend).not.toHaveBeenCalled();
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("charges the unlock exactly once, and only after the screen and the note's verdict", async () => {
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true, acceptExportUnlock: true, caption: "A cat, a lighthouse, a storm." });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exportUnlockCharged: true, share: { mode: "full", captionStatus: "allowed" } });
    expect(events).toEqual(["jev", "unlock"]);
    expect(ensureProjectExportEntitlementOrSpend).toHaveBeenCalledOnce();
    expect(ensureProjectExportEntitlementOrSpend).toHaveBeenCalledWith({
      userId: "user-a",
      projectId: "project-1",
      idempotencyKey: "mobile:project:project-1:export-unlock"
    });
    await app.close();
  });

  it("charges nothing when the note is refused after the unlock was offered", async () => {
    jev = async () => jevVerdict("personal_info");
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true, acceptExportUnlock: true, caption: "Call Jane on 0912 345 6789" });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({ code: "CAPTION_PERSONAL_INFO", reason: "personal_info" });
    expect(response.json().error.message).toMatch(/personal details/);
    expect(ensureProjectExportEntitlementOrSpend).not.toHaveBeenCalled();
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("charges nothing when the book's own text fails the screen", async () => {
    pages = [{ title: "One", markdown: HARMFUL }];
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true, acceptExportUnlock: true });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("CONTENT_RESTRICTED");
    expect(response.json().error.reason).toBeTruthy();
    expect(ensureProjectExportEntitlementOrSpend).not.toHaveBeenCalled();
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("writes nothing when the unlock cannot be paid for", async () => {
    vi.mocked(ensureProjectExportEntitlementOrSpend).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 100, availableCredits: 3, reservedCredits: 0 } as never)
    );
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true, acceptExportUnlock: true });

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("INSUFFICIENT_CREDITS");
    expect(store.shares).toEqual([]);
    await app.close();
  });

  it("is free on a book that was already unlocked", async () => {
    vi.mocked(hasActiveProjectEntitlement).mockResolvedValue(true);
    const app = await buildApp();

    const response = await put(app, { mode: "full", rightsConfirmed: true });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ exportUnlockCharged: false, share: { mode: "full" }, book: { exportUnlocked: true, exportUnlockCredits: 0 } });
    expect(ensureProjectExportEntitlementOrSpend).not.toHaveBeenCalled();
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

  it("never sends an automatic book-type choice, which would let the chat drop the format", async () => {
    seedShare(store, { slug: "Remix0Slug12" });
    project = { ...project, mediaSettings: { mobile: { bookType: "workbook", bookTypeChoice: "auto", lengthPreset: "short", qualityPreset: "fast", imagesEnabled: false } } };
    const app = await buildApp();

    const presets = (await app.inject({ method: "GET", url: "/api/mobile/shares/Remix0Slug12/remix", headers: AUTH })).json().presets;

    expect(presets.bookType).toBe("workbook");
    expect(presets).not.toHaveProperty("bookTypeChoice");
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
