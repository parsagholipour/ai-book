import { seedObject } from "../testing/objectStorage.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());

import { EXPORT_FORMATS, loadConfig } from "@book-maker/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageContentType,
  mobileAssetFilenameFromPath,
  serializeExportSet,
  serializeImage,
  serializePlan
} from "./projectArtifactSerializers.js";
import type { MobileImageRecord } from "./dto.js";
import {
  approvedPlanRecord,
  mockBilling,
  resetMobileHarness
} from "./testing/mobileApiHarness.js";

let storageDir: string | null = null;

beforeEach(resetMobileHarness);
afterEach(async () => {
  if (storageDir) {
    await rm(storageDir, { recursive: true, force: true });
    storageDir = null;
  }
});

describe("project artifact serializers", () => {
  it("serializes plans and images without leaking artifact internals", () => {
    const plan = serializePlan(approvedPlanRecord() as never);
    const image = serializeImage({
      id: "asset-1",
      projectId: "project-1",
      pageId: "page-1",
      type: "ILLUSTRATION",
      path: "/assets/images/project-1/page-1.webp",
      metadata: { mimeType: "image/webp", provider: "hidden", model: "hidden" }
    }, "page_visual", "A useful diagram");

    expect(plan).toMatchObject({
      id: "plan-1",
      status: "approved",
      title: "The Race Between Rabbit and Turtle",
      chapters: [{ index: 1, title: "The Race", targetPages: 2 }]
    });
    expect(image).toEqual({
      id: "asset-1",
      role: "page_visual",
      url: expect.stringMatching(/^\/api\/mobile\/projects\/project-1\/assets\/asset-1\?v=[A-Za-z0-9_-]{12}$/),
      contentType: "image/webp",
      altText: "A useful diagram",
      pageId: "page-1",
      aiGenerated: true
    });
    expect(JSON.stringify({ plan, image })).not.toMatch(/provider|model|planningPackage|path/);
  });

  it("says a model drew a picture only where one did, so only those are offered for reporting", () => {
    const record = (metadata: unknown): MobileImageRecord => ({
      id: "cover-1",
      projectId: "project-1",
      pageId: null,
      type: "COVER",
      path: "/assets/images/project-1/cover.jpg",
      metadata
    });
    const drawn = (metadata: unknown) => serializeImage(record(metadata), "cover", "Cover")!.aiGenerated;
    expect(drawn({ coverArtSource: "design", coverDesignId: "moonlit-sea" })).toBe(false);
    expect(drawn({ source: "upload", costUsd: 0 })).toBe(false);
    expect(drawn({ coverArtSource: "ai" })).toBe(true);
    // A cover from before the field, and every page illustration, was drawn.
    expect(drawn({})).toBe(true);
    expect(drawn(null)).toBe(true);
  });

  describe("an image URL carries its version", () => {
    const cover: MobileImageRecord = {
      id: "cover-1",
      projectId: "project-1",
      pageId: null,
      type: "COVER",
      path: "http://localhost:4001/assets/images/project-1/cover.jpg",
      metadata: { coverArtSource: "design", coverDesignId: "moonlit-sea" }
    };
    const urlOf = (image: MobileImageRecord) => serializeImage(image, "cover", "Cover")!.url;

    it("moves when a redraw writes the same file under a new row", () => {
      // generateCover and every Studio cover change: deleteMany + create, one path.
      expect(urlOf({ ...cover, id: "cover-2" })).not.toBe(urlOf(cover));
    });

    it("moves when a replacement points the same row at a new file", () => {
      // A chat picture replacement keeps the row and swaps `path`; undo swaps it back.
      const page = { ...cover, type: "SCENE_ILLUSTRATION", pageId: "page-1", path: "/assets/images/project-1/page-1.jpg" };
      const replaced = { ...page, path: "/assets/images/project-1/page-1-op-1-uuid.jpg" };
      expect(urlOf(replaced)).not.toBe(urlOf(page));
      expect(urlOf({ ...replaced, path: page.path })).toBe(urlOf(page));
    });

    it("stays put for the same row and file, whatever its metadata says", () => {
      // A move or keeper rebind rewrites metadata without touching a byte; a
      // URL that moved with it would refetch the picture for nothing.
      expect(urlOf({ ...cover })).toBe(urlOf(cover));
      expect(urlOf({ ...cover, metadata: { coverArtSource: "design", keeperToken: "v2-x" } })).toBe(urlOf(cover));
    });

    it("keeps the asset route the URL names", () => {
      expect(new URL(urlOf(cover), "http://api.test").pathname).toBe("/api/mobile/projects/project-1/assets/cover-1");
    });
  });

  it("parses only this project's safe asset filenames and preserves MIME fallback behavior", () => {
    expect(mobileAssetFilenameFromPath("https://cdn.test/assets/images/project-1/page-1.webp", "project-1")).toBe("page-1.webp");
    expect(mobileAssetFilenameFromPath("https://cdn.test/assets/images/project-1/page%201.webp", "project-1")).toBeNull();
    expect(mobileAssetFilenameFromPath("/assets/images/project-2/page-1.webp", "project-1")).toBeNull();
    expect(mobileAssetFilenameFromPath("/assets/images/project-1/../project-2/page-1.webp", "project-1")).toBeNull();
    expect(imageContentType({ path: "/tmp/cover.JPG", metadata: {} })).toBe("image/jpeg");
    expect(imageContentType({ path: "/tmp/no-extension", metadata: { mimeType: "image/avif" } })).toBe("image/avif");
  });

  it("probes exports and reports every format free, reading no entitlement", async () => {
    storageDir = await mkdtemp(join(tmpdir(), "mobile-project-artifacts-"));
    seedObject("books/project-1/book.pdf", "pdf bytes");
    // No unlock row exists for this book, and none is needed: every finished
    // book downloads free since 2026-10-15.
    mockBilling.hasActiveProjectEntitlement.mockResolvedValue(false);
    const appConfig = { ...loadConfig(), BOOK_STORAGE_DIR: storageDir };

    const exports = await serializeExportSet("project-1", "A Book: Revised", appConfig, 7);

    expect(EXPORT_FORMATS.map((format) => exports[format].format)).toEqual([...EXPORT_FORMATS]);
    expect(mockBilling.hasActiveProjectEntitlement).not.toHaveBeenCalled();
    for (const format of EXPORT_FORMATS) {
      // The three fields installed apps still read before a download.
      expect(exports[format]).toMatchObject({ unlocked: true, creditsRequired: 0, planIncludesUnlock: false });
    }
    expect(exports.pdf).toMatchObject({
      format: "pdf",
      label: "PDF",
      available: true,
      unlocked: true,
      creditsRequired: 0,
      filename: "A-Book-Revised.pdf",
      revision: 7,
      byteSize: 9
    });
    expect(exports.epub).toMatchObject({
      format: "epub",
      label: "EPUB",
      available: false,
      unlocked: true,
      creditsRequired: 0,
      filename: "A-Book-Revised.epub",
      revision: 7,
      byteSize: null,
      updatedAt: null
    });
    expect(exports.docx).toMatchObject({
      format: "docx",
      label: "Word",
      available: false,
      unlocked: true,
      requiresSubscription: true,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      downloadUrl: "/api/mobile/projects/project-1/export/docx",
      filename: "A-Book-Revised.docx",
      revision: 7,
      byteSize: null
    });
    // Only the Word file is a plan perk; the app draws the lock from this field.
    expect(exports.pdf.requiresSubscription).toBe(false);
    expect(exports.epub.requiresSubscription).toBe(false);
  });
});
