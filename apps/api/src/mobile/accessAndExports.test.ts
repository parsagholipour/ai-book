import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { InsufficientCreditsError, ensureProjectExportEntitlementOrSpend } from "@book-maker/db/billing";
import { exportContentDigest } from "@book-maker/core";

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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
    expect(vi.mocked(ensureProjectExportEntitlementOrSpend)).toHaveBeenCalledWith({
      userId: "user-a",
      projectId: "project-a",
      idempotencyKey: "mobile:project:project-a:export-unlock"
    });
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
      byteSize: "%PDF-cacheable".length
    });
    expect(Date.parse(exports.pdf.updatedAt)).not.toBeNaN();
    // The EPUB was never compiled, so it carries the revision but no file facts.
    expect(exports.epub).toMatchObject({ available: false, revision: 7, byteSize: null, updatedAt: null });
    await app.close();
  });

  it("delivers the bytes even when an edit deletes the file while the unlock settles", async () => {
    // The unlock must never settle against nothing. An edit deletes the
    // compiled exports before queueing its recompile, so it can land in exactly
    // this window — and the old order (stat, charge, read) answered 404 with
    // the reader's credits already spent.
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-about-to-vanish");
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    const bookStorageDir = state.bookStorageDir ?? "";
    vi.mocked(ensureProjectExportEntitlementOrSpend).mockImplementationOnce(async () => {
      rmSync(join(bookStorageDir, "project-a", "book.pdf"));
      return undefined as never;
    });
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("%PDF-about-to-vanish");
    await app.close();
  });

  it("does not spend the export unlock when there is no file to hand back", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      contentRevision: 7
    });
    const app = await buildMobileApp();

    for (const format of ["pdf", "epub"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/mobile/projects/project-a/export/${format}`,
        headers: bearer("token-a")
      });
      expect(response.statusCode, format).toBe(404);
      expect(response.json().error.code, format).toBe("EXPORT_NOT_READY");
    }
    expect(vi.mocked(ensureProjectExportEntitlementOrSpend)).not.toHaveBeenCalled();
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
      JSON.parse(readFileSync(join(state.bookStorageDir!, "project-a", "book.epub.provenance.json"), "utf8"))
    ).toMatchObject({ revision: 7 });
    await app.close();
  });

  it("blocks mobile export downloads when export unlock credits are insufficient", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    writeProjectFile(state.bookStorageDir, "project-a", "book.pdf", "%PDF-mobile-owned");
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-a",
      title: "Owned Mobile Book",
      status: "COMPLETE",
      language: "en",
      currentPlanId: "plan-1",
      mediaSettings: {}
    });
    vi.mocked(ensureProjectExportEntitlementOrSpend).mockRejectedValueOnce(
      new InsufficientCreditsError({ requiredCredits: 150, availableCredits: 25, reservedCredits: 0 })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-a/export/pdf",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(402);
    expect(response.json().error).toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      requiredCredits: 150,
      availableCredits: 25
    });
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
