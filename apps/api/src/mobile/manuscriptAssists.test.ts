import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import type { FastifyInstance } from "fastify";
import { longAssistCredits } from "./manuscript/manuscriptAssists.js";
import { imageQuota, quotaAllowed } from "./testing/addImageChatSupport.js";
import { installManuscriptFakeDb, type ManuscriptFakeDb } from "./testing/manuscriptFakeDb.js";
import {
  buildMobileApp,
  mockAccessTokens,
  mockBilling,
  mockQueue,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";
import { AUTH, createStudioBook, longAssist, saveChapter, seedImportedBook } from "./testing/manuscriptTestSupport.js";

let db: ManuscriptFakeDb;

beforeEach(() => {
  resetMobileHarness();
  db = installManuscriptFakeDb();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

/** 2,000 characters of prose: two pages at the 1,900-character feedback page. */
const TWO_PAGE_CHAPTER = "The keeper climbed the stairs. ".repeat(65).trim().slice(0, 2000);

async function book(app: FastifyInstance, requestId = "request-create-0001") {
  const { body } = await createStudioBook(app, { requestId });
  const projectId = body.project.id as string;
  const chapterId = body.chapter.id as string;
  await saveChapter(app, projectId, { id: chapterId, revision: 1 }, TWO_PAGE_CHAPTER);
  return { projectId, chapterId };
}

function reserved(): Array<{ operation: string; amountCredits: number }> {
  return mockBilling.reserveCredits.mock.calls.map((call) => call[0] as { operation: string; amountCredits: number });
}

describe("long assist prices", () => {
  // Spelled out rather than derived from the price table, like the app's own
  // `studio_pricing.dart` tests, so one shared bug cannot hide in both.
  it("computes exactly what the app quotes", () => {
    expect(longAssistCredits("illustrate", { tier: "balanced" })).toBe(45);
    expect(longAssistCredits("illustrate", { tier: "premium" })).toBe(85);
    expect(longAssistCredits("draft_chapter", { tier: "balanced" })).toBe(400);
    expect(longAssistCredits("draft_chapter", { tier: "balanced", targetWords: 300 })).toBe(80);
    expect(longAssistCredits("draft_chapter", { tier: "balanced", targetWords: 4000 })).toBe(960);
    expect(longAssistCredits("chapter_feedback", { tier: "balanced", chapterChars: 0 })).toBe(35);
    expect(longAssistCredits("chapter_feedback", { tier: "balanced", chapterChars: 1900 })).toBe(35);
    expect(longAssistCredits("chapter_feedback", { tier: "balanced", chapterChars: 2000 })).toBe(45);
    expect(longAssistCredits("consistency", { tier: "premium" })).toBe(200);
    expect(longAssistCredits("outline", { tier: "balanced" })).toBe(40);
  });
});

describe("POST /manuscript/assists", () => {
  it("charges each kind at its price and queues one WRITING_ASSIST job beside its row", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await book(app);
    const cases = [
      { payload: { kind: "illustrate", chapterId, prompt: "The keeper on the stairs" }, operation: "IMAGE_GENERATION", credits: 45, row: "ILLUSTRATE" },
      { payload: { kind: "draft_chapter", chapterId, notes: "She finds the logbook." }, operation: "PAGE_REGENERATION", credits: 400, row: "DRAFT_CHAPTER" },
      { payload: { kind: "chapter_feedback", chapterId }, operation: "BOOK_TEXT_EDIT", credits: 45, row: "CHAPTER_FEEDBACK" },
      { payload: { kind: "consistency" }, operation: "PREMIUM_REVIEW", credits: 200, row: "CONSISTENCY" },
      { payload: { kind: "outline", notes: "A keeper and a storm." }, operation: "PLAN_GENERATION", credits: 40, row: "OUTLINE" }
    ];

    for (const [index, entry] of cases.entries()) {
      const response = await longAssist(app, projectId, { ...entry.payload, requestId: `request-assist-000${index}` });
      expect(response.statusCode).toBe(200);
      const assist = response.json().assist;
      expect(assist).toMatchObject({
        kind: entry.payload.kind,
        status: "queued",
        creditsCharged: entry.credits,
        error: null,
        result: null,
        chapterId: "chapterId" in entry.payload ? chapterId : null
      });
      const row = db.assists.find((candidate) => candidate.id === assist.id)!;
      const job = db.enqueued.at(-1)!;
      expect(row).toMatchObject({
        kind: entry.row,
        status: "QUEUED",
        creditsCharged: entry.credits,
        ledgerEntryId: `ledger-${entry.operation}`,
        generationJobId: job.id,
        requestId: `request-assist-000${index}`
      });
      expect(job).toMatchObject({ type: "WRITING_ASSIST", dispatch: false });
      expect(job.payload).toEqual({ assistId: assist.id, attemptId: expect.any(String) });
      expect(mockQueue.enqueueGenerationJob.mock.calls.at(-1)![0]).toMatchObject({ attemptId: job.payload.attemptId });
      expect(mockQueue.dispatchGenerationJob.mock.calls.at(-1)![0]).toBe(job.id);
      expect(reserved().at(-1)).toMatchObject({ operation: entry.operation, amountCredits: entry.credits });
    }
    expect(db.assists.find((row) => row.kind === "DRAFT_CHAPTER")!.input).toEqual({ notes: "She finds the logbook.", targetWords: 1500 });
    expect(db.assists.find((row) => row.kind === "OUTLINE")!.input).toEqual({ notes: "A keeper and a storm." });
    expect(state.generationAttempts.map((attempt) => attempt.operation)).toEqual(cases.map((entry) => entry.operation));
  });

  it("prices at the book's own tier", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await book(app);
    db.projects[0]!.mediaSettings = { ...db.projects[0]!.mediaSettings, modelTier: "premium" };

    const response = await longAssist(app, projectId, { kind: "illustrate", chapterId, passage: "The stairs", requestId: "request-tier-0001" });

    expect(response.json().assist.creditsCharged).toBe(85);
    expect(reserved()).toEqual([expect.objectContaining({ operation: "IMAGE_GENERATION", amountCredits: 85 })]);
  });

  it("answers a replayed requestId with the assist it already made, charging once", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await book(app);
    const payload = { kind: "draft_chapter", chapterId, targetWords: 4000, requestId: "request-replay-0001" };

    const first = await longAssist(app, projectId, payload);
    const again = await longAssist(app, projectId, payload);

    expect(again.statusCode).toBe(200);
    expect(again.json().assist.id).toBe(first.json().assist.id);
    expect(first.json().assist.creditsCharged).toBe(960);
    expect(reserved()).toHaveLength(1);
    expect(db.enqueued).toHaveLength(1);
    expect(db.assists).toHaveLength(1);
  });

  it("claims the free tier's illustrated-book slot once, and answers 403 when it is gone", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await book(app);
    mockBilling.getImageQuota.mockResolvedValue(imageQuota(0) as never);
    mockBilling.consumeIllustratedBookUse.mockResolvedValue(quotaAllowed);

    const first = await longAssist(app, projectId, { kind: "illustrate", chapterId, prompt: "A storm", requestId: "request-quota-0001" });
    expect(first.statusCode).toBe(200);
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledWith({ userId: "user-a", limit: 3 });
    expect(reserved()[0]).toMatchObject({ metadata: expect.objectContaining({ imageQuota: { periodKey: "2026-08" } }) });

    // The book is illustrated now: a second picture claims nothing more.
    await longAssist(app, projectId, { kind: "illustrate", chapterId, prompt: "The dawn", requestId: "request-quota-0002" });
    expect(mockBilling.consumeIllustratedBookUse).toHaveBeenCalledTimes(1);

    // Another book, with the month's slots spent.
    const other = await book(app, "request-create-0002");
    mockBilling.consumeIllustratedBookUse.mockResolvedValue({ ...quotaAllowed, allowed: false, used: 3 });
    const refused = await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${other.projectId}/manuscript/assists`,
      headers: AUTH,
      payload: { kind: "illustrate", chapterId: other.chapterId, prompt: "A storm", requestId: "request-quota-0003" }
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: "IMAGE_LIMIT_REACHED", imageQuota: { used: 3, limit: 3 } });
    expect(db.assists.filter((row) => row.projectId === other.projectId)).toEqual([]);
  });

  it("answers 402 with the shortfall when the credits are not there, and writes nothing", async () => {
    const app = await buildMobileApp();
    const { projectId } = await book(app);
    mockBilling.reserveCredits.mockRejectedValueOnce(
      new mockBilling.InsufficientCreditsError({ requiredCredits: 200, availableCredits: 20, reservedCredits: 0 })
    );

    const response = await longAssist(app, projectId, { kind: "consistency", requestId: "request-broke-0001" });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({ code: "INSUFFICIENT_CREDITS", requiredCredits: 200, availableCredits: 20 });
    expect(db.assists).toEqual([]);
    expect(db.enqueued).toEqual([]);
  });

  it("refuses what the worker could only fail, before a credit moves", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await book(app);
    const empty = (await app.inject({
      method: "POST",
      url: `/api/mobile/projects/${projectId}/manuscript/chapters`,
      headers: AUTH,
      payload: { title: "Empty", requestId: "request-add-empty" }
    })).json().chapter.id as string;
    const refusal = async (payload: Record<string, unknown>) => {
      const response = await longAssist(app, projectId, payload);
      return [response.statusCode, response.json().error?.code];
    };

    expect(await refusal({ kind: "illustrate", prompt: "x", requestId: "request-no-0001" })).toEqual([400, "CHAPTER_REQUIRED"]);
    expect(await refusal({ kind: "illustrate", chapterId: "gone", prompt: "x", requestId: "request-no-0002" })).toEqual([404, "CHAPTER_NOT_FOUND"]);
    expect(await refusal({ kind: "illustrate", chapterId, requestId: "request-no-0003" })).toEqual([400, "PROMPT_REQUIRED"]);
    expect(await refusal({ kind: "chapter_feedback", chapterId: empty, requestId: "request-no-0004" })).toEqual([400, "NOTHING_TO_READ"]);
    expect(await refusal({ kind: "draft_chapter", chapterId, targetWords: 10_000, requestId: "request-no-0005" })).toEqual([400, "INVALID_ASSIST"]);
    expect(reserved()).toEqual([]);

    const imported = seedImportedBook(db);
    const outline = await longAssist(app, imported, { kind: "outline", requestId: "request-no-0006" });
    expect([outline.statusCode, outline.json().error.code]).toEqual([409, "OUTLINE_NOT_AVAILABLE"]);
  });
});

describe("reading and settling assists", () => {
  async function seeded(app: FastifyInstance) {
    const { projectId, chapterId } = await book(app);
    const at = (minute: number) => new Date(`2026-09-20T10:${String(minute).padStart(2, "0")}:00.000Z`);
    const row = (id: string, kind: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      chapterId,
      kind,
      status,
      input: {},
      result: null,
      error: null,
      creditsCharged: 45,
      ledgerEntryId: null,
      generationJobId: `job-${id}`,
      requestId: `request-${id}`,
      createdAt: at(Number(id.replace(/\D/g, "")) || 0),
      updatedAt: at(0),
      ...extra
    });
    db.assists.push(
      row("as1", "ILLUSTRATE", "READY", {
        result: {
          type: "image",
          url: `/assets/images/${projectId}/studio-image-as1.jpg`,
          alt: "The keeper",
          provenance: { provider: "gemini", model: "gemini-3-pro-image" }
        }
      }),
      row("as2", "CHAPTER_FEEDBACK", "READY", {
        result: { type: "notes", notes: [{ quote: "The keeper", note: "Slow down here.", severity: "issue", extra: "x" }] }
      }),
      row("as3", "CONSISTENCY", "READY", {
        chapterId: null,
        result: { type: "notes", notes: [{ quote: null, note: "Two names for the boat.", severity: "suggestion", chapterId }] }
      }),
      row("as4", "OUTLINE", "QUEUED", { chapterId: null }),
      row("as5", "DRAFT_CHAPTER", "FAILED", { error: "The chapter draft couldn’t be written. Your credits were returned." }),
      row("as6", "REEMBED", "QUEUED", { chapterId: null, creditsCharged: 0 }),
      row("as7", "DRAFT_CHAPTER", "READY", { chapterId: "other-chapter", result: { type: "draft", markdown: "She opened the logbook." } })
    );
    return { projectId, chapterId };
  }

  it("lists the author's open assists, newest first, never the internal passes", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await seeded(app);

    const open = await app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript/assists?open=1`, headers: AUTH });
    expect(open.json().assists.map((assist: { id: string }) => assist.id)).toEqual(["as7", "as4", "as3", "as2", "as1"]);
    const forChapter = await app.inject({
      method: "GET",
      url: `/api/mobile/projects/${projectId}/manuscript/assists?open=1&chapterId=${chapterId}`,
      headers: AUTH
    });
    expect(forChapter.json().assists.map((assist: { id: string }) => assist.id)).toEqual(["as2", "as1"]);
    const all = await app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript/assists`, headers: AUTH });
    expect(all.json().assists.map((assist: { id: string }) => assist.id)).not.toContain("as6");
    expect(all.json().assists.find((assist: { id: string }) => assist.id === "as5")).toMatchObject({
      status: "failed",
      error: "The chapter draft couldn’t be written. Your credits were returned."
    });
  });

  it("serializes each result field by field, leaving provenance behind", async () => {
    const app = await buildMobileApp();
    const { projectId, chapterId } = await seeded(app);
    const get = async (id: string) =>
      (await app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript/assists/${id}`, headers: AUTH })).json();

    const image = await get("as1");
    expect(image.assist.result).toEqual({ type: "image", url: `/assets/images/${projectId}/studio-image-as1.jpg`, alt: "The keeper" });
    expect(JSON.stringify(image)).not.toMatch(/model|provenance/i);
    expect((await get("as2")).assist.result).toEqual({
      type: "notes",
      notes: [{ quote: "The keeper", note: "Slow down here.", severity: "issue" }]
    });
    expect((await get("as3")).assist.result.notes).toEqual([{ quote: null, note: "Two names for the boat.", severity: "suggestion", chapterId }]);
    expect((await get("as7")).assist.result).toEqual({ type: "draft", markdown: "She opened the logbook." });
    expect((await app.inject({ method: "GET", url: `/api/mobile/projects/${projectId}/manuscript/assists/as6`, headers: AUTH })).statusCode).toBe(404);
  });

  it("dismisses and applies, and refuses to apply what is not ready", async () => {
    const app = await buildMobileApp();
    const { projectId } = await seeded(app);
    const post = (id: string, action: string) =>
      app.inject({ method: "POST", url: `/api/mobile/projects/${projectId}/manuscript/assists/${id}/${action}`, headers: AUTH });

    const dismissed = await post("as2", "dismiss");
    expect(dismissed.json().assist.status).toBe("dismissed");
    expect((await post("as2", "dismiss")).json().assist.status).toBe("dismissed");
    const applied = await post("as7", "applied");
    expect(applied.json().assist.status).toBe("applied");
    expect((await post("as7", "applied")).json().assist.status).toBe("applied");
    // Applied stays applied if the author then dismisses the card.
    expect((await post("as7", "dismiss")).json().assist.status).toBe("applied");

    const notReady = await post("as4", "applied");
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error.code).toBe("ASSIST_NOT_READY");
    expect((await post("missing", "dismiss")).statusCode).toBe(404);
  });
});
