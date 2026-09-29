import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", () => ({ prisma: {} }));

import {
  addStudioImageReferences,
  isStudioImageReferenced,
  isSweptStudioImage,
  loadStudioImageReferences
} from "./studioImageReferences.js";
import { fakeSweepDb } from "./testing/studioImageSweepDb.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const GRACE = 30 * DAY;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function refs(text: string, projectId = "p1"): string[] {
  const into = new Set<string>();
  addStudioImageReferences(text, projectId, into);
  return [...into].sort();
}

describe("addStudioImageReferences", () => {
  it("reads the filename out of every shape a picture is written in", () => {
    expect(refs("![A lamp](/assets/images/p1/upload-1.jpg)")).toEqual(["upload-1.jpg"]);
    expect(refs("![x](https://api.example.com/api/assets/images/p1/cover-upload-2.jpg \"t\")")).toEqual([
      "cover-upload-2.jpg"
    ]);
    expect(refs('<img src="/assets/images/p1/upload-6.jpg" alt="">')).toEqual(["upload-6.jpg"]);
    expect(refs("object://images/p1/studio-image-a1.png")).toEqual(["studio-image-a1.png"]);
    expect(refs('{"previousAssets":[{"path":"/assets/images/p1/upload-7.webp"}]}')).toEqual(["upload-7.webp"]);
  });

  it("stops at a query string or fragment", () => {
    expect(refs("![x](/assets/images/p1/upload-3.jpg?v=abc)")).toEqual(["upload-3.jpg"]);
    expect(refs("![x](/assets/images/p1/upload-3.jpg#frag)")).toEqual(["upload-3.jpg"]);
  });

  it("URL-decodes both segments before comparing", () => {
    expect(refs("![x](/assets/images/p1/upload%2D4.jpg)")).toEqual(["upload-4.jpg"]);
    expect(refs("![x](/assets/images/%70%31/upload-4.jpg)")).toEqual(["upload-4.jpg"]);
  });

  it("ignores another project's URL, even one that shares a prefix", () => {
    expect(refs("![x](/assets/images/p2/upload-5.jpg)")).toEqual([]);
    expect(refs("![x](/assets/images/p10/upload-5.jpg)")).toEqual([]);
    expect(refs("![x](/assets/images/characters/p1/upload-5.jpg)")).toEqual([]);
  });

  it("also tries a bare URL without the prose punctuation after it", () => {
    expect(refs("See /assets/images/p1/upload-8.jpg.")).toEqual(["upload-8.jpg", "upload-8.jpg."]);
  });

  it("keeps a malformed escape as its own name rather than throwing", () => {
    expect(refs("![x](/assets/images/p1/100%.png)")).toEqual(["100%.png"]);
  });

  it("does not match a filename by substring", () => {
    const found = new Set<string>();
    addStudioImageReferences("![x](/assets/images/p1/upload-12.jpg)", "p1", found);
    const references = { filenames: found, pendingStems: new Set<string>() };
    expect(isStudioImageReferenced(references, "upload-1.jpg")).toBe(false);
    expect(isStudioImageReferenced(references, "upload-12.jpg")).toBe(true);
  });
});

describe("isSweptStudioImage", () => {
  it("names exactly the three Studio prefixes", () => {
    expect(isSweptStudioImage("upload-0b7c.jpg")).toBe(true);
    expect(isSweptStudioImage("cover-upload-0b7c.jpg")).toBe(true);
    expect(isSweptStudioImage("studio-image-ck1.webp")).toBe(true);
    for (const other of [
      "cover.png",
      "cover.jpg",
      "chat-image-op1.png",
      "page-3-op1-uuid.png",
      "page-pg1-keeper.png",
      "character-reference-ada-r1.png",
      "character-profile-v1.png",
      "uploaded.jpg",
      "upload-../x",
      "upload-a/b.jpg"
    ]) {
      expect(isSweptStudioImage(other), other).toBe(false);
    }
  });

  it("protects a still-running illustration by its assist stem, whatever the extension", () => {
    const references = { filenames: new Set<string>(), pendingStems: new Set(["studio-image-a9"]) };
    expect(isStudioImageReferenced(references, "studio-image-a9.webp")).toBe(true);
    expect(isStudioImageReferenced(references, "studio-image-a90.webp")).toBe(false);
  });
});

describe("loadStudioImageReferences", () => {
  const url = (filename: string, projectId = "p1") => `![x](/assets/images/${projectId}/${filename})`;

  function seeded() {
    const fake = fakeSweepDb();
    const t = fake.tables;
    t.project.push({ id: "p1", mediaSettings: { studio: { banner: "/assets/images/p1/upload-media.jpg" } } });
    t.project.push({ id: "p2", mediaSettings: {} });
    t.manuscript.push({ id: "m1", projectId: "p1", settings: { dedication: url("upload-settings.jpg") } });
    t.manuscriptChapter.push(
      { id: "c1", manuscriptId: "m1", markdown: url("upload-chapter.jpg"), conflictMarkdown: null, notes: "" },
      { id: "c2", manuscriptId: "m1", markdown: url("upload-deleted.jpg"), conflictMarkdown: null, notes: "", deletedAt: daysAgo(2) },
      { id: "c3", manuscriptId: "m1", markdown: "", conflictMarkdown: url("upload-conflict.jpg"), notes: url("upload-notes.jpg") },
      { id: "c9", manuscriptId: "m2", markdown: url("upload-other-manuscript.jpg"), conflictMarkdown: null, notes: "" }
    );
    t.manuscriptVersion.push(
      { id: "v1", chapterId: "c2", markdown: url("upload-version.jpg") },
      { id: "v9", chapterId: "c9", markdown: url("upload-other-version.jpg") }
    );
    t.page.push(
      { id: "pg1", projectId: "p1", markdown: url("studio-image-page.png") },
      { id: "pg9", projectId: "p2", markdown: url("upload-foreign-page.jpg") }
    );
    t.pageEditSnapshot.push({
      id: "s1",
      projectId: "p1",
      markdownBefore: url("upload-before.jpg"),
      markdownAfter: url("upload-after.jpg")
    });
    t.archivedPageEditSnapshot.push({
      id: "a1",
      projectId: "p1",
      markdownBefore: url("upload-archived-before.jpg"),
      markdownAfter: null
    });
    t.imageAsset.push({
      id: "i1",
      projectId: "p1",
      path: "https://api.example.com/assets/images/p1/cover-upload-asset.jpg",
      metadata: { source: "upload", previous: "/assets/images/p1/cover-upload-meta.jpg" }
    });
    t.bookEditOperation.push({
      id: "o1",
      projectId: "p1",
      classifier: { previousAssets: [{ id: "i9", pageId: "pg1", path: "/assets/images/p1/upload-undo.jpg", prompt: "" }] }
    });
    t.manuscriptAssist.push(
      { id: "ready", projectId: "p1", status: "READY", result: { url: "/assets/images/p1/studio-image-ready.png" }, updatedAt: daysAgo(90) },
      { id: "fresh", projectId: "p1", status: "APPLIED", result: { url: "/assets/images/p1/studio-image-fresh.png" }, updatedAt: daysAgo(3) },
      { id: "stale", projectId: "p1", status: "APPLIED", result: { url: "/assets/images/p1/studio-image-stale.png" }, updatedAt: daysAgo(45) },
      { id: "dismissed", projectId: "p1", status: "DISMISSED", result: { url: "/assets/images/p1/studio-image-dismissed.png" }, updatedAt: daysAgo(1) },
      { id: "failed", projectId: "p1", status: "FAILED", result: null, updatedAt: daysAgo(1) },
      { id: "running", projectId: "p1", status: "RUNNING", result: null, updatedAt: daysAgo(1) },
      { id: "queued", projectId: "p1", status: "QUEUED", result: null, updatedAt: daysAgo(1) }
    );
    t.moderationReport.push({
      id: "r1",
      projectId: "p1",
      targetSnapshot: { projectId: "p1", filename: "cover-upload-reported.jpg" }
    });
    return fake;
  }

  const load = (fake: ReturnType<typeof fakeSweepDb>, needles: string[] = ["images/"]) =>
    loadStudioImageReferences(fake.db, { projectId: "p1", manuscriptId: "m1", now: NOW, graceMs: GRACE, needles });

  it("reads every source of the book and nothing of another", async () => {
    const references = await load(seeded());
    expect([...references.filenames].sort()).toEqual(
      [
        "cover-upload-asset.jpg",
        "cover-upload-meta.jpg",
        "cover-upload-reported.jpg",
        "studio-image-fresh.png",
        "studio-image-page.png",
        "studio-image-ready.png",
        "upload-after.jpg",
        "upload-archived-before.jpg",
        "upload-before.jpg",
        "upload-chapter.jpg",
        "upload-conflict.jpg",
        "upload-deleted.jpg",
        "upload-media.jpg",
        "upload-notes.jpg",
        "upload-settings.jpg",
        "upload-undo.jpg",
        "upload-version.jpg"
      ].sort()
    );
    expect([...references.pendingStems].sort()).toEqual(["studio-image-queued", "studio-image-running"]);
  });

  it("reads a closed or long-applied assist as naming nothing", async () => {
    const references = await load(seeded());
    for (const name of ["studio-image-stale.png", "studio-image-dismissed.png", "studio-image-failed.png"]) {
      expect(isStudioImageReferenced(references, name), name).toBe(false);
    }
  });

  it("walks a source past its first batch", async () => {
    const fake = fakeSweepDb();
    fake.tables.manuscript.push({ id: "m1", projectId: "p1", settings: {} });
    for (let index = 0; index < 130; index += 1) {
      const id = `pg${String(index).padStart(3, "0")}`;
      fake.tables.page.push({ id, projectId: "p1", markdown: url(`upload-${id}.jpg`) });
    }
    const references = await load(fake);
    expect(references.filenames.has("upload-pg000.jpg")).toBe(true);
    expect(references.filenames.has("upload-pg129.jpg")).toBe(true);
    expect(fake.reads.filter((read) => read.table === "page")).toHaveLength(3);
  });

  it("narrows the text columns to rows naming a needle, and still reads the JSON sources whole", async () => {
    const fake = seeded();
    const references = await load(fake, ["upload-before.jpg"]);
    expect(references.filenames.has("upload-before.jpg")).toBe(true);
    expect(references.filenames.has("upload-chapter.jpg")).toBe(false);
    expect(references.filenames.has("cover-upload-asset.jpg")).toBe(true);
    expect(references.filenames.has("upload-undo.jpg")).toBe(true);
  });

  it("refuses an empty needle list rather than reading nothing", async () => {
    await expect(load(seeded(), [])).rejects.toThrow(/needle/);
  });
});
