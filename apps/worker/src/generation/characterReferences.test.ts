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

type FakeTx = {
  imageAsset: typeof mocks.imageAsset;
  planVersion: typeof mocks.planVersion;
  $executeRaw: typeof mocks.executeRaw;
  $queryRawUnsafe: typeof mocks.queryRawUnsafe;
  $executeRawUnsafe: typeof mocks.executeRawUnsafe;
};
const tx: FakeTx = {
  imageAsset: mocks.imageAsset,
  planVersion: mocks.planVersion,
  $executeRaw: mocks.executeRaw,
  $queryRawUnsafe: mocks.queryRawUnsafe,
  $executeRawUnsafe: mocks.executeRawUnsafe
};

/**
 * How many `prisma.$transaction` callbacks are on the stack right now.
 *
 * The advisory lock is taken inside one, so this is the suite's reading of
 * "the lock is held" — which is what the render pass may no longer be doing
 * while it waits on an image model.
 */
let openTransactions = 0;

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
    openTransactions = 0;
    mocks.transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => {
      openTransactions += 1;
      try {
        return await callback(tx);
      } finally {
        openTransactions -= 1;
      }
    });
    // An uncontended claim — the case every other test is written for: the
    // compare-and-set takes the lease and hands back its expiry.
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRawUnsafe.mockResolvedValue([{ characterReferenceLeaseExpiresAt: new Date(Date.now() + 60_000) }]);
    mocks.executeRawUnsafe.mockResolvedValue(1);
    mocks.stat.mockRejectedValue(new Error("no file"));
    mocks.projectFindUnique.mockResolvedValue({ userId: "user-1" });
    mocks.libraryCharactersFromMediaSettings.mockReturnValue([]);
    mocks.matchLibraryCharacter.mockReturnValue(null);
    mocks.libraryCharacterDiskPath.mockReturnValue(null);
    mocks.selectCharacterReferenceAssets.mockReturnValue([]);
    mocks.planVersion.findUnique.mockResolvedValue({ characterReferenceRefusals: null });
    mocks.planVersion.updateMany.mockResolvedValue({ count: 1 });
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

  it("asks for the sheets and the settled refusals in one round trip", async () => {
    // The pre-lock check runs before every page render, so its two independent
    // reads must be in flight together: the refusal read is issued before the
    // asset read has answered, which a sequential pair can never do.
    let refusalsAskedBeforeAssetsAnswered = false;
    mocks.imageAsset.findMany.mockImplementation(async () => {
      await Promise.resolve();
      refusalsAskedBeforeAssetsAnswered = mocks.planVersion.findUnique.mock.calls.length > 0;
      return [assetRow("Ada"), assetRow("Beatrice")];
    });

    await ensureCharacterReferenceAssets(baseOptions());

    expect(refusalsAskedBeforeAssetsAnswered).toBe(true);
  });

  it("generates the full set under the advisory lock when nothing exists yet", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([]);

    const result = await ensureCharacterReferenceAssets(baseOptions());

    // Two now, not one: the claim and the commit. The renders happen between
    // them, with neither the lock nor a connection held.
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
    expect(mocks.imageAsset.create).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it("makes no model call while the advisory-lock transaction is open", async () => {
    // The pass used to render the whole cast inside one `$transaction` with a
    // five-minute timeout, holding `pg_advisory_xact_lock` the entire time.
    // Tolerating a refusal made that budget reachable: the pass no longer
    // stops at the first refused character, and a copyright refusal buys a
    // text call to rewrite the prompt plus a second primary→fallback render on
    // top of it. Overrunning aborted the transaction and threw away every
    // sheet already rendered and paid for, while every other image job sat
    // blocked on the lock for the whole window.
    mocks.imageAsset.findMany.mockResolvedValue([]);
    const lockHeldWhileRendering: number[] = [];
    const lockHeldWhileWriting: number[] = [];
    mocks.generateImageBytes.mockImplementation(async () => {
      lockHeldWhileRendering.push(openTransactions);
      return { bytes: Buffer.from(""), mimeType: "image/png", provider: "fake", model: "fake" };
    });
    const create = mocks.imageAsset.create.getMockImplementation()!;
    mocks.imageAsset.create.mockImplementation((args: { data: Record<string, unknown> }) => {
      lockHeldWhileWriting.push(openTransactions);
      return create(args);
    });

    await ensureCharacterReferenceAssets(baseOptions());

    expect(lockHeldWhileRendering).toEqual([0, 0]);
    // The durability the transaction exists for is untouched: the sheets still
    // land under the lock. This cast was drawn whole, so there is no settlement
    // to land beside them — see the settlement tests below.
    expect(lockHeldWhileWriting).toEqual([1, 1]);
  });

  it("never lets a second render pass write over the first pass's files", async () => {
    // The other side of leaving the lock. Two passes over one cast can now
    // overlap — a lease that expired under a slow render, or two plan versions
    // of one book — and they share this project's image directory. Named from
    // the cast alone, that is one path with two writers: `writeFile` truncates
    // in place under a page render reading the same path, and the loser's bytes
    // land on a sheet the winner has already published an `ImageAsset` for,
    // leaving the row describing a picture that is no longer there. A losing
    // pass leaves an orphan file instead, which is storage noise.
    mocks.imageAsset.findMany.mockResolvedValue([]);

    await ensureCharacterReferenceAssets(baseOptions());
    await ensureCharacterReferenceAssets(baseOptions());

    const written = mocks.writeFile.mock.calls.map(([path]) => String(path));
    expect(written).toHaveLength(4);
    expect(new Set(written).size).toBe(4);
    // And every published row names a file its own pass wrote.
    const published = mocks.imageAsset.create.mock.calls.map(
      ([{ data }]) => `/tmp/images/project-1/${(data.metadata as { fileName: string }).fileName}`
    );
    expect(new Set(published)).toEqual(new Set(written));
  });

  it("hands a render failure back to the job with the lease released", async () => {
    // An outage is retried by `generate-book`'s own ladder. A lease left
    // standing would make that retry wait out the whole render budget for a
    // renderer that is already gone.
    mocks.imageAsset.findMany.mockResolvedValue([]);
    mocks.generateImageBytes.mockRejectedValue(new Error("Image generation failed: 503 from both providers"));

    await expect(ensureCharacterReferenceAssets(baseOptions())).rejects.toThrow(/503/);

    const released = mocks.executeRawUnsafe.mock.calls.filter(([sql]) =>
      String(sql).includes('SET "characterReferenceLeaseToken" = NULL')
    );
    expect(released).toHaveLength(1);
    // And nothing was committed: no second transaction, no settlement.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
  });

  it("waits for the caller holding the lease instead of rendering the cast again", async () => {
    vi.useFakeTimers();
    try {
      mocks.imageAsset.findMany
        .mockResolvedValueOnce([]) // pre-lock check
        .mockResolvedValueOnce([]) // under the lock: still nothing, and the lease is taken
        .mockResolvedValue([assetRow("Ada"), assetRow("Beatrice")]); // the winner's set, one poll later
      // The compare-and-set matches nothing and the plan version is still
      // there: somebody else is rendering.
      mocks.queryRawUnsafe.mockResolvedValue([]);
      mocks.planVersion.findUnique.mockResolvedValue({ id: "plan-1", characterReferenceRefusals: null });

      const pending = ensureCharacterReferenceAssets(baseOptions());
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;

      expect(result).toHaveLength(2);
      expect(mocks.generateImageBytes).not.toHaveBeenCalled();
      expect(mocks.imageAsset.create).not.toHaveBeenCalled();
      // The claim, and nothing after it: the wait is a poll, so a loser no
      // longer sits inside `pg_advisory_xact_lock` for the winner's whole
      // render holding a pooled connection open.
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not regenerate when a concurrent caller already finished after acquiring the lock", async () => {
    // First (unlocked) read sees an incomplete set — the race window this
    // whole guard exists for — but by the time this caller wins the advisory
    // lock, a concurrent sibling has already committed the full set.
    mocks.imageAsset.findMany
      .mockResolvedValueOnce([]) // pre-lock check
      .mockResolvedValueOnce([assetRow("Ada"), assetRow("Beatrice")]); // post-lock re-check

    const result = await ensureCharacterReferenceAssets(baseOptions());

    // The claim transaction is the whole of it: nothing to render, nothing to
    // commit, no lease taken.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.imageAsset.create).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it("clears its own plan's partial set before regenerating", async () => {
    mocks.imageAsset.findMany.mockResolvedValue([assetRow("Ada")]);
    // Ada already exists, but Beatrice is new: the set is still incomplete on
    // both the pre- and post-lock reads.

    await ensureCharacterReferenceAssets(baseOptions());

    expect(mocks.imageAsset.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["asset-Ada"] } } });
    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
  });

  it("leaves an earlier plan version's sheets standing while it replaces its own", async () => {
    // The delete used to name `{ projectId, type }`, so replacing this plan's
    // partial set took every other plan version's committed sheets with it —
    // rows this transaction never read and does not replace, and which
    // `characters.ts` and `applyImageInsertion.ts` both read on purpose.
    const supersededSheet = { ...assetRow("Ada"), id: "asset-plan-0-Ada", metadata: { planId: "plan-0", characterName: "Ada" } };
    mocks.imageAsset.findMany.mockResolvedValue([supersededSheet, assetRow("Ada")]);

    await ensureCharacterReferenceAssets(baseOptions());

    expect(mocks.imageAsset.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: "project-1" }) })
    );
    const deletedIds = mocks.imageAsset.deleteMany.mock.calls.flatMap(([args]) => args.where.id?.in ?? []);
    expect(deletedIds).toEqual(["asset-Ada"]);
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

  describe("a sheet the image providers refuse to draw", () => {
    const refusal = () =>
      Object.assign(new Error("gemini image model refused the prompt (IMAGE_SAFETY)."), {
        imageContentRefused: true,
        reason: "IMAGE_SAFETY"
      });

    it("renders the rest of the cast and records the refusal instead of failing the book", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.imageAsset.findMany.mockResolvedValue([]);
      mocks.generateImageBytes.mockImplementation(async ({ prompt }: { prompt: string }) => {
        if (prompt.includes("Beatrice")) {
          throw refusal();
        }
        return { bytes: Buffer.from(""), mimeType: "image/png", provider: "fake", model: "fake" };
      });
      mocks.buildCharacterReferencePrompt.mockImplementation(
        ({ character }: { character: { name: string } }) => `draw ${character.name}`
      );

      const lockHeldWhileSettling: number[] = [];
      mocks.planVersion.updateMany.mockImplementation(() => {
        lockHeldWhileSettling.push(openTransactions);
        return { count: 1 };
      });

      const result = await ensureCharacterReferenceAssets(baseOptions());

      expect(result).toHaveLength(1);
      expect(mocks.imageAsset.create).toHaveBeenCalledTimes(1);
      expect(mocks.planVersion.updateMany).toHaveBeenCalledWith({
        where: { id: "plan-1" },
        data: { characterReferenceRefusals: [{ name: "Beatrice", reason: "IMAGE_SAFETY" }] }
      });
      // A settlement without the sheets re-renders nothing and sheets without it
      // rebuild the cast per page: the two still land in one transaction, under
      // the lock, and the skip below may not move that write out of it.
      expect(lockHeldWhileSettling).toEqual([1]);
      consoleWarn.mockRestore();
    });

    it("does not re-render the cast for the next caller, because the set is settled", async () => {
      mocks.imageAsset.findMany.mockResolvedValue([assetRow("Ada")]);
      mocks.planVersion.findUnique.mockResolvedValue({
        characterReferenceRefusals: [{ name: "Beatrice", reason: "IMAGE_SAFETY" }]
      });

      const result = await ensureCharacterReferenceAssets(baseOptions());

      expect(result).toHaveLength(1);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    });

    it("settles a cast whose plan names carry stray whitespace", async () => {
      // Both stored sides trim on the way out and the plan side did not, so a padded
      // planner name answered nothing — sheet or refusal — and the cast redrew per page.
      const padded = { characters: [{ name: "Ada " }, { name: "Beatrice " }] } as never;
      mocks.imageAsset.findMany.mockResolvedValue([assetRow("Ada ")]);
      mocks.planVersion.findUnique.mockResolvedValue({ characterReferenceRefusals: [{ name: "Beatrice ", reason: "IMAGE_SAFETY" }] });

      await ensureCharacterReferenceAssets({ ...(baseOptions() as object), plan: padded } as never);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    });

    it("clears a stale settlement when a later pass draws everyone", async () => {
      mocks.imageAsset.findMany.mockResolvedValue([]);
      mocks.planVersion.findUnique.mockResolvedValue({
        characterReferenceRefusals: [{ name: "Beatrice", reason: "IMAGE_SAFETY" }]
      });

      await ensureCharacterReferenceAssets(baseOptions());

      expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
      expect(mocks.planVersion.updateMany).toHaveBeenCalledWith({
        where: { id: "plan-1" },
        data: { characterReferenceRefusals: "DbNull" }
      });
    });

    it("still fails the book for an outage, which is not a verdict about this prompt", async () => {
      mocks.imageAsset.findMany.mockResolvedValue([]);
      mocks.generateImageBytes.mockRejectedValue(new Error("Image generation failed: 503 from both providers"));

      await expect(ensureCharacterReferenceAssets(baseOptions())).rejects.toThrow(/503/);
      expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("the settlement write", () => {
    const refusalFor = (name: string) =>
      Object.assign(new Error(`the image model refused ${name}`), {
        imageContentRefused: true,
        reason: "IMAGE_SAFETY"
      });
    const refuse = (...names: string[]) => {
      mocks.buildCharacterReferencePrompt.mockImplementation(
        ({ character }: { character: { name: string } }) => `draw ${character.name}`
      );
      mocks.generateImageBytes.mockImplementation(async ({ prompt }: { prompt: string }) => {
        const refused = names.find((name) => prompt.includes(name));
        if (refused) {
          throw refusalFor(refused);
        }
        return { bytes: Buffer.from(""), mimeType: "image/png", provider: "fake", model: "fake" };
      });
    };

    it("leaves the plan version alone when the pass refuses nobody and nothing was recorded", async () => {
      // The ordinary pass: every character drawn, against a column already NULL.
      // `DbNull` over NULL is a row version, a WAL record and a dead tuple on
      // `PlanVersion` for no change, inside the transaction holding the lock
      // every other image job of this book claims through.
      mocks.imageAsset.findMany.mockResolvedValue([]);

      const result = await ensureCharacterReferenceAssets(baseOptions());

      expect(result).toHaveLength(2);
      expect(mocks.imageAsset.create).toHaveBeenCalledTimes(2);
      expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
    });

    it("leaves it alone when the pass reproduces exactly the refusals already recorded", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Ada has no sheet, so the set is unsettled and the pass runs — but its
      // answer for the cast is the one the row already holds.
      mocks.imageAsset.findMany.mockResolvedValue([]);
      mocks.planVersion.findUnique.mockResolvedValue({
        characterReferenceRefusals: [{ name: "Beatrice", reason: "IMAGE_SAFETY" }]
      });
      refuse("Beatrice");

      await ensureCharacterReferenceAssets(baseOptions());

      expect(mocks.imageAsset.create).toHaveBeenCalledTimes(1);
      expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it("compares the answer as a set, because the render pool decides the order", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Three render concurrently, so which refused name lands first is whichever
      // render lost the race — never a fact about the cast.
      const trio = {
        characters: [
          { name: "Ada", role: "protagonist", description: "", traits: [], visualRules: [] },
          { name: "Beatrice", role: "sidekick", description: "", traits: [], visualRules: [] },
          { name: "Cyrus", role: "rival", description: "", traits: [], visualRules: [] }
        ]
      };
      mocks.imageAsset.findMany.mockResolvedValue([]);
      mocks.planVersion.findUnique.mockResolvedValue({
        characterReferenceRefusals: [
          { name: "Cyrus", reason: "IMAGE_SAFETY" },
          { name: "Beatrice", reason: "IMAGE_SAFETY" }
        ]
      });
      refuse("Beatrice", "Cyrus");

      await ensureCharacterReferenceAssets({ ...(baseOptions() as object), plan: trio } as never);

      expect(mocks.imageAsset.create).toHaveBeenCalledTimes(1);
      expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    it("writes when the pass refuses somebody the row does not name", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.imageAsset.findMany.mockResolvedValue([]);
      mocks.planVersion.findUnique.mockResolvedValue({
        characterReferenceRefusals: [{ name: "Beatrice", reason: "IMAGE_SAFETY" }]
      });
      refuse("Ada");

      await ensureCharacterReferenceAssets(baseOptions());

      expect(mocks.planVersion.updateMany).toHaveBeenCalledWith({
        where: { id: "plan-1" },
        data: { characterReferenceRefusals: [{ name: "Ada", reason: "IMAGE_SAFETY" }] }
      });
      consoleWarn.mockRestore();
    });
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
