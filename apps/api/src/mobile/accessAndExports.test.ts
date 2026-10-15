import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  InsufficientCreditsError,
  grantProjectEntitlement,
  hasActiveSubscriptionEntitlement,
  reserveCredits,
  spendCredits
} from "@book-maker/db/billing";
import { exportContentDigest } from "@book-maker/core";

import { testObjectStore, readObjectText } from "../testing/objectStorage.js";

import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  buildOperatorApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness,
  writeProjectFile
} from "./testing/mobileApiHarness.js";

/** Nothing a download may write: no charge, no hold, no entitlement row. */
function expectNothingSpent(): void {
  expect(vi.mocked(spendCredits)).not.toHaveBeenCalled();
  expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
  expect(vi.mocked(grantProjectEntitlement)).not.toHaveBeenCalled();
}

describe("mobile rate limits, exports and operator routes", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("rate limits repeated mobile generation actions", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValueOnce(projectRecord({ id: "project-1" }));
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ generationRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

    const first = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledOnce();
    await app.close();
  });

  it("does not rate limit mobile project reads after a plan generation action", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-1" && where.userId === "user-a" ? projectRecord({ id: "project-1", status: "PLANNING" }) : null
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ generationRateLimit: { maxAttempts: 1, windowMs: 60_000 } });

    const plan = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });
    const detail = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1",
      headers: bearer("token-a")
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/status",
      headers: bearer("token-a")
    });
    const repeatedPlan = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/plan",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(plan.statusCode).toBe(202);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project).toMatchObject({ id: "project-1", status: "planning" });
    expect(status.statusCode).toBe(200);
    expect(status.json().status.projectId).toBe("project-1");
    expect(repeatedPlan.statusCode).toBe(429);
    await app.close();
  });

  it("authorizes mobile PDF and EPUB downloads by project owner", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-mobile-owned");
    writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-mobile-owned");
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-a" && where.userId === "user-a"
        ? { id: "project-a", title: "Owned Mobile Book", language: "en", currentPlanId: null, mediaSettings: {} }
        : null
    );
    const app = await buildMobileApp();

    const ownPdf = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });
    const otherPdf = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-b")
    });
    const ownEpub = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-a")
    });
    const otherEpub = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-b")
    });

    expect(ownPdf.statusCode).toBe(200);
    expect(ownPdf.body).toBe("%PDF-mobile-owned");
    expect(otherPdf.statusCode).toBe(404);
    expect(otherPdf.json().error.code).toBe("PROJECT_NOT_FOUND");
    expect(ownEpub.statusCode).toBe(200);
    expect(ownEpub.body).toBe("epub-mobile-owned");
    expect(otherEpub.statusCode).toBe(404);
    expect(otherEpub.json().error.code).toBe("PROJECT_NOT_FOUND");
    // Every finished book downloads free (2026-10-15): nothing settles.
    expectNothingSpent();
    await app.close();
  });

  it("lets the owner read the PDF in the app without spending the export unlock", async () => {
    // A Studio book or an import has no generation charge to include the unlock,
    // and the reader used to download through the charging route — so opening
    // the book spent 150 credits without a word.
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-reader-copy");
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-a" && where.userId === "user-a"
        ? { id: "project-a", title: "Letters to My Daughter", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 3 }
        : null
    );
    const app = await buildMobileApp();

    const own = await app.inject({ method: "GET", url: "/api/mobile/projects/project-a/read/pdf", headers: bearer("token-a") });
    const other = await app.inject({ method: "GET", url: "/api/mobile/projects/project-a/read/pdf", headers: bearer("token-b") });

    expect(own.statusCode).toBe(200);
    expect(own.body).toBe("%PDF-reader-copy");
    expect(own.headers["content-disposition"]).toMatch(/^inline;/);
    expect(own.headers["x-export-content-digest"]).toBeTruthy();
    expect(other.statusCode).toBe(404);
    expectNothingSpent();
    await app.close();
  });

  it("answers a reader whose PDF is missing with the repair, not a charge", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a", title: "Owned Mobile Book", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7
    });
    const app = await buildMobileApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-a/read/pdf", headers: bearer("token-a") });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EXPORT_NOT_READY");
    expectNothingSpent();
    await app.close();
  });

  it("reports export size, mtime and content revision so the reader can cache the file", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-cacheable");
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({ id: "project-a", status: "COMPLETE", contentRevision: 7 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    const exports = response.json().project.exports;
    expect(exports.pdf).toMatchObject({
      available: true,
      revision: 7,
      byteSize: "%PDF-cacheable".length,
      readUrl: "/api/mobile/projects/project-a/read/pdf"
    });
    // The wire installed apps read before a download: every file is free.
    for (const format of ["pdf", "epub", "docx"]) {
      expect(exports[format], format).toMatchObject({ unlocked: true, creditsRequired: 0, planIncludesUnlock: false });
    }
    expect(exports.docx.requiresSubscription).toBe(true);
    // Only the PDF is read in the app; every other format is only ever taken out.
    expect(exports.epub.readUrl).toBeUndefined();
    expect(Date.parse(exports.pdf.updatedAt)).not.toBeNaN();
    // The EPUB was never compiled, so it carries the revision but no file facts.
    expect(exports.epub).toMatchObject({ available: false, revision: 7, byteSize: null, updatedAt: null });
    await app.close();
  });

  it("answers every format with the repair, never a charge, when there is no file to hand back", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    // A subscriber, so the Word route reaches the file read like the other two.
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    const app = await buildMobileApp();

    for (const format of ["pdf", "epub", "docx"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/mobile/projects/project-a/export/${format}`,
        headers: bearer("token-a")
      });
      expect(response.statusCode, format).toBe(404);
      expect(response.json().error.code, format).toBe("EXPORT_NOT_READY");
    }
    expectNothingSpent();
    await app.close();
  });

  it("names the compile that produced the bytes it sends, not the row's revision", async () => {
    // The reader files what it downloads under a revision — it caches it under
    // one, decides staleness against one and stamps its markup with one — and
    // the only thing that can say which compile answered is the response. Not
    // the project row: an edit takes the row to a new revision minutes before
    // the compile that publishes it, so a row read after the file describes a
    // book that is not on disk yet.
    mockAccessTokens({ "token-a": "user-a" });
    const bytes = "%PDF-published";
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", bytes);
    writeProjectFile(
      state.bookStorageDir,
      "project-a",
      "book.pdf.provenance.json",
      JSON.stringify({
        revision: 7,
        digest: exportContentDigest(Buffer.from(bytes)),
        byteSize: bytes.length,
        publishedAt: "2026-08-11T00:00:00.000Z"
      })
    );
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "EDITING",
      currentPlanId: "plan-1",
      contentRevision: 8
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(bytes);
    expect(response.headers["x-export-provenance"]).toBe("exact");
    expect(response.headers["x-export-content-revision"]).toBe("7");
    expect(response.headers["x-export-content-digest"]).toBe(exportContentDigest(Buffer.from(bytes)));
    await app.close();
  });

  it("refuses to name a revision when a same-length compile replaced the file", async () => {
    // The race this contract exists for, in the state it leaves on disk: the
    // record describes the book that was published, the file holds the book
    // that replaced it, and the two are the same length — a presentation
    // reprint, a re-applied edit or an undo all produce one. A size comparison
    // calls these identical and hands the reader a newer book under an older
    // revision. Nothing may be named here.
    mockAccessTokens({ "token-a": "user-a" });
    const published = "%PDF-edition-one";
    const replacement = "%PDF-edition-two";
    expect(replacement.length, "same length is the whole point").toBe(published.length);
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", replacement);
    writeProjectFile(
      state.bookStorageDir,
      "project-a",
      "book.pdf.provenance.json",
      JSON.stringify({
        revision: 7,
        digest: exportContentDigest(Buffer.from(published)),
        byteSize: published.length,
        publishedAt: "2026-08-11T00:00:00.000Z"
      })
    );
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

    // The book still downloads: it is whole and it is paid for.
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(replacement);
    expect(response.headers["x-export-provenance"]).toBe("mismatch");
    expect(response.headers["x-export-content-revision"]).toBeUndefined();
    expect(response.headers["x-export-content-digest"]).toBe(exportContentDigest(Buffer.from(replacement)));
    await app.close();
  });

  it("backfills a pre-provenance export without recompiling it", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-legacy");
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    // The compile that published these legacy bytes: the heal stamps a revision
    // onto sidecar-less bytes only behind proof that a compile really COMPLETED
    // for it — without this, a failed presentation recompile's leftover file
    // would be labelled with a revision it does not contain.
    mockPrisma.generationJob.findFirst.mockResolvedValue({ id: "compile-legacy" });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/epub",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-export-provenance"]).toBe("exact");
    expect(response.headers["x-export-content-revision"]).toBe("7");
    expect(
      JSON.parse(readObjectText("books/project-a/book.epub.provenance.json"))
    ).toMatchObject({ revision: 7 });
    await app.close();
  });

  it.each([
    ["a generated book", { mobile: { bookType: "short_story" } }],
    ["a Studio book", { mobile: { studio: { layout: "flow", kind: "story", createdAt: "2026-10-01T00:00:00.000Z" } } }],
    ["an import", { mobile: { import: { format: "docx" } } }],
    ["a book from before tiers and plans", {}]
  ])("downloads %s free for a reader with no credits and no plan, and never answers 402", async (_kind, mediaSettings) => {
    // The per-book 150-credit unlock used to settle here, and a reader short of
    // it got 402 INSUFFICIENT_CREDITS. A book made while free, an author's own
    // book and an old one are all the reader's file now (2026-10-15).
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-mobile-owned");
    writeProjectFile(state.bookStorageDir, "project-a", "book.epub", "epub-mobile-owned");
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      language: "en",
      currentPlanId: "plan-1",
      contentRevision: 7,
      mediaSettings
    });
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    // Were anything to try to charge, it would be refused.
    const broke = new InsufficientCreditsError({ requiredCredits: 150, availableCredits: 0, reservedCredits: 0 });
    vi.mocked(spendCredits).mockRejectedValue(broke);
    vi.mocked(reserveCredits).mockRejectedValue(broke);
    const app = await buildMobileApp();

    for (const [format, body] of [["pdf", "%PDF-mobile-owned"], ["epub", "epub-mobile-owned"]] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/api/mobile/projects/project-a/export/${format}`,
        headers: bearer("token-a")
      });
      expect(response.statusCode, format).toBe(200);
      expect(response.body, format).toBe(body);
    }
    expectNothingSpent();
    await app.close();
  });

  it("refuses the Word download to a free account before reading or charging anything", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.docx", "PK-word-owned");
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    // `resetAllMocks` leaves the plan check answering undefined; say "free" out loud.
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(false);
    const app = await buildMobileApp();

    const withFile = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/docx",
      headers: bearer("token-a")
    });
    expect(withFile.statusCode).toBe(403);
    expect(withFile.json().error).toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
      message: "Word export is part of the Creator plan."
    });

    // With no file at all the answer is the same, and no repair is queued for a
    // file this reader could not download.
    await testObjectStore.delete("books/project-a/book.docx");
    const withoutFile = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/docx",
      headers: bearer("token-a")
    });
    expect(withoutFile.statusCode).toBe(403);
    expectNothingSpent();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    // The other two formats never ask about the plan.
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-free");
    const pdf = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });
    expect(pdf.statusCode).toBe(200);
    await app.close();
  });

  it("sends the Word file to a subscriber, owner-scoped, and charges nothing", async () => {
    mockAccessTokens({ "token-a": "user-a", "token-b": "user-b" });
    const bytes = "PK-word-published";
    writeProjectFile(state.bookStorageDir, "project-a", "book.docx", bytes);
    writeProjectFile(
      state.bookStorageDir,
      "project-a",
      "book.docx.provenance.json",
      JSON.stringify({ revision: 7, digest: exportContentDigest(Buffer.from(bytes)), byteSize: bytes.length })
    );
    mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { id?: string; userId?: string } }) =>
      where.id === "project-a" && where.userId === "user-a"
        ? { id: "project-a", title: "Owned Mobile Book", status: "COMPLETE", currentPlanId: "plan-1", contentRevision: 7 }
        : null
    );
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    const app = await buildMobileApp();

    const own = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/docx",
      headers: bearer("token-a")
    });
    const other = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/docx",
      headers: bearer("token-b")
    });

    expect(own.statusCode).toBe(200);
    expect(own.body).toBe(bytes);
    expect(own.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(own.headers["content-disposition"]).toBe('attachment; filename="Owned-Mobile-Book.docx"');
    expect(own.headers["x-export-provenance"]).toBe("exact");
    expect(own.headers["x-export-content-revision"]).toBe("7");
    // The plan gates the format; it never buys an unlock (2026-10-15).
    expectNothingSpent();
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("PROJECT_NOT_FOUND");
    await app.close();
  });

  it("queues a Word repair for a subscriber whose file is missing", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    mockPrisma.generationJob.findFirst.mockResolvedValue(null);
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-repair" }));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/docx",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("EXPORT_NOT_READY");
    expect(vi.mocked(enqueueGenerationJob)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "COMPILE_EXPORT",
        dedupeKey: expect.stringContaining("repair-docx-7-"),
        payload: expect.objectContaining({
          exportRepairFormat: "docx",
          detachedFromProjectLifecycle: true,
          skipFinalReview: true
        })
      })
    );
    expectNothingSpent();
    await app.close();
  });

  it("keeps operator project creation advanced controls available on /api/projects", async () => {
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-story" });
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      projectRecord({
        id: "operator-project",
        title: data.title,
        prompt: data.prompt,
        category: data.category,
        targetPages: data.targetPages,
        mediaSettings: data.mediaSettings
      })
    );
    const app = await buildOperatorApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        title: "Operator Model Test",
        prompt: "A practical operator-created book with enough detail to pass validation.",
        category: "STORY",
        targetPages: 12,
        complexity: 7,
        temperature: 0.4,
        language: "es",
        mediaSettings: {
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "auto",
          finalReview: true,
          generationStrategy: "chaptered-sequential",
          textModel: { provider: "gemini", model: "gemini-3.5-flash" },
          toneProfile: "neutral"
        }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "local-admin",
          temperature: 0.4,
          mediaSettings: expect.objectContaining({
            generationStrategy: "chaptered-sequential",
            textModel: { provider: "gemini", model: "gemini-3.5-flash" }
          })
        })
      })
    );
    await app.close();
  });

});
