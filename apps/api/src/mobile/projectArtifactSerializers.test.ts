import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());

import { loadConfig } from "@book-maker/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageContentType,
  mobileAssetFilenameFromPath,
  serializeExportSet,
  serializeImage,
  serializePlan
} from "./projectArtifactSerializers.js";
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
      url: "/api/mobile/projects/project-1/assets/asset-1",
      contentType: "image/webp",
      altText: "A useful diagram",
      pageId: "page-1"
    });
    expect(JSON.stringify({ plan, image })).not.toMatch(/provider|model|planningPackage|path/);
  });

  it("parses only this project's safe asset filenames and preserves MIME fallback behavior", () => {
    expect(mobileAssetFilenameFromPath("https://cdn.test/assets/images/project-1/page-1.webp", "project-1")).toBe("page-1.webp");
    expect(mobileAssetFilenameFromPath("https://cdn.test/assets/images/project-1/page%201.webp", "project-1")).toBeNull();
    expect(mobileAssetFilenameFromPath("/assets/images/project-2/page-1.webp", "project-1")).toBeNull();
    expect(mobileAssetFilenameFromPath("/assets/images/project-1/../project-2/page-1.webp", "project-1")).toBeNull();
    expect(imageContentType({ path: "/tmp/cover.JPG", metadata: {} })).toBe("image/jpeg");
    expect(imageContentType({ path: "/tmp/no-extension", metadata: { mimeType: "image/avif" } })).toBe("image/avif");
  });

  it("probes exports and checks entitlement once while preserving both DTOs", async () => {
    storageDir = await mkdtemp(join(tmpdir(), "mobile-project-artifacts-"));
    const projectDir = join(storageDir, "project-1");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "book.pdf"), "pdf bytes");
    mockBilling.hasActiveProjectEntitlement.mockResolvedValue(true);
    const appConfig = { ...loadConfig(), BOOK_STORAGE_DIR: storageDir };

    const exports = await serializeExportSet("project-1", "A Book: Revised", appConfig, "user-a", 7);

    expect(mockBilling.hasActiveProjectEntitlement).toHaveBeenCalledTimes(1);
    expect(mockBilling.hasActiveProjectEntitlement).toHaveBeenCalledWith({
      userId: "user-a",
      projectId: "project-1",
      type: "EXPORT_UNLOCK"
    });
    expect(exports.pdf).toMatchObject({
      format: "pdf",
      available: true,
      unlocked: true,
      creditsRequired: 0,
      filename: "A-Book-Revised.pdf",
      revision: 7,
      byteSize: 9
    });
    expect(exports.epub).toMatchObject({
      format: "epub",
      available: false,
      unlocked: true,
      creditsRequired: 0,
      filename: "A-Book-Revised.epub",
      revision: 7,
      byteSize: null,
      updatedAt: null
    });
  });
});
