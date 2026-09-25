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
