import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  continuityFindMany: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: {
    continuityNote: { findMany: mocks.continuityFindMany },
    researchSource: { findMany: vi.fn() }
  }
}));
vi.mock("./semanticMemory.js", () => ({ retrieveSemanticResearchNotes: vi.fn() }));

import { loadContinuityNotes } from "./generationContext.js";

describe("loadContinuityNotes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps owned page notes and project notes while excluding ambiguous legacy page scopes", async () => {
    mocks.continuityFindMany.mockResolvedValue([
      { body: "A current page fact." },
      { body: "A project-wide rule." }
    ]);

    await expect(loadContinuityNotes("project-1")).resolves.toEqual([
      "A current page fact.",
      "A project-wide rule."
    ]);
    expect(mocks.continuityFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        NOT: { pageId: null, scope: { startsWith: "page:" } }
      },
      orderBy: { createdAt: "desc" },
      take: 28
    });
  });
});
