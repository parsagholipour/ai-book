import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A short book's sheet cast, decided once from its draft and read back by every
 * caller. `characterReferences.test.ts` is the pass itself with no decision on
 * the row — today's whole cast — and every test there still describes a NULL
 * column; these are the decision's writes and reads around that pass.
 */

const mocks = vi.hoisted(() => ({
  imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  planVersion: { findUnique: vi.fn(), updateMany: vi.fn() },
  executeRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  executeRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  characterReferenceCast: vi.fn(),
  characterReferenceCastFromDraft: vi.fn(),
  generateImageBytes: vi.fn(),
  put: vi.fn()
}));

const tx = {
  imageAsset: mocks.imageAsset,
  planVersion: mocks.planVersion,
  $executeRaw: mocks.executeRaw,
  $queryRawUnsafe: mocks.queryRawUnsafe,
  $executeRawUnsafe: mocks.executeRawUnsafe
};

vi.mock("@book-maker/db", () => ({
  prisma: {
    imageAsset: mocks.imageAsset,
    planVersion: mocks.planVersion,
    project: { findUnique: async () => ({ userId: "user-1" }) },
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $executeRawUnsafe: mocks.executeRawUnsafe
  },
  Prisma: { DbNull: "DbNull" }
}));
vi.mock("../runtime/config.js", () => ({ config: { BOOK_STORAGE_DIR: "/tmp/books", PUBLIC_API_URL: "http://api.test" } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: vi.fn(), assertJobNotStopped: async () => undefined }));
vi.mock("./bookHelpers.js", () => ({ imageGenerationMetadata: () => ({}), imageStorageMetadata: () => ({}) }));
vi.mock("@book-maker/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@book-maker/storage")>();
  return { ...actual, appendRunLog: vi.fn(), objectStore: () => ({ put: mocks.put, head: async () => null }) };
});
vi.mock("@book-maker/core", () => ({
  shouldGenerateCharacterReferences: () => true,
  characterReferenceCast: mocks.characterReferenceCast,
  characterReferenceCastFromDraft: mocks.characterReferenceCastFromDraft,
  shouldUseCharacterReferenceImages: () => true,
  buildCharacterReferencePrompt: () => "a prompt",
  optimizeImageForStorage: async () => ({ bytes: Buffer.from(""), extension: "png" }),
  publicAssetUrl: (_base: string, path: string) => `http://api.test${path}`,
  libraryCharactersFromMediaSettings: () => [],
  matchLibraryCharacter: () => null,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  isImageContentRefusalError: () => false,
  imageRefusalReason: () => "refused",
  safePathPart: (value: string) => value,
  foldCharacterName: (value: string) => value.trim().toLowerCase(),
  characterReferenceSeedInstruction: (source: string) => `seed:${source}`,
  imageAdapterCapabilities: (image: { capabilities: () => unknown }) => image.capabilities()
}));

import {
  castForCharacterReferenceDecision,
  parseCharacterReferenceCastDecision,
  recordCharacterReferenceCastDecision
} from "./characterReferenceCastDecision.js";
import { ensureCharacterReferenceAssets } from "./characterReferences.js";

const character = (name: string) => ({ name, role: "r", description: "", traits: [], visualRules: [] });
const plan = { characters: [character("Ada"), character("Beatrice"), character("Cyril")] } as never;
const ada = [character("Ada")];

const shouldIllustratePage = vi.fn(() => true);
const draftPages = [
  { index: 1, imagePrompt: "Ada at the well." },
  { index: 2, imagePrompt: "Ada and Beatrice." }
];

const assetRow = (characterName: string) => ({
  id: `asset-${characterName}`,
  path: `/assets/images/project-1/character-reference-${characterName.toLowerCase()}.png`,
  metadata: { planId: "plan-1", characterName }
});

const options = (extra: Record<string, unknown> = {}) =>
  ({
    projectId: "project-1",
    planId: "plan-1",
    input: { mediaSettings: { fullIllustrations: true } },
    plan,
    providers: { image: { capabilities: () => ({ supportsReferenceImages: true, maxReferenceImages: 3 }) } },
    strategy: { generateImageBytes: mocks.generateImageBytes, shouldIllustratePage },
    generationJobId: "gj-1",
    ...extra
  }) as never;

/** What the plan version row holds: the refusals and, when decided, the cast. */
const planRow = (characterReferenceCast: unknown) => ({ id: "plan-1", characterReferenceRefusals: null, characterReferenceCast });

const drawnNames = () =>
  mocks.imageAsset.create.mock.calls.map(([{ data }]) => (data as { metadata: { characterName: string } }).metadata.characterName);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.characterReferenceCast.mockImplementation((_input: unknown, castPlan: { characters: unknown[] }) => castPlan.characters);
  mocks.characterReferenceCastFromDraft.mockReturnValue(ada);
  mocks.generateImageBytes.mockResolvedValue({ bytes: Buffer.from(""), mimeType: "image/png", provider: "fake", model: "fake" });
  mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
  // An uncontended claim: the compare-and-set takes the lease and hands back its expiry.
  mocks.executeRaw.mockResolvedValue(1);
  mocks.queryRawUnsafe.mockResolvedValue([{ characterReferenceLeaseExpiresAt: new Date(Date.now() + 60_000) }]);
  mocks.executeRawUnsafe.mockResolvedValue(1);
  mocks.imageAsset.findMany.mockResolvedValue([]);
  mocks.planVersion.findUnique.mockResolvedValue(planRow(null));
  mocks.planVersion.updateMany.mockResolvedValue({ count: 1 });
  mocks.imageAsset.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: `asset-${(data.metadata as { characterName: string }).characterName}`,
    path: data.path,
    metadata: data.metadata
  }));
});

describe("the stored cast decision", () => {
  it("reads NULL and any other non-array as no decision, and keeps an empty one", () => {
    expect(parseCharacterReferenceCastDecision(null)).toBeUndefined();
    expect(parseCharacterReferenceCastDecision(undefined)).toBeUndefined();
    expect(parseCharacterReferenceCastDecision({ names: ["Ada"] })).toBeUndefined();
    expect(parseCharacterReferenceCastDecision([])).toEqual([]);
    expect(parseCharacterReferenceCastDecision([" Ada ", 3, "", "Beatrice"])).toEqual(["Ada", "Beatrice"]);
  });

  it("narrows today's cast in plan order, drops a name nobody has, and never adds one", () => {
    const cast = [character("Ada"), character("Beatrice"), character("Cyril")];
    expect(castForCharacterReferenceDecision(cast, undefined).map((entry) => entry.name)).toEqual(["Ada", "Beatrice", "Cyril"]);
    expect(castForCharacterReferenceDecision(cast, ["cyril", "Zed", "Ada"]).map((entry) => entry.name)).toEqual(["Ada", "Cyril"]);
    expect(castForCharacterReferenceDecision(cast.slice(0, 1), ["Beatrice"])).toEqual([]);
    expect(castForCharacterReferenceDecision(cast, [])).toEqual([]);
  });

  it("writes the draft's answer only where the column is still NULL, asking the strategy which pages are drawn", async () => {
    await recordCharacterReferenceCastDecision({ planId: "plan-1", input: {} as never, plan, strategy: { shouldIllustratePage }, pages: draftPages });
    expect(mocks.characterReferenceCastFromDraft).toHaveBeenCalledWith({}, plan, draftPages, shouldIllustratePage);
    expect(mocks.planVersion.updateMany).toHaveBeenCalledWith({
      where: { id: "plan-1", characterReferenceCast: { equals: "DbNull" } },
      data: { characterReferenceCast: ["Ada"] }
    });
  });

  it("stores an empty decision as an empty array, and nothing when there is nothing to decide", async () => {
    mocks.characterReferenceCastFromDraft.mockReturnValueOnce([]);
    await recordCharacterReferenceCastDecision({ planId: "plan-1", input: {} as never, plan, strategy: { shouldIllustratePage }, pages: [] });
    expect(mocks.planVersion.updateMany.mock.calls[0]![0].data).toEqual({ characterReferenceCast: [] });

    mocks.characterReferenceCastFromDraft.mockReturnValueOnce(undefined);
    await recordCharacterReferenceCastDecision({ planId: "plan-1", input: {} as never, plan, strategy: { shouldIllustratePage }, pages: [] });
    expect(mocks.planVersion.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("ensureCharacterReferenceAssets with a cast decision", () => {
  it("decides before it reads, then draws only the cast the row holds", async () => {
    mocks.planVersion.updateMany.mockImplementation(async () => {
      mocks.planVersion.findUnique.mockResolvedValue(planRow(["Ada"]));
      return { count: 1 };
    });

    const result = await ensureCharacterReferenceAssets(options({ decideCastFromDraft: draftPages }));

    expect(mocks.planVersion.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.planVersion.findUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(1);
    expect(drawnNames()).toEqual(["Ada"]);
    expect(result).toHaveLength(1);
  });

  it("reuses the stored answer on a resumed run instead of deciding again", async () => {
    // The first run's decision is on the row; this draft would now say Ada, and
    // the compare-and-set finds nothing NULL to write.
    mocks.planVersion.updateMany.mockResolvedValue({ count: 0 });
    mocks.planVersion.findUnique.mockResolvedValue(planRow(["Beatrice"]));

    await ensureCharacterReferenceAssets(options({ decideCastFromDraft: draftPages }));

    expect(drawnNames()).toEqual(["Beatrice"]);
  });

  it("lets a page job read the decision and settle on its sheets without drawing anyone outside it", async () => {
    mocks.planVersion.findUnique.mockResolvedValue(planRow(["Ada"]));
    mocks.imageAsset.findMany.mockResolvedValue([assetRow("Ada")]);

    const result = await ensureCharacterReferenceAssets(options());

    expect(result.map((asset) => asset.id)).toEqual(["asset-Ada"]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
    expect(mocks.characterReferenceCastFromDraft).not.toHaveBeenCalled();
  });

  it("draws nothing at all for an empty decision", async () => {
    mocks.planVersion.findUnique.mockResolvedValue(planRow([]));

    expect(await ensureCharacterReferenceAssets(options())).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
  });

  it("takes the cast from the read under the lock when the decision landed after the fast check", async () => {
    // The fast check saw NULL; by the claim the short-book pass had decided.
    mocks.planVersion.findUnique.mockResolvedValueOnce(planRow(null)).mockResolvedValue(planRow(["Cyril"]));

    await ensureCharacterReferenceAssets(options());

    expect(drawnNames()).toEqual(["Cyril"]);
  });

  it("keeps today's whole cast where nothing was decided", async () => {
    await ensureCharacterReferenceAssets(options());

    expect(mocks.planVersion.findUnique.mock.calls[0]![0]).toMatchObject({
      select: { characterReferenceRefusals: true, characterReferenceCast: true }
    });
    expect(drawnNames()).toEqual(["Ada", "Beatrice", "Cyril"]);
    expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
  });

  it("decides nothing and reads nothing for a book with no cast to draw", async () => {
    mocks.characterReferenceCast.mockReturnValue([]);

    expect(await ensureCharacterReferenceAssets(options({ decideCastFromDraft: draftPages }))).toEqual([]);
    expect(mocks.planVersion.updateMany).not.toHaveBeenCalled();
    expect(mocks.planVersion.findUnique).not.toHaveBeenCalled();
  });
});
