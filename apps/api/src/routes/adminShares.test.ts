import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("../mobile/testing/mobileApiMocks.js")).dbModuleMock());

import Fastify, { type FastifyInstance } from "fastify";
import { mockPrisma, resetMobileHarness, teardownMobileHarness } from "../mobile/testing/mobileApiHarness.js";
import { installShareStore, seedShare, type ShareStore } from "../mobile/testing/shareTestSupport.js";
import { registerAuth } from "../auth.js";
import { adminShareRoutes } from "./adminShares.js";

/** The operator's four decisions on a share, and the reports each one settles. */

let store: ShareStore;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Password auth off, as in local development: the hook is what makes the operator.
  await registerAuth(app, { WEB_PASSWORD: "" } as never);
  await app.register(adminShareRoutes);
  return app;
}

function act(app: FastifyInstance, shareId: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/admin/shares/${shareId}/moderation`, payload });
}

beforeEach(() => {
  resetMobileHarness();
  store = installShareStore();
  mockPrisma.bookShare.findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const row = store.shares.find((share) => share.id === where.id || share.slug === where.slug || share.projectId === where.projectId);
    return row ? { ...row } : null;
  });
});

afterEach(teardownMobileHarness);

describe("admin share moderation", () => {
  it("approves a held note and settles the system review", async () => {
    const share = seedShare(store, { caption: "For Mina.", captionStatus: "PENDING_REVIEW", captionVerdict: { verdict: "undecided", reason: "no_route" } });
    store.reports.push({ id: "report-1", bookShareId: share.id, reporterUserId: null, status: "PENDING", targetSnapshot: { kind: "caption_review" } });
    const app = await buildApp();

    const response = await act(app, share.id, { action: "approve_caption", reportId: "report-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().share).toMatchObject({ captionStatus: "allowed", status: "active" });
    expect(store.shares[0]!.captionVerdict).toMatchObject({ verdict: "undecided", operator: { action: "approve_caption", reviewerUserId: "local-admin" } });
    expect(store.reports[0]).toMatchObject({ status: "ACTIONED", reviewerUserId: "local-admin" });
    await app.close();
  });

  it("approving the note also closes the held book text the share was filed under", async () => {
    const share = seedShare(store, { caption: "For Mina.", captionStatus: "PENDING_REVIEW" });
    store.reports.push(
      { id: "report-text", bookShareId: share.id, reporterUserId: null, status: "PENDING", targetSnapshot: { kind: "book_text_review" } },
      { id: "report-reader", bookShareId: share.id, reporterUserId: null, status: "PENDING", targetSnapshot: { kind: "public_report" } }
    );
    const app = await buildApp();

    const response = await act(app, share.id, { action: "approve_caption", reportId: "report-text" });

    expect(response.statusCode).toBe(200);
    expect(store.reports.map((report) => [report.id, report.status])).toEqual([
      ["report-text", "ACTIONED"],
      // A stranger's report is not answered by approving the note.
      ["report-reader", "PENDING"]
    ]);
    await app.close();
  });

  it("approves a held book text on a share with no note, and refuses when nothing is held", async () => {
    const share = seedShare(store);
    store.reports.push({ id: "report-text", bookShareId: share.id, reporterUserId: null, status: "PENDING", targetSnapshot: { kind: "book_text_review" } });
    const app = await buildApp();

    const approved = await act(app, share.id, { action: "approve_book_text" });
    const again = await act(app, share.id, { action: "approve_book_text" });

    expect(approved.statusCode).toBe(200);
    expect(approved.json().share).toMatchObject({ status: "active", captionStatus: "none" });
    expect(store.reports[0]).toMatchObject({ status: "ACTIONED", reviewerUserId: "local-admin", reviewNotes: "approve_book_text" });
    expect(mockPrisma.bookShare.update).not.toHaveBeenCalled();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("NO_TEXT_REVIEW");
    await app.close();
  });

  it("removing the note leaves the held book text open", async () => {
    const share = seedShare(store, { caption: "Buy followers", captionStatus: "PENDING_REVIEW" });
    store.reports.push(
      { id: "report-note", bookShareId: share.id, reporterUserId: null, status: "PENDING", targetSnapshot: { kind: "caption_review" } },
      { id: "report-text", bookShareId: share.id, reporterUserId: null, status: "PENDING", targetSnapshot: { kind: "book_text_review" } }
    );
    const app = await buildApp();

    await act(app, share.id, { action: "remove_caption" });

    expect(store.reports.map((report) => report.status)).toEqual(["ACTIONED", "PENDING"]);
    await app.close();
  });

  it("removes a note without touching the share", async () => {
    const share = seedShare(store, { caption: "Buy followers", captionStatus: "ALLOWED" });
    const app = await buildApp();

    const response = await act(app, share.id, { action: "remove_caption" });

    expect(response.json().share).toMatchObject({ captionStatus: "removed", status: "active", caption: "Buy followers" });
    await app.close();
  });

  it("takes a share down only with a reason the author will see", async () => {
    const share = seedShare(store);
    const app = await buildApp();

    const bare = await act(app, share.id, { action: "take_down" });
    const done = await act(app, share.id, { action: "take_down", reason: "Contains another author's text." });

    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe("REASON_REQUIRED");
    expect(done.json().share).toMatchObject({ status: "taken_down", takedownReason: "Contains another author's text." });
    await app.close();
  });

  it("refuses a caption decision on a share with no note", async () => {
    const share = seedShare(store);
    const app = await buildApp();

    const response = await act(app, share.id, { action: "approve_caption" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NO_CAPTION");
    await app.close();
  });
});
