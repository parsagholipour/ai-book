// Split from characterReferences.test.ts: the read side of the sheets — which
// pictures a page or a cover is handed — beside the module that owns it.
// Same module mocks as the render-pass suite, so both run the same graph.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  planVersion: { findUnique: vi.fn(), updateMany: vi.fn() },
  executeRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  executeRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  updateJobProgress: vi.fn(),
  shouldGenerateCharacterReferences: vi.fn(),
  characterReferenceCast: vi.fn(),
  coverCastCharacters: vi.fn(),
  coverPortraitCharacters: vi.fn(),
  shouldUseCharacterReferenceImages: vi.fn(),
  buildCharacterReferencePrompt: vi.fn(),
  optimizeImageForStorage: vi.fn(),
  publicAssetUrl: vi.fn(),
  generateImageBytes: vi.fn(),
  mkdir: vi.fn(),
  put: vi.fn(),
  appendRunLog: vi.fn(),
  head: vi.fn(),
  projectFindUnique: vi.fn(),
  libraryCharactersFromMediaSettings: vi.fn(),
  matchLibraryCharacter: vi.fn(),
  libraryCharacterObjectKey: vi.fn(),
  selectCharacterReferenceAssets: vi.fn()
}));

vi.mock("@book-maker/db", () => ({
  prisma: {
    imageAsset: mocks.imageAsset,
    planVersion: mocks.planVersion,
    project: { findUnique: mocks.projectFindUnique },
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $executeRawUnsafe: mocks.executeRawUnsafe
  },
  Prisma: { DbNull: "DbNull" }
}));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/tmp/images", BOOK_STORAGE_DIR: "/tmp/books", PUBLIC_API_URL: "http://api.test" }
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress, assertJobNotStopped: async () => undefined }));
vi.mock("./bookHelpers.js", () => ({ imageGenerationMetadata: () => ({}), imageStorageMetadata: () => ({}) }));
vi.mock("@book-maker/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@book-maker/storage")>();
  return { ...actual, appendRunLog: mocks.appendRunLog, objectStore: () => ({ put: mocks.put, head: mocks.head }) };
});
vi.mock("@book-maker/core", () => ({
  shouldGenerateCharacterReferences: mocks.shouldGenerateCharacterReferences,
  characterReferenceCast: mocks.characterReferenceCast,
  coverCastCharacters: mocks.coverCastCharacters,
  coverPortraitCharacters: mocks.coverPortraitCharacters,
  shouldUseCharacterReferenceImages: mocks.shouldUseCharacterReferenceImages,
  buildCharacterReferencePrompt: mocks.buildCharacterReferencePrompt,
  optimizeImageForStorage: mocks.optimizeImageForStorage,
  publicAssetUrl: mocks.publicAssetUrl,
  selectCharacterReferenceAssets: mocks.selectCharacterReferenceAssets,
  libraryCharactersFromMediaSettings: mocks.libraryCharactersFromMediaSettings,
  matchLibraryCharacter: mocks.matchLibraryCharacter,
  libraryCharacterObjectKey: mocks.libraryCharacterObjectKey,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  // The real classifier lives in @book-maker/core and is tested there. This
  // stand-in keeps the one property this module leans on: a refusal is the
  // provider's verdict on the prompt, and anything else is not.
  isImageContentRefusalError: (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as Record<string, unknown>).imageContentRefused === true),
  imageRefusalReason: (error: unknown) => String((error as Record<string, unknown>)?.reason ?? "refused"),
  // `characterSlug` calls this only after reducing the value to `[a-z0-9-]`,
  // so the machine-path policy is an identity function on this suite's seam.
  safePathPart: (value: string) => value,
  // The real fold lives in @book-maker/core and is tested there; this stand-in
  // keeps only the two properties the slug leans on — equivalent spellings of
  // one name fold together, and different names do not.
  foldCharacterName: (value: string) =>
    value.replace(/ك/gu, "ک").replace(/[يى]/gu, "ی").replace(/\s+/gu, " ").trim().toLowerCase(),
  // The seed sentence and the page-level face sentence are the real ones'
  // shapes, not their words: what these assert is which of the two a source
  // picks, and that a face only rides along when one was resolved.
  characterReferenceSeedInstruction: (source: string) => `seed:${source}`,
  // Every image fixture below declares `capabilities`; the undeclared default is core's.
  imageAdapterCapabilities: (image: { capabilities: () => unknown }) => image.capabilities(),
  libraryCharacterFaceInstruction: (names: string[]) => (names.length > 0 ? `faces:${names.join(",")}` : "")
}));

import {
  characterReferencePromptInstruction,
  selectCoverReferenceImagePaths,
  selectReferenceImagePaths
} from "./characterReferences.js";

const plan = {
  characters: [
    { name: "Ada", role: "protagonist", description: "", traits: [], visualRules: [] },
    { name: "Beatrice", role: "sidekick", description: "", traits: [], visualRules: [] }
  ]
} as never;

describe("selectReferenceImagePaths", () => {
  const sheetAsset = (characterName: string) => ({
    id: `asset-${characterName}`,
    path: `http://api.test/assets/images/project-1/character-reference-${characterName.toLowerCase()}.png`,
    metadata: { planId: "plan-1", characterName }
  });

  const selectionOptions = (maxReferenceImages: number) =>
    ({
      input: {},
      plan,
      assets: [sheetAsset("Ada"), sheetAsset("Beatrice")],
      projectId: "project-1",
      image: { capabilities: () => ({ supportsReferenceImages: true, maxReferenceImages }) },
      context: "Ada waves"
    }) as never;

  const libraryAda = {
    id: "lib-ada",
    name: "Ada",
    description: "",
    fields: [],
    portraitFile: "user-1/lib-ada-portrait.webp"
  };

  const withAdasArtworkOnDisk = () => {
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([libraryAda]);
    mocks.matchLibraryCharacter.mockImplementation((name: string) => (name === "Ada" ? libraryAda : null));
    mocks.libraryCharacterObjectKey.mockReturnValue("images/characters/user-1/lib-ada-portrait.webp");
    mocks.head.mockResolvedValue({ isFile: () => true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectFindUnique.mockResolvedValue({ userId: "user-1" });
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([]);
    mocks.matchLibraryCharacter.mockReturnValue(null);
    mocks.libraryCharacterObjectKey.mockReturnValue(null);
    mocks.head.mockResolvedValue(null);
    mocks.selectCharacterReferenceAssets.mockImplementation(
      ({ assets, maxReferences }: { assets: Array<{ path: string }>; maxReferences: number }) =>
        assets.slice(0, maxReferences)
    );
  });

  it("returns nothing for an adapter that cannot take reference images", async () => {
    const result = await selectReferenceImagePaths({
      ...(selectionOptions(3) as object),
      image: { capabilities: () => ({ supportsReferenceImages: false, maxReferenceImages: 0 }) }
    } as never);

    expect(result).toEqual({ paths: [], libraryFaceNames: [] });
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
  });

  it("reads the library id the sheet recorded rather than matching its name again", async () => {
    // The seeding pass already answered this and wrote the answer on the row.
    // Running the matcher a second time can reach a *different* answer — here
    // it insists on Bea — and the face it attaches then belongs to somebody
    // else, which is the whole reported bug one layer down.
    const libraryBea = {
      id: "lib-bea",
      name: "Bea",
      description: "",
      fields: [],
      portraitFile: "user-1/lib-bea-portrait.webp"
    };
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([libraryAda, libraryBea]);
    mocks.matchLibraryCharacter.mockReturnValue(libraryBea);
    mocks.libraryCharacterObjectKey.mockImplementation(
      (file: string) => `images/characters/${file}`
    );
    mocks.head.mockResolvedValue({ isFile: () => true });

    const result = await selectReferenceImagePaths({
      ...(selectionOptions(4) as object),
      assets: [
        {
          ...sheetAsset("Ada"),
          metadata: { planId: "plan-1", characterName: "Ada", libraryCharacterId: "lib-ada" }
        }
      ]
    } as never);

    expect(result.paths.at(-1)).toBe("object://images/characters/user-1/lib-ada-portrait.webp");
    expect(result.libraryFaceNames).toEqual(["Ada"]);
    expect(mocks.matchLibraryCharacter).not.toHaveBeenCalled();
  });

  it("attaches nothing when the recorded id names no snapshot", async () => {
    // The snapshot set moved out from under the sheet; a name guess against a
    // moved set is exactly what the recorded id exists to avoid.
    withAdasArtworkOnDisk();

    const result = await selectReferenceImagePaths({
      ...(selectionOptions(4) as object),
      assets: [
        {
          ...sheetAsset("Ada"),
          metadata: { planId: "plan-1", characterName: "Ada", libraryCharacterId: "lib-gone" }
        }
      ]
    } as never);

    expect(result.libraryFaceNames).toEqual([]);
    expect(mocks.matchLibraryCharacter).not.toHaveBeenCalled();
  });

  it("appends the reader's own artwork after the sheets when the budget has room", async () => {
    // No recorded id: a sheet rendered before it existed, which is the one case
    // still resolved by name.
    withAdasArtworkOnDisk();

    const result = await selectReferenceImagePaths(selectionOptions(3));

    expect(result.paths).toEqual([
      "object://images/project-1/character-reference-ada.png",
      "object://images/project-1/character-reference-beatrice.png",
      "object://images/characters/user-1/lib-ada-portrait.webp"
    ]);
    expect(result.libraryFaceNames).toEqual(["Ada"]);
    expect(characterReferencePromptInstruction(result)).toContain("faces:Ada");
  });

  it("never displaces a sheet: a full budget carries no faces at all", async () => {
    // Losing a character's sheet to gain another character's face would trade
    // one consistency problem for a worse one.
    withAdasArtworkOnDisk();

    const result = await selectReferenceImagePaths(selectionOptions(2));

    expect(result.paths).toEqual([
      "object://images/project-1/character-reference-ada.png",
      "object://images/project-1/character-reference-beatrice.png"
    ]);
    expect(result.libraryFaceNames).toEqual([]);
    expect(characterReferencePromptInstruction(result)).not.toContain("faces:");
  });

  it("does not read the project row when no snapshot carries artwork", async () => {
    const result = await selectReferenceImagePaths(selectionOptions(3));

    expect(result.libraryFaceNames).toEqual([]);
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
  });

  it("refuses artwork in another user's directory", async () => {
    const planted = { ...libraryAda, portraitFile: "victim-user/stolen-portrait.webp" };
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([planted]);
    mocks.matchLibraryCharacter.mockReturnValue(planted);
    mocks.libraryCharacterObjectKey.mockReturnValue("images/characters/victim-user/stolen-portrait.webp");
    mocks.head.mockResolvedValue({ isFile: () => true });

    const result = await selectReferenceImagePaths(selectionOptions(4));

    expect(result.paths).not.toContain("object://images/characters/victim-user/stolen-portrait.webp");
    expect(result.libraryFaceNames).toEqual([]);
  });

  it("skips artwork whose file has gone", async () => {
    withAdasArtworkOnDisk();
    mocks.head.mockResolvedValue(null);

    const result = await selectReferenceImagePaths(selectionOptions(4));

    expect(result.libraryFaceNames).toEqual([]);
  });

  it("seeds nothing for a book with no owner (the operator console)", async () => {
    withAdasArtworkOnDisk();
    mocks.projectFindUnique.mockResolvedValue(null);

    const result = await selectReferenceImagePaths(selectionOptions(4));

    expect(result.libraryFaceNames).toEqual([]);
  });
});

describe("selectCoverReferenceImagePaths", () => {
  const sheetAsset = (characterName: string) => ({
    id: `asset-${characterName}`,
    path: `http://api.test/assets/images/project-1/character-reference-${characterName.toLowerCase()}.png`,
    metadata: { planId: "plan-1", characterName }
  });
  const coverOptions = (fullIllustrations: boolean) =>
    ({
      input: { mediaSettings: { fullIllustrations } },
      plan,
      assets: [sheetAsset("Ada"), sheetAsset("Beatrice")],
      projectId: "project-1",
      image: { capabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 3 }) },
      artworkPrompt: "Primary visual concept: Ada at the window."
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectFindUnique.mockResolvedValue({ userId: "user-1" });
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([]);
    mocks.libraryCharacterObjectKey.mockReturnValue(null);
    mocks.head.mockResolvedValue(null);
    mocks.coverCastCharacters.mockReturnValue([{ name: "Ada" }]);
    mocks.coverPortraitCharacters.mockReturnValue([]);
    mocks.selectCharacterReferenceAssets.mockImplementation(
      ({ assets, maxReferences }: { assets: Array<{ path: string }>; maxReferences: number }) =>
        assets.slice(0, maxReferences)
    );
  });

  it("attaches only the sheets of the characters a cover-only book's cover shows", async () => {
    // The Tiko cover showed one tortoise and was handed three characters.
    const result = await selectCoverReferenceImagePaths(coverOptions(false));

    expect(result).toEqual({ paths: ["object://images/project-1/character-reference-ada.png"], libraryFaceNames: [] });
  });

  it("attaches a saved portrait in place of the sheet it did not draw", async () => {
    mocks.coverCastCharacters.mockReturnValue([{ name: "Ada" }, { name: "Cleo" }]);
    mocks.coverPortraitCharacters.mockReturnValue([
      { character: { name: "Cleo" }, snapshot: { id: "lib-cleo", name: "Cleo", description: "", fields: [], portraitFile: "user-1/cleo.webp" } }
    ]);
    mocks.libraryCharacterObjectKey.mockReturnValue("images/characters/user-1/cleo.webp");
    mocks.head.mockResolvedValue({ isFile: () => true });

    const result = await selectCoverReferenceImagePaths(coverOptions(false));

    expect(result.paths).toEqual([
      "object://images/project-1/character-reference-ada.png",
      "object://images/characters/user-1/cleo.webp"
    ]);
  });

  it("keeps an illustrated book's cover selection as it was", async () => {
    const result = await selectCoverReferenceImagePaths(coverOptions(true));

    expect(result.paths).toEqual([
      "object://images/project-1/character-reference-ada.png",
      "object://images/project-1/character-reference-beatrice.png"
    ]);
    expect(mocks.coverCastCharacters).not.toHaveBeenCalled();
  });
});
