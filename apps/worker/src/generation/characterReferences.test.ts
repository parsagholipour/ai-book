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
  writeFile: vi.fn()
}));

type FakeTx = { imageAsset: typeof mocks.imageAsset; $executeRaw: typeof mocks.executeRaw };
const tx: FakeTx = { imageAsset: mocks.imageAsset, $executeRaw: mocks.executeRaw };

vi.mock("@book-maker/db", () => ({
  prisma: { imageAsset: mocks.imageAsset, $transaction: mocks.transaction },
  Prisma: {}
}));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/tmp/images", PUBLIC_API_URL: "http://api.test" }
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ updateJobProgress: mocks.updateJobProgress }));
vi.mock("./bookHelpers.js", () => ({
  imageGenerationMetadata: () => ({}),
  imageStorageMetadata: () => ({})
}));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile }));
vi.mock("@book-maker/core", () => ({
  shouldGenerateCharacterReferences: mocks.shouldGenerateCharacterReferences,
  shouldUseCharacterReferenceImages: mocks.shouldUseCharacterReferenceImages,
  buildCharacterReferencePrompt: mocks.buildCharacterReferencePrompt,
  optimizeImageForStorage: mocks.optimizeImageForStorage,
  publicAssetUrl: mocks.publicAssetUrl,
  selectCharacterReferenceAssets: vi.fn().mockReturnValue([])
}));

import { ensureCharacterReferenceAssets } from "./characterReferences.js";

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
});
