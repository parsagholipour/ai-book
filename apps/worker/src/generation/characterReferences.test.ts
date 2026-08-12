import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  updateJobProgress: vi.fn(),
  shouldGenerateCharacterReferences: vi.fn(),
  shouldUseCharacterReferenceImages: vi.fn(),
  buildCharacterReferencePrompt: vi.fn(),
  optimizeImageForStorage: vi.fn(),
  publicAssetUrl: vi.fn(),
  generateImageBytes: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  stat: vi.fn(),
  projectFindUnique: vi.fn(),
  libraryCharactersFromMediaSettings: vi.fn(),
  matchLibraryCharacter: vi.fn(),
  libraryCharacterDiskPath: vi.fn(),
  selectCharacterReferenceAssets: vi.fn()
}));

type FakeTx = { imageAsset: typeof mocks.imageAsset; $executeRaw: typeof mocks.executeRaw };
const tx: FakeTx = { imageAsset: mocks.imageAsset, $executeRaw: mocks.executeRaw };

vi.mock("@book-maker/db", () => ({
  prisma: { imageAsset: mocks.imageAsset, project: { findUnique: mocks.projectFindUnique }, $transaction: mocks.transaction },
  Prisma: {}
}));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/tmp/images", BOOK_STORAGE_DIR: "/tmp/books", PUBLIC_API_URL: "http://api.test" }
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));
vi.mock("./bookHelpers.js", () => ({
  imageGenerationMetadata: () => ({}),
  imageStorageMetadata: () => ({})
}));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  appendFile: mocks.appendFile,
  stat: mocks.stat
}));
vi.mock("@book-maker/core", () => ({
  shouldGenerateCharacterReferences: mocks.shouldGenerateCharacterReferences,
  shouldUseCharacterReferenceImages: mocks.shouldUseCharacterReferenceImages,
  buildCharacterReferencePrompt: mocks.buildCharacterReferencePrompt,
  optimizeImageForStorage: mocks.optimizeImageForStorage,
  publicAssetUrl: mocks.publicAssetUrl,
  selectCharacterReferenceAssets: mocks.selectCharacterReferenceAssets,
  libraryCharactersFromMediaSettings: mocks.libraryCharactersFromMediaSettings,
  matchLibraryCharacter: mocks.matchLibraryCharacter,
  libraryCharacterDiskPath: mocks.libraryCharacterDiskPath,
  // The real fold lives in @book-maker/core and is tested there; this stand-in
  // keeps only the two properties the slug leans on — equivalent spellings of
  // one name fold together, and different names do not.
  foldCharacterName: (value: string) =>
    value.replace(/ك/gu, "ک").replace(/[يى]/gu, "ی").replace(/\s+/gu, " ").trim().toLowerCase(),
  // The seed sentence and the page-level face sentence are the real ones'
  // shapes, not their words: what these assert is which of the two a source
  // picks, and that a face only rides along when one was resolved.
  characterReferenceSeedInstruction: (source: string) => `seed:${source}`,
  libraryCharacterFaceInstruction: (names: string[]) => (names.length > 0 ? `faces:${names.join(",")}` : "")
}));

import {
  characterReferenceFileStems,
  characterReferencePromptInstruction,
  characterSlug,
  ensureCharacterReferenceAssets,
  selectReferenceImagePaths
} from "./characterReferences.js";

const plan = {
  characters: [
    { name: "Ada", role: "protagonist", description: "", traits: [], visualRules: [] },
    { name: "Beatrice", role: "sidekick", description: "", traits: [], visualRules: [] }
  ]
} as never;

const assetRow = (characterName: string) => ({
  id: `asset-${characterName}`,
  path: `/assets/images/project-1/character-reference-${characterName.toLowerCase()}.png`,
  metadata: { planId: "plan-1", characterName }
});

const baseOptions = () =>
  ({
    projectId: "project-1",
    planId: "plan-1",
    input: {},
    plan,
    providers: { image: { capabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 3 }) } },
    strategy: { generateImageBytes: mocks.generateImageBytes },
    generationJobId: "gj-1"
  }) as never;

describe("ensureCharacterReferenceAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldGenerateCharacterReferences.mockReturnValue(true);
    mocks.shouldUseCharacterReferenceImages.mockReturnValue(true);
    mocks.buildCharacterReferencePrompt.mockReturnValue("a prompt");
    mocks.optimizeImageForStorage.mockResolvedValue({ bytes: Buffer.from(""), extension: "png" });
    mocks.publicAssetUrl.mockImplementation((_base: string, path: string) => `http://api.test${path}`);
    mocks.generateImageBytes.mockResolvedValue({ bytes: Buffer.from(""), mimeType: "image/png", provider: "fake", model: "fake" });
    mocks.transaction.mockImplementation((callback: (tx: FakeTx) => unknown) => callback(tx));
    mocks.stat.mockRejectedValue(new Error("no file"));
    mocks.projectFindUnique.mockResolvedValue({ userId: "user-1" });
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([]);
    mocks.matchLibraryCharacter.mockReturnValue(null);
    mocks.libraryCharacterDiskPath.mockReturnValue(null);
    mocks.selectCharacterReferenceAssets.mockReturnValue([]);
    mocks.imageAsset.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: `asset-${(data.metadata as { characterName: string }).characterName}`,
      path: data.path,
      metadata: data.metadata
    }));
  });

  it("returns existing references without acquiring the lock when the set is already complete", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([assetRow("Ada"), assetRow("Beatrice")]);

    const result = await ensureCharacterReferenceAssets(baseOptions());

    expect(result).toHaveLength(2);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
  });

  it("generates the full set under the advisory lock when nothing exists yet", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([]);

    const result = await ensureCharacterReferenceAssets(baseOptions());

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
    expect(mocks.imageAsset.create).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it("does not regenerate when a concurrent caller already finished after acquiring the lock", async () => {
    // First (unlocked) read sees an incomplete set — the race window this
    // whole guard exists for — but by the time this caller wins the advisory
    // lock, a concurrent sibling has already committed the full set.
    mocks.imageAsset.findMany
      .mockResolvedValueOnce([]) // pre-lock check
      .mockResolvedValueOnce([assetRow("Ada"), assetRow("Beatrice")]); // post-lock re-check

    const result = await ensureCharacterReferenceAssets(baseOptions());

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.imageAsset.create).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it("clears a partial set left by an earlier plan before regenerating", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([assetRow("Ada")]);
    // Ada already exists, but Beatrice is new: the set is still incomplete on
    // both the pre- and post-lock reads.

    await ensureCharacterReferenceAssets(baseOptions());

    expect(mocks.imageAsset.deleteMany).toHaveBeenCalledWith({
      where: { projectId: "project-1", type: "CHARACTER_REFERENCE" }
    });
    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
  });

  it("seeds a matched character's sheet with their library portrait", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([]);
    const libraryAda = {
      id: "lib-ada",
      name: "Ada",
      description: "",
      fields: [],
      portraitFile: "user-1/lib-ada-portrait.webp"
    };
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([libraryAda]);
    mocks.matchLibraryCharacter.mockImplementation((name: string) => (name === "Ada" ? libraryAda : null));
    mocks.libraryCharacterDiskPath.mockReturnValue("/tmp/images/characters/user-1/lib-ada-portrait.webp");
    mocks.stat.mockResolvedValue({ isFile: () => true });

    await ensureCharacterReferenceAssets(baseOptions());

    const seeded = mocks.generateImageBytes.mock.calls.filter(([request]) => request.referenceImagePaths);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]![0].referenceImagePaths).toEqual(["/tmp/images/characters/user-1/lib-ada-portrait.webp"]);
    // A snapshot written before adoption existed carries no source and is read
    // as the drawn portrait it was.
    expect(seeded[0]![0].prompt).toContain("seed:generated");
    const adaAsset = mocks.imageAsset.create.mock.calls.find(
      ([{ data }]) => (data.metadata as { characterName: string }).characterName === "Ada"
    );
    expect(adaAsset![0].data.metadata).toMatchObject({
      libraryCharacterId: "lib-ada",
      seededFromPortrait: true,
      seedSource: "generated"
    });
    // Beatrice is not in the library, and in a book that mentioned someone that
    // is worth saying out loud: it is the difference between "never asked for"
    // and "asked for and lost".
    const beatriceAsset = mocks.imageAsset.create.mock.calls.find(
      ([{ data }]) => (data.metadata as { characterName: string }).characterName === "Beatrice"
    );
    expect(beatriceAsset![0].data.metadata).toMatchObject({
      seededFromPortrait: false,
      librarySeedSkipped: "no_library_match"
    });
    expect(beatriceAsset![0].data.metadata).not.toHaveProperty("libraryCharacterId");
  });

  it("leaves the sheets of a book that mentioned nobody unmarked", async () => {
    // Every ordinary book would otherwise carry "no_library_match" on every
    // character, which buries the signal for the books that did mention someone.
    mocks.imageAsset.findMany.mockResolvedValue([]);

    await ensureCharacterReferenceAssets(baseOptions());

    for (const [{ data }] of mocks.imageAsset.create.mock.calls) {
      expect(data.metadata).not.toHaveProperty("librarySeedSkipped");
      expect(data.metadata).not.toHaveProperty("seededFromPortrait");
    }
    expect(mocks.appendFile).not.toHaveBeenCalled();
  });

  it("re-poses adopted artwork instead of extending a drawn portrait", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([]);
    const libraryAda = {
      id: "lib-ada",
      name: "Ada",
      description: "",
      fields: [],
      portraitFile: "user-1/lib-ada-portrait.webp",
      portraitSource: "adopted_upload"
    };
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([libraryAda]);
    mocks.matchLibraryCharacter.mockImplementation((name: string) => (name === "Ada" ? libraryAda : null));
    mocks.libraryCharacterDiskPath.mockReturnValue("/tmp/images/characters/user-1/lib-ada-portrait.webp");
    mocks.stat.mockResolvedValue({ isFile: () => true });

    await ensureCharacterReferenceAssets(baseOptions());

    const seeded = mocks.generateImageBytes.mock.calls.filter(([request]) => request.referenceImagePaths);
    expect(seeded[0]![0].prompt).toContain("seed:adopted_upload");
    const adaAsset = mocks.imageAsset.create.mock.calls.find(
      ([{ data }]) => (data.metadata as { characterName: string }).characterName === "Ada"
    );
    expect(adaAsset![0].data.metadata).toMatchObject({ seedSource: "adopted_upload" });
  });

  it("refuses a snapshot naming another user's portrait directory", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([]);
    const planted = {
      id: "lib-ada",
      name: "Ada",
      description: "",
      fields: [],
      portraitFile: "victim-user/stolen-portrait.webp"
    };
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([planted]);
    mocks.matchLibraryCharacter.mockReturnValue(planted);
    mocks.libraryCharacterDiskPath.mockReturnValue("/tmp/images/characters/victim-user/stolen-portrait.webp");
    mocks.stat.mockResolvedValue({ isFile: () => true });

    await ensureCharacterReferenceAssets(baseOptions());

    for (const [request] of mocks.generateImageBytes.mock.calls) {
      expect(request.referenceImagePaths).toBeUndefined();
    }
    const adaAsset = mocks.imageAsset.create.mock.calls.find(
      ([{ data }]) => (data.metadata as { characterName: string }).characterName === "Ada"
    );
    expect(adaAsset![0].data.metadata).toMatchObject({
      seededFromPortrait: false,
      librarySeedSkipped: "portrait_owned_by_another_user",
      libraryCharacterId: "lib-ada"
    });
  });

  it("records why the seed was dropped when the portrait file has gone (a deleted character)", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([]);
    const libraryAda = {
      id: "lib-ada",
      name: "Ada",
      description: "",
      fields: [],
      portraitFile: "user-1/lib-ada-portrait.webp"
    };
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([libraryAda]);
    mocks.matchLibraryCharacter.mockReturnValue(libraryAda);
    mocks.libraryCharacterDiskPath.mockReturnValue("/tmp/images/characters/user-1/lib-ada-portrait.webp");
    mocks.stat.mockRejectedValue(new Error("gone"));

    await ensureCharacterReferenceAssets(baseOptions());

    // The book is still made — a character deleted since the build must not
    // fail it — but nothing about the finished sheet would otherwise say the
    // reader's own artwork was meant to be on it.
    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.generateImageBytes.mock.calls) {
      expect(request.referenceImagePaths).toBeUndefined();
    }
    const adaAsset = mocks.imageAsset.create.mock.calls.find(
      ([{ data }]) => (data.metadata as { characterName: string }).characterName === "Ada"
    );
    expect(adaAsset![0].data.metadata).toMatchObject({
      seededFromPortrait: false,
      librarySeedSkipped: "portrait_file_missing",
      libraryCharacterId: "lib-ada"
    });
    // Renders run concurrently, so the two lines may land in either order.
    const logged = mocks.appendFile.mock.calls.map(([path, line]) => ({
      path: path as string,
      entry: JSON.parse((line as string).trim()) as Record<string, unknown>
    }));
    const ada = logged.find((call) => call.entry.characterName === "Ada");
    expect(ada!.path).toBe("/tmp/books/project-1/runs/gj-1-character-references.jsonl");
    expect(ada!.entry).toMatchObject({
      event: "character.reference.library_seed_skipped",
      projectId: "project-1",
      planId: "plan-1",
      reason: "portrait_file_missing",
      libraryCharacterId: "lib-ada"
    });
  });

  it("never lets a failed run-log write fail the book", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.imageAsset.findMany.mockResolvedValue([]);
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([
      { id: "lib-ada", name: "Ada", description: "", fields: [], portraitFile: "user-1/lib-ada-portrait.webp" }
    ]);
    mocks.appendFile.mockRejectedValue(new Error("read-only volume"));

    await expect(ensureCharacterReferenceAssets(baseOptions())).resolves.toHaveLength(2);
    consoleError.mockRestore();
  });
});

describe("characterSlug", () => {
  it("leaves an ASCII name's slug exactly as it was", () => {
    // Existing books' files are named from this; churning it would strand them.
    expect(characterSlug("Ada")).toBe("ada");
    expect(characterSlug("  Captain Luna Vega ")).toBe("captain-luna-vega");
    expect(characterSlug("Sam's Mother!")).toBe("sam-s-mother");
  });

  it("gives every non-Latin name in a cast its own file", () => {
    // The confirmed production failure: all three of these emptied out, became
    // the literal "unknown", and shared one `character-reference-unknown.jpg`.
    const persian = ["بهرام", "کیوان", "رهگذر دانا"].map(characterSlug);
    expect(new Set(persian).size).toBe(3);
    expect(persian).not.toContain("unknown");
    for (const slug of persian) {
      expect(slug).toMatch(/^char-[0-9a-f]{10}$/);
    }

    const others = ["Бахрам", "キーワン", "שרה"].map(characterSlug);
    expect(new Set([...persian, ...others]).size).toBe(6);
  });

  it("folds two spellings of one name onto one file", () => {
    // An Arabic kaf and a Persian one render identically and are typed
    // interchangeably; a rerun that spelled the name the other way must not
    // leave the book with two half-populated sheets.
    expect(characterSlug("كيوان")).toBe(characterSlug("کیوان"));
  });
});

describe("characterReferenceFileStems", () => {
  it("separates characters whose slugs collide", () => {
    // A mostly-Persian name still yields an ASCII slug from whatever Latin it
    // holds, so uniqueness cannot be a property of one name on its own.
    expect(characterReferenceFileStems(["Ada بهرام", "Ada کیوان", "Ada"])).toEqual([
      "character-reference-ada",
      "character-reference-ada-2",
      "character-reference-ada-3"
    ]);
  });

  it("keeps a distinct cast's stems untouched", () => {
    expect(characterReferenceFileStems(["Ada", "Beatrice"])).toEqual([
      "character-reference-ada",
      "character-reference-beatrice"
    ]);
  });
});

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
    mocks.libraryCharacterDiskPath.mockReturnValue("/tmp/images/characters/user-1/lib-ada-portrait.webp");
    mocks.stat.mockResolvedValue({ isFile: () => true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectFindUnique.mockResolvedValue({ userId: "user-1" });
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([]);
    mocks.matchLibraryCharacter.mockReturnValue(null);
    mocks.libraryCharacterDiskPath.mockReturnValue(null);
    mocks.stat.mockRejectedValue(new Error("no file"));
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
    mocks.libraryCharacterDiskPath.mockImplementation(
      (_dir: string, file: string) => `/tmp/images/characters/${file}`
    );
    mocks.stat.mockResolvedValue({ isFile: () => true });

    const result = await selectReferenceImagePaths({
      ...(selectionOptions(4) as object),
      assets: [
        {
          ...sheetAsset("Ada"),
          metadata: { planId: "plan-1", characterName: "Ada", libraryCharacterId: "lib-ada" }
        }
      ]
    } as never);

    expect(result.paths.at(-1)).toBe("/tmp/images/characters/user-1/lib-ada-portrait.webp");
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
      "/tmp/images/project-1/character-reference-ada.png",
      "/tmp/images/project-1/character-reference-beatrice.png",
      "/tmp/images/characters/user-1/lib-ada-portrait.webp"
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
      "/tmp/images/project-1/character-reference-ada.png",
      "/tmp/images/project-1/character-reference-beatrice.png"
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
    mocks.libraryCharacterDiskPath.mockReturnValue("/tmp/images/characters/victim-user/stolen-portrait.webp");
    mocks.stat.mockResolvedValue({ isFile: () => true });

    const result = await selectReferenceImagePaths(selectionOptions(4));

    expect(result.paths).not.toContain("/tmp/images/characters/victim-user/stolen-portrait.webp");
    expect(result.libraryFaceNames).toEqual([]);
  });

  it("skips artwork whose file has gone", async () => {
    withAdasArtworkOnDisk();
    mocks.stat.mockRejectedValue(new Error("gone"));

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
