import { beforeEach, expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan } from "@book-maker/core";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@book-maker/db", () => ({ prisma: { project: { findUnique } }, researchCitationsForExport: async () => [] }));

import { compileProjectManuscript } from "./projectManuscript.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle find the lanterns.", category: "KIDS", targetPages: 30,
  mediaSettings: { fullIllustrations: true, illustrationCadence: "every-third-page" } });
const row = { ...input, id: "story", authorName: "Story Author", currentPlan: { planningPackage: makeFallbackPlan(input) },
  pages: Array.from({ length: 30 }, (_, index) => ({ index: index + 1, title: `Scene ${index + 1}`,
    markdown: `Rabbit and Turtle find lantern ${index + 1}.`, images: [] })), images: [], research: [] };

beforeEach(() => { findUnique.mockReset(); findUnique.mockResolvedValue(row); });

it("keeps the worker's thirty-scene layout during an API missing-export rebuild", async () => {
  const compiled = await compileProjectManuscript("story", "http://localhost:4001", "/unused");
  expect(compiled?.pageMapPlan?.storyPageLayout).toBe("separate");
  expect(compiled?.pageMapPlan?.pageAnchors).toHaveLength(30);
  expect(compiled?.markdown).toContain("Rabbit and Turtle find lantern 30.");
  expect(compiled?.markdown).not.toContain("pdf-story-page");
});

it.each(["adult", "imported"])("preserves flowing %s exports", async (kind) => {
  findUnique.mockResolvedValue({ ...row, ...(kind === "adult" ? { category: "STORY" } : {
    mediaSettings: { ...row.mediaSettings, mobile: { import: { source: "manuscript" } } }
  }) });
  const compiled = await compileProjectManuscript("story", "http://localhost:4001", "/unused");
  expect(compiled?.pageMapPlan?.storyPageLayout).toBeUndefined();
});

it("rebuilds a Studio book exactly as the worker compiles it: its layout, its chapters, its page breaks", async () => {
  const studio = (layout: "flow" | "picture") => ({
    ...row.mediaSettings, mobile: { studio: { layout, kind: "story", createdAt: "2026-09-29T00:00:00.000Z" } }
  });
  const chapter = (index: number, title: string) => ({ id: `chapter-${index}`, index, title, summary: "" });
  const pages = [1, 2, 3, 4].map((index) => ({
    index, title: `Page ${index}`, images: [], chapter: index <= 2 ? chapter(1, "Chapter 1") : chapter(2, "The Storm"),
    markdown: index === 3 ? "## Page 3\n\nThe storm came in." : `Paragraph ${index}.`
  }));
  findUnique.mockResolvedValue({ ...row, category: "STORY", targetPages: 4, mediaSettings: studio("flow"), pages });

  const flow = await compileProjectManuscript("story", "http://localhost:4001", "/unused");

  expect(flow?.pageMapPlan?.storyPageLayout).toBeUndefined();
  expect(flow?.markdown).toContain("Paragraph 1.\n\nParagraph 2.");
  // Four pages earn title-only sections; the author's own "## Page 3" survives under its chapter.
  expect(flow?.markdown).toContain("Paragraph 2.\n\n<a id=\"chapter-2\"></a>\n\n## The Storm\n## Page 3\n\nThe storm came in.");

  findUnique.mockResolvedValue({ ...row, category: "STORY", targetPages: 4, mediaSettings: studio("picture"), pages });
  const picture = await compileProjectManuscript("story", "http://localhost:4001", "/unused");
  expect(picture?.pageMapPlan?.storyPageLayout).toBe("separate");
});
