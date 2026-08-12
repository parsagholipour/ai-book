vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadVoiceCast } from "./voiceCast.js";
import { mockPrisma } from "./testing/mobileApiMocks.js";

/**
 * The cast sheet a reader sees for a finished book.
 *
 * Two things it must get right that no other surface can: which plan's cast is
 * the book's, and which of its members are saved library characters rather than
 * people the planner invented.
 */

function castRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cast-1",
    projectId: "project-1",
    planVersionId: "plan-2",
    libraryCharacterId: null,
    name: "Natalia",
    role: "Protagonist",
    description: "She's a great wife and future mother.",
    traits: ["warm"],
    status: "READY",
    persona: { instructions: "You are Natalia." },
    profileImageAssetId: null,
    ...overrides
  };
}

describe("loadVoiceCast", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.project.findUnique.mockResolvedValue({ userId: "user-a", currentPlanId: "plan-2" });
    mockPrisma.imageAsset.findMany.mockResolvedValue([]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
  });

  it("asks only for the approved plan's cast, plus rows written before the column existed", async () => {
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([castRow()]);

    await loadVoiceCast("project-1");

    expect(mockPrisma.voiceCharacter.findMany.mock.calls[0]?.[0].where).toMatchObject({
      projectId: "project-1",
      OR: [{ planVersionId: "plan-2" }, { planVersionId: null }]
    });
  });

  it("drops a superseded plan's cast rather than listing the same character twice", async () => {
    // A continuation approves a brand new PlanVersion and its compile prepares
    // a whole second cast; nothing deletes the first one.
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      castRow({ id: "cast-old", planVersionId: null, description: "The planner's first draft of her." }),
      castRow({ id: "cast-new", planVersionId: "plan-2" })
    ]);

    const cast = await loadVoiceCast("project-1");

    expect(cast.map((character) => character.id)).toEqual(["cast-new"]);
  });

  it("keeps a pre-column cast when the current plan prepared none", async () => {
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([castRow({ id: "cast-old", planVersionId: null })]);

    const cast = await loadVoiceCast("project-1");

    expect(cast.map((character) => character.id)).toEqual(["cast-old"]);
  });

  it("serves the saved character's own portrait beside the link", async () => {
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([castRow({ libraryCharacterId: "library-natalia" })]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "library-natalia", portraitPath: "natalia-portrait-abc.jpeg", portraitStatus: "READY" }
    ]);

    const cast = await loadVoiceCast("project-1");

    expect(cast[0]).toMatchObject({
      libraryCharacterId: "library-natalia",
      libraryPortraitUrl: "/api/mobile/characters/library-natalia/portrait"
    });
    // Scoped to the book's owner: the portrait route serves the caller's own
    // characters, so an id belonging to anyone else must yield no link at all.
    expect(mockPrisma.libraryCharacter.findMany.mock.calls[0]?.[0].where).toMatchObject({
      id: { in: ["library-natalia"] },
      userId: "user-a"
    });
  });

  it("keeps the link but offers no portrait when the saved character is gone or unfinished", async () => {
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      castRow({ id: "cast-deleted", libraryCharacterId: "library-deleted" }),
      castRow({ id: "cast-drawing", libraryCharacterId: "library-drawing" })
    ]);
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      { id: "library-drawing", portraitPath: null, portraitStatus: "GENERATING" }
    ]);

    const cast = await loadVoiceCast("project-1");

    // Deleting a library character deletes no book state, so the row still
    // reports what it was made from — only the URL, a promise about bytes the
    // app will fetch, is withheld.
    expect(cast.map((character) => [character.libraryCharacterId, character.libraryPortraitUrl])).toEqual([
      ["library-deleted", null],
      ["library-drawing", null]
    ]);
  });

  it("asks for no library rows when the book invented its whole cast", async () => {
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([castRow()]);

    const cast = await loadVoiceCast("project-1");

    expect(cast[0]).toMatchObject({ libraryCharacterId: null, libraryPortraitUrl: null });
    expect(mockPrisma.libraryCharacter.findMany).not.toHaveBeenCalled();
  });

  it("lists every non-rejected row when the project has no current plan to scope by", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);
    mockPrisma.voiceCharacter.findMany.mockResolvedValue([
      castRow({ id: "cast-a" }),
      castRow({ id: "cast-b", planVersionId: "plan-1" })
    ]);

    const cast = await loadVoiceCast("project-1");

    expect(mockPrisma.voiceCharacter.findMany.mock.calls[0]?.[0].where.OR).toBeUndefined();
    expect(cast.map((character) => character.id)).toEqual(["cast-a", "cast-b"]);
  });
});
