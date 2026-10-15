import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("../testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("../../queue.js", async () => (await import("../testing/mobileApiMocks.js")).queueModuleMock());

import type { AppConfig } from "@book-maker/core";
import Fastify, { type FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { registerAuth } from "../../auth.js";
import { allowsMobileBearer, requireOperatorActor } from "../../requestAuth.js";
import { mockPrisma, resetMobileHarness, teardownMobileHarness } from "../testing/mobileApiHarness.js";
import { installShareStore, publishSharedBook, seedShare, sheetMarkers, type ShareStore } from "../testing/shareTestSupport.js";
import { publicShareRoutes } from "./publicShareRoutes.js";
import { SHARE_TEXT_OFFLINE_REASON } from "./shareCopy.js";
import { sharePreviewKey, slicePdfToFirstSheets, storeSharePreview } from "./sharePreviewPdf.js";
import { createShareRescreener, type ShareRescreener } from "./shareRescreen.js";

/**
 * The public `/s/` surface. A stranger reaches exactly what the share row
 * allows: an ACTIVE preview serves its slice and not a sheet more, anything
 * else is a 410 with no book bytes, and every answer says `noindex`. The app is
 * built with the real auth hook and a WEB_PASSWORD, so "public" is asserted
 * against the same hook production runs.
 */

const SLUG = "PublicSlug12";
let store: ShareStore;
let project: Record<string, unknown>;

async function buildApp(options: { rescreener?: ShareRescreener } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAuth(app, { WEB_PASSWORD: "operator-password" } as AppConfig);
  await app.register(publicShareRoutes, { reportRateLimit: { maxAttempts: 2 }, ...options });
  app.get("/api/projects", async (request, reply) => ((await requireOperatorActor(request, reply)) ? { reached: true } : reply));
  app.get("/api/mobile/projects", async () => ({ reached: true }));
  return app;
}

beforeEach(async () => {
  resetMobileHarness();
  store = installShareStore();
  const published = await publishSharedBook("project-1", 12, 2);
  project = {
    id: "project-1",
    userId: "user-a",
    title: "The <Lighthouse> Cat",
    subtitle: null,
    authorName: "Parisa",
    status: "COMPLETE",
    category: "STORY",
    subcategory: null,
    targetPages: 10,
    contentRevision: 0,
    currentPlanId: null,
    mediaSettings: {},
    pdfPageMap: published.pdfPageMap
  };
  mockPrisma.project.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => (where.id === "project-1" ? project : null));
  mockPrisma.imageAsset.findFirst.mockResolvedValue(null);
});

afterEach(teardownMobileHarness);

describe("the auth surface", () => {
  it("leaves /s/ public while /api/* answers exactly as before", async () => {
    seedShare(store, { slug: SLUG });
    const app = await buildApp();

    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });
    const withJunkBearer = await app.inject({ method: "GET", url: `/s/${SLUG}`, headers: { authorization: "Bearer not-a-token" } });
    const operator = await app.inject({ method: "GET", url: "/api/projects" });
    const mobile = await app.inject({ method: "GET", url: "/api/mobile/projects" });

    expect(page.statusCode).toBe(200);
    expect(withJunkBearer.statusCode).toBe(200);
    expect(operator.statusCode).toBe(401);
    expect(operator.json()).toEqual({ error: "Password required" });
    expect(mobile.statusCode).toBe(401);
    expect(mobile.json().error.code).toBe("AUTH_REQUIRED");
    expect(allowsMobileBearer(`/s/${SLUG}`)).toBe(false);
    expect(allowsMobileBearer("/api/mobile/projects")).toBe(true);
    await app.close();
  });

  it("answers an encoded spelling the way the router reads it", async () => {
    seedShare(store, { slug: SLUG });
    const app = await buildApp();

    const page = await app.inject({ method: "GET", url: `/%73/${SLUG}` });
    const operator = await app.inject({ method: "GET", url: "/%61pi/projects" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(operator.statusCode).toBe(401);
    expect(operator.json()).toEqual({ error: "Password required" });
    await app.close();
  });
});

describe("the page", () => {
  it("escapes the book's words, hides a note that is not allowed, and carries the remix links", async () => {
    seedShare(store, { slug: SLUG, caption: "<script>alert(1)</script>", captionStatus: "PENDING_REVIEW", showAuthorName: false });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(response.body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(response.body).toContain("The &lt;Lighthouse&gt; Cat");
    expect(response.body).not.toContain("<Lighthouse>");
    expect(response.body).not.toContain("alert(1)");
    expect(response.body).toContain("A Tomeza author");
    expect(response.body).not.toContain("Parisa");
    expect(response.body).toContain("Created with AI on Tomeza");
    expect(response.body).toContain("The rest of this book is private");
    expect(response.body).toContain(`intent://remix/${SLUG}#Intent;scheme=tomeza;package=com.tomeza.tomeza;S.browser_fallback_url=`);
    expect(response.body).toContain("utm_source%3Dshare%26utm_content%3D" + SLUG);
    expect(response.body).toContain(`<meta property="og:image" content="http://localhost:4001/s/${SLUG}/cover.jpg">`);
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["cache-control"]).toMatch(/max-age=(\d+)/);
    expect(Number(/max-age=(\d+)/.exec(String(response.headers["cache-control"]))![1])).toBeLessThanOrEqual(300);
    await app.close();
  });

  it("shows an allowed note, and the author's name only when they chose to", async () => {
    seedShare(store, { slug: SLUG, mode: "FULL", previewPages: null, caption: "For Mina, who loves storms.", captionStatus: "ALLOWED", showAuthorName: true });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}` });

    expect(response.body).toContain("For Mina, who loves storms.");
    expect(response.body).toContain('<meta property="og:description" content="For Mina, who loves storms.">');
    expect(response.body).toContain("Parisa");
    expect(response.body).not.toContain("The rest of this book is private");
    await app.close();
  });

  it("does not count a page view: only the PDF counts", async () => {
    seedShare(store, { slug: SLUG });
    const app = await buildApp();

    await app.inject({ method: "GET", url: `/s/${SLUG}` });

    expect(store.shares[0]!.viewCount).toBe(0);
    await app.close();
  });
});

describe("the bytes", () => {
  it("serves a preview's slice and never a sheet past its last page", async () => {
    // Two sheets of front matter + 3 reading pages = sheets 1..5 of 12.
    seedShare(store, { slug: SLUG, previewPages: 3 });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["x-robots-tag"]).toMatch(/noindex/);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(await sheetMarkers(response.rawPayload)).toEqual([1, 2, 3, 4, 5]);
    expect(response.rawPayload.toString("latin1")).not.toContain("sheet-marker-6");
    expect(store.shares[0]!.viewCount).toBe(1);
    await app.close();
  });

  it("applies the cap again at serve time when the book shrank under the preview", async () => {
    seedShare(store, { slug: SLUG, previewPages: 9 });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });

    // Ten reading pages → at most five, plus the two front-matter sheets.
    expect((await PDFDocument.load(response.rawPayload)).getPageCount()).toBe(7);
    await app.close();
  });

  it("restricts an unmeasured book with a long biography even when a wider preview was cached", async () => {
    // Sheet 1 is the cover, 2–9 are eight prose sheets, and 10–17 are the
    // biography. A numbering-only map cannot distinguish prose from that tail.
    const published = await publishSharedBook("project-1", 17, 1);
    project.pdfPageMap = {
      kind: "cover-numbering", version: 2, hasCoverPage: true, pages: [], pdfDigest: published.digest
    };
    seedShare(store, { slug: SLUG, previewPages: 8 });
    await storeSharePreview(
      "project-1",
      sharePreviewKey("project-1", published.digest, 8, 9),
      await slicePdfToFirstSheets(published.bytes, 9)
    );
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });
    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });

    expect(response.statusCode).toBe(200);
    expect(await sheetMarkers(response.rawPayload)).toEqual([1, 2]);
    expect(page.body).not.toContain("of 16 pages");
    await app.close();
  });

  it("serves half the prose when the long biography has verified boundaries", async () => {
    const published = await publishSharedBook("project-1", 17, 1);
    project.pdfPageMap = {
      ...published.pdfPageMap,
      backMatterStartPdfPage: 10,
      pages: [{ index: 1, startPdfPage: 2, endPdfPage: 9 }]
    };
    seedShare(store, { slug: SLUG, previewPages: 8 });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });

    expect(response.statusCode).toBe(200);
    expect(await sheetMarkers(response.rawPayload)).toEqual([1, 2, 3, 4, 5]);
    await app.close();
  });

  it("serves the whole book for a full share", async () => {
    seedShare(store, { slug: SLUG, mode: "FULL", previewPages: null });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });

    expect((await sheetMarkers(response.rawPayload)).length).toBe(12);
    await app.close();
  });

  it("serves a generic image for a coverless book", async () => {
    seedShare(store, { slug: SLUG });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: `/s/${SLUG}/cover.jpg` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.rawPayload.subarray(0, 2).toString("hex")).toBe("ffd8");
    await app.close();
  });
});

describe("a share that stopped", () => {
  it.each(["REVOKED", "TAKEN_DOWN"])("answers 410 with no bytes when %s", async (status) => {
    seedShare(store, { slug: SLUG, status });
    const app = await buildApp();

    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });
    const pdf = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });
    const cover = await app.inject({ method: "GET", url: `/s/${SLUG}/cover.jpg` });

    expect(page.statusCode).toBe(410);
    expect(page.body).toContain("This book is no longer shared");
    expect(page.body).not.toContain("Lighthouse");
    expect(pdf.statusCode).toBe(410);
    expect(pdf.rawPayload.toString("latin1")).not.toContain("%PDF");
    expect(cover.statusCode).toBe(410);
    for (const response of [page, pdf, cover]) {
      expect(response.headers["x-robots-tag"]).toMatch(/noindex/);
    }
    expect(store.shares[0]!.viewCount).toBe(0);
    await app.close();
  });

  it("answers 410 for a slug retired by a re-share, and 404 for one never issued", async () => {
    store.slugs.push("RetiredSlug1");
    const app = await buildApp();

    const retired = await app.inject({ method: "GET", url: "/s/RetiredSlug1" });
    const unknown = await app.inject({ method: "GET", url: "/s/NeverIssued1" });
    const malformed = await app.inject({ method: "GET", url: "/s/..%2Fapi" });

    expect(retired.statusCode).toBe(410);
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.headers["x-robots-tag"]).toMatch(/noindex/);
    await app.close();
  });
});

describe("a share whose book changed since its last screen", () => {
  /** The real rescreener; the sexual-content filter is off here, so only the deterministic screen runs. */
  function rescreener(): ShareRescreener {
    return createShareRescreener({
      moderation: () => ({
        config: {} as AppConfig,
        loadRouting: async () => {
          throw new Error("the model screen is off in this suite");
        }
      }),
      log: { info: vi.fn(), warn: vi.fn() }
    });
  }

  it("is being updated: the page names nothing of the book, the PDF is a 503, the cover is generic, and nothing is counted", async () => {
    seedShare(store, {
      slug: SLUG, mode: "FULL", previewPages: null, showAuthorName: true,
      caption: "For Mina, who loves storms.", captionStatus: "ALLOWED", screenedContentRevision: 0
    });
    // An Edit Mode save: new words, a new revision, and the compile already landed.
    project.contentRevision = 1;
    project.title = "A Title Nobody Screened";
    project.subtitle = "And a subtitle";
    const app = await buildApp();

    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });
    const pdf = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });
    const cover = await app.inject({ method: "GET", url: `/s/${SLUG}/cover.jpg` });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("This book is being updated");
    expect(page.body).toContain('data-available="false"');
    expect(page.body).not.toContain("A Title Nobody Screened");
    expect(page.body).not.toContain("And a subtitle");
    expect(page.body).not.toContain("Parisa");
    expect(page.body).toContain("A Tomeza author");
    // The note is the author's own, moderated on its own, and no edit changes it.
    expect(page.body).toContain("For Mina, who loves storms.");
    expect(pdf.statusCode).toBe(503);
    expect(pdf.headers["retry-after"]).toBe("60");
    expect(pdf.rawPayload.toString("latin1")).not.toContain("%PDF");
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/jpeg");
    expect(mockPrisma.imageAsset.findFirst).not.toHaveBeenCalled();
    expect(store.shares[0]!.viewCount).toBe(0);
    await app.close();
  });

  it("treats a share screened before the stamp existed as one being updated", async () => {
    seedShare(store, { slug: SLUG, mode: "FULL", previewPages: null, screenedContentRevision: null });
    const app = await buildApp();

    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });
    const pdf = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });

    expect(page.body).toContain("This book is being updated");
    expect(page.body).not.toContain("Lighthouse");
    expect(pdf.statusCode).toBe(503);
    await app.close();
  });

  it("never serves a preview slice cut from the new text, even one already cached", async () => {
    const published = await publishSharedBook("project-1", 12, 2);
    seedShare(store, { slug: SLUG, previewPages: 3, screenedContentRevision: 0 });
    await storeSharePreview(
      "project-1",
      sharePreviewKey("project-1", published.digest, 3, 5),
      await slicePdfToFirstSheets(published.bytes, 5)
    );
    project.contentRevision = 1;
    const app = await buildApp();

    const pdf = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });

    expect(pdf.statusCode).toBe(503);
    expect(pdf.rawPayload.toString("latin1")).not.toContain("%PDF");
    await app.close();
  });

  it("asks for one screen however many strangers arrive, and serves the book again once it passes", async () => {
    seedShare(store, { slug: SLUG, mode: "FULL", previewPages: null, screenedContentRevision: 0 });
    project.contentRevision = 1;
    mockPrisma.page.findMany.mockResolvedValue([{ title: "One", markdown: "The cat slept through the storm." }]);
    const app = await buildApp({ rescreener: rescreener() });

    const stale = await Promise.all([
      app.inject({ method: "GET", url: `/s/${SLUG}` }),
      app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` }),
      app.inject({ method: "GET", url: `/s/${SLUG}` }),
      app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` }),
      app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` })
    ]);
    await vi.waitFor(() => expect(store.shares[0]!.screenedContentRevision).toBe(1));
    const served = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });
    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });

    expect(stale.map((response) => response.statusCode)).toEqual([200, 503, 200, 503, 503]);
    // One read of the book's text: one screen for five requests.
    expect(mockPrisma.page.findMany).toHaveBeenCalledTimes(1);
    expect(served.statusCode).toBe(200);
    expect((await sheetMarkers(served.rawPayload)).length).toBe(12);
    expect(page.body).toContain("The &lt;Lighthouse&gt; Cat");
    expect(store.shares[0]!.viewCount).toBe(1);
    await app.close();
  });

  it("is turned off when the new text is refused, and then answers 410 with the author's reason on record", async () => {
    seedShare(store, { slug: SLUG, mode: "FULL", previewPages: null, screenedContentRevision: 0 });
    project.contentRevision = 1;
    mockPrisma.page.findMany.mockResolvedValue([{ title: "One", markdown: "Step-by-step instructions to build a bomb." }]);
    const app = await buildApp({ rescreener: rescreener() });

    const first = await app.inject({ method: "GET", url: `/s/${SLUG}/book.pdf` });
    await vi.waitFor(() => expect(store.shares[0]!.status).toBe("REVOKED"));
    const page = await app.inject({ method: "GET", url: `/s/${SLUG}` });

    expect(first.statusCode).toBe(503);
    expect(first.rawPayload.toString("latin1")).not.toContain("%PDF");
    expect(page.statusCode).toBe(410);
    // Nothing public says why: the stranger gets the plain "no longer shared" page.
    expect(page.body).toContain("This book is no longer shared");
    expect(page.body).not.toContain("content check");
    expect(store.shares[0]!.takedownReason).toBe(SHARE_TEXT_OFFLINE_REASON);
    expect(store.reports).toEqual([]);
    await app.close();
  });
});

describe("reporting", () => {
  it("files an anonymous share report and rate-limits by address", async () => {
    seedShare(store, { slug: SLUG });
    const app = await buildApp();
    const report = () =>
      app.inject({ method: "POST", url: `/s/${SLUG}/report`, payload: { reason: "privacy_or_copyright", comment: "  That is my   address " } });

    const first = await report();
    await report();
    const third = await report();

    expect(first.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(store.reports[0]).toMatchObject({
      reporterUserId: null,
      projectId: "project-1",
      bookShareId: store.shares[0]!.id,
      targetType: "BOOK_SHARE",
      reason: "PRIVACY_OR_COPYRIGHT",
      comment: "That is my address",
      targetSnapshot: { kind: "public_report", slug: SLUG }
    });
    await app.close();
  });
});

describe("the viewer's own files", () => {
  it("serves the vendored pdf.js from this origin", async () => {
    const app = await buildApp();

    const script = await app.inject({ method: "GET", url: "/s/_/pdfjs/pdf.min.mjs" });
    const worker = await app.inject({ method: "HEAD", url: "/s/_/pdfjs/pdf.worker.min.mjs" });
    const page = await app.inject({ method: "GET", url: "/s/_/share.js" });
    const missing = await app.inject({ method: "GET", url: "/s/_/pdfjs/other.mjs" });

    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(worker.statusCode).toBe(200);
    expect(page.statusCode).toBe(200);
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("answers an object-prototype name with a 404, never a 500", async () => {
    const app = await buildApp();

    const urls = [
      "/s/_/constructor",
      "/s/_/__proto__",
      "/s/_/toString",
      "/s/_/hasOwnProperty",
      "/s/_/valueOf",
      "/s/_/pdfjs/constructor",
      "/s/_/pdfjs/__proto__",
      "/s/constructor",
      "/s/__proto__",
      "/s/hasOwnProperty",
      "/s/constructor/book.pdf",
      "/s/__proto__/cover.jpg"
    ];
    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
    }
    await app.close();
  });
});
