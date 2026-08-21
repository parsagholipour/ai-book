import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  imageStorageDir: "",
  prisma: {
    libraryCharacter: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    libraryCharacterImage: { create: vi.fn(), delete: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() }
  },
  advanceJobStep: vi.fn(),
  createLoggedProviders: vi.fn(),
  createProviders: vi.fn(),
  optimizeImageForStorage: vi.fn(),
  generateImageBytes: vi.fn(),
  strategyForInput: vi.fn()
}));
mocks.imageStorageDir = mkdtempSync(join(tmpdir(), "book-maker-portrait-test-"));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma }));
// A getter, not a value: the factory runs before this module's body assigns
// the temp dir, so a plain property would freeze the empty string.
vi.mock("../runtime/config.js", () => ({
  config: {
    get IMAGE_STORAGE_DIR() {
      return mocks.imageStorageDir;
    }
  }
}));
vi.mock("../runtime/jobLifecycle.js", () => ({ advanceJobStep: mocks.advanceJobStep }));
vi.mock("../providers/loggedAdapters.js", () => ({ createLoggedProviders: mocks.createLoggedProviders }));
vi.mock("../generation/bookHelpers.js", () => ({ strategyForInput: mocks.strategyForInput }));
vi.mock("@book-maker/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@book-maker/core")>();
  return {
    ...actual,
    createProviders: mocks.createProviders,
    optimizeImageForStorage: mocks.optimizeImageForStorage
  };
});

import { generateCharacterPortrait } from "./characterPortrait.js";

const characterRow = (overrides: Record<string, unknown> = {}) => ({
  id: "char-1",
  userId: "user-1",
  name: "Luna",
  description: "A brave night-flying rabbit.",
  fields: [{ key: "Age", value: "9" }],
  photoPath: null,
  portraitPath: null,
  portraitStatus: "QUEUED",
  portraitError: null,
  portraitJobId: "gen-1",
  ...overrides
});

const job = { data: { generationJobId: "gen-1", libraryCharacterId: "char-1", userId: "user-1" } } as never;

/** The tokenised name this run minted, read back off the row it wrote first. */
const storedFileName = () =>
  (mocks.prisma.libraryCharacterImage.create.mock.calls[0]![0].data as { fileName: string }).fileName;

/**
 * The compare-and-set that installs the reference, as opposed to the one at
 * the top of the handler that only claims GENERATING.
 */
const referenceWrite = () =>
  mocks.prisma.libraryCharacter.updateMany.mock.calls
    .map((call) => call[0].data as Record<string, unknown>)
    .find((data) => data.portraitStatus === "READY") ?? null;

describe("generateCharacterPortrait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(characterRow());
    mocks.prisma.libraryCharacter.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.libraryCharacter.update.mockResolvedValue(characterRow({ portraitStatus: "READY" }));
    mocks.createProviders.mockReturnValue({ image: {} });
    mocks.createLoggedProviders.mockImplementation((_job: unknown, providers: unknown) => providers);
    mocks.strategyForInput.mockReturnValue({ generateImageBytes: mocks.generateImageBytes });
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("rendered"),
      mimeType: "image/png",
      provider: "fake",
      model: "fake-image"
    });
    mocks.optimizeImageForStorage.mockResolvedValue({
      bytes: Buffer.from("optimized"),
      extension: "webp",
      outputBytes: 9,
      width: 512,
      height: 512
    });
    // The handler reads `imageRow.id` on its rollback path, and prunes off the
    // list; a bare `vi.fn()` would return undefined and blow up every test here.
    mocks.prisma.libraryCharacterImage.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({ id: "img-new", ...data })
    );
    mocks.prisma.libraryCharacterImage.findMany.mockResolvedValue([]);
    mocks.prisma.libraryCharacterImage.deleteMany.mockResolvedValue({ count: 0 });
  });
  afterAll(() => {
    rmSync(mocks.imageStorageDir, { recursive: true, force: true });
  });

  it("renders from the sheet alone, stores the portrait, and marks the row READY", async () => {
    await generateCharacterPortrait(job);

    const request = mocks.generateImageBytes.mock.calls[0]![0];
    expect(request.aspectRatio).toBe("1:1");
    expect(request.referenceImagePaths).toBeUndefined();
    expect(request.prompt).toContain("Luna");
    expect(request.prompt).not.toContain("reference photo");

    // The name carries a per-write token, so no two drawings of one character
    // can ever land on the same file.
    expect(storedFileName()).toMatch(/^char-1-portrait-[a-z0-9]{12}\.webp$/);
    const stored = readFileSync(join(mocks.imageStorageDir, "characters", "user-1", storedFileName()));
    expect(stored.toString()).toBe("optimized");
    // The row is written before the bytes: a file no row names is permanent,
    // because nothing sweeps this tree.
    expect(mocks.prisma.libraryCharacterImage.create.mock.calls[0]![0].data).toMatchObject({
      characterId: "char-1",
      userId: "user-1",
      source: "GENERATED",
      referenceEligible: true
    });
    expect(referenceWrite()).toEqual({
      portraitPath: storedFileName(),
      // A paid redraw claims the row even when it lands on an adopted
      // upload, so nothing downstream keeps calling it the user's own art.
      portraitSource: "GENERATED",
      portraitStatus: "READY",
      portraitError: null
    });
  });

  it("strips mention markers before the description reaches the prompt", async () => {
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRow({
        description: "Travels with @Bram.",
        // `targetKind` is what makes this a character, here and in every other
        // reader of these rows. The fixture used to leave it out and be read as
        // one anyway; a row with no kind is now read as nobody, and `findFirst`
        // runs under `libraryMentionInclude`, which always selects the column.
        outgoingMentions: [
          { targetKind: "CHARACTER", targetCharacterId: "char-2", targetCharacter: { id: "char-2", name: "Bram" } }
        ]
      })
    );

    await generateCharacterPortrait(job);

    const prompt = mocks.generateImageBytes.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("Travels with Bram.");
    expect(prompt).not.toContain("@Bram");
  });

  it("strips every marker once a mention row turns out to be unnameable", async () => {
    // The strip normally runs over the names the mention rows are bound to —
    // `libraryMentionNames`, not the cast. A LOCATION or OTHER row has no
    // target table and no join yet, and `LibraryMention_target_arc` forces its
    // `targetCharacterId` null, so it reaches the strip nameless. That used to
    // ride its `@` into the image prompt, where a model is about as likely to
    // draw it as visible text as to ignore it. `generationDescription` now
    // notices that a row cannot be named and strips every marker in the prose
    // instead of only the claimed spans, so the reader's own unbound `@Ghost`
    // loses its marker too — the documented cost of failing safe. Nothing
    // writes LOCATION or OTHER rows today; this pins the fallback, which stops
    // firing on its own once those joins land and the rows become nameable.
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRow({
        description: "Lives at @Harbor with @Bram, and carries @Sunfang.",
        outgoingMentions: [
          { targetKind: "LOCATION", targetCharacterId: null, targetCharacter: null },
          {
            targetKind: "CHARACTER",
            targetCharacterId: "char-2",
            targetCharacter: { id: "char-2", name: "Bram" }
          },
          { targetKind: "OTHER", targetCharacterId: null, targetCharacter: null }
        ]
      })
    );

    await generateCharacterPortrait(job);

    const prompt = mocks.generateImageBytes.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("Lives at Harbor with Bram, and carries Sunfang.");
    expect(prompt).not.toContain("@Harbor");
    expect(prompt).not.toContain("@Sunfang");
    expect(prompt).not.toContain("@Bram");
  });

  it("feeds the uploaded photo as the reference image when it exists on disk", async () => {
    const userDir = join(mocks.imageStorageDir, "characters", "user-1");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "char-1-photo.jpg"), "photo-bytes");
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(characterRow({ photoPath: "char-1-photo.jpg" }));

    await generateCharacterPortrait(job);

    const request = mocks.generateImageBytes.mock.calls[0]![0];
    expect(request.referenceImagePaths).toEqual([join(userDir, "char-1-photo.jpg")]);
    expect(request.prompt).toContain("reference photo");
  });

  it("draws from the sheet when the photo column points at a missing file", async () => {
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(characterRow({ photoPath: "char-1-photo.png" }));

    await generateCharacterPortrait(job);

    expect(mocks.generateImageBytes.mock.calls[0]![0].referenceImagePaths).toBeUndefined();
  });

  it("keeps the previous portrait instead of destroying it", async () => {
    // This used to `rm` the superseded file, which is what made a redraw
    // unrecoverable. It is a retained version now — one promote from being the
    // reference again.
    const userDir = join(mocks.imageStorageDir, "characters", "user-1");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "char-1-portrait-oldoldoldold.png"), "old-portrait");
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(
      characterRow({ portraitPath: "char-1-portrait-oldoldoldold.png" })
    );

    await generateCharacterPortrait(job);

    expect(existsSync(join(userDir, "char-1-portrait-oldoldoldold.png"))).toBe(true);
    expect(existsSync(join(userDir, storedFileName()))).toBe(true);
  });

  it("prunes past the retention limit, but never the picture a book draws from", async () => {
    const userDir = join(mocks.imageStorageDir, "characters", "user-1");
    mkdirSync(userDir, { recursive: true });
    const doomed = "char-1-portrait-prunemeprune.webp";
    writeFileSync(join(userDir, doomed), "ancient");
    const live = "char-1-portrait-keepmekeepme.webp";
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(characterRow({ portraitPath: live }));
    mocks.prisma.libraryCharacterImage.findMany.mockResolvedValue([
      ...Array.from({ length: 20 }, (_unused, index) => ({
        id: `img-${index}`,
        fileName: `char-1-portrait-recent${String(index).padStart(6, "0")}.webp`
      })),
      { id: "img-live", fileName: live },
      { id: "img-doomed", fileName: doomed }
    ]);

    await generateCharacterPortrait(job);

    expect(existsSync(join(userDir, doomed))).toBe(false);
    expect(mocks.prisma.libraryCharacterImage.deleteMany).toHaveBeenCalledWith({
      where: { id: "img-doomed", userId: "user-1" }
    });
    // The live pointer is exempt however old it is.
    expect(mocks.prisma.libraryCharacterImage.deleteMany).not.toHaveBeenCalledWith({
      where: { id: "img-live", userId: "user-1" }
    });
  });

  it("stands down without installing a reference when the claim was lost", async () => {
    // Another writer moved the row while this drawing was being rendered. The
    // drawing was paid for and stays in the history; it just does not become
    // the reference behind whoever won.
    mocks.prisma.libraryCharacter.updateMany.mockResolvedValue({ count: 0 });

    await generateCharacterPortrait(job);

    expect(mocks.prisma.libraryCharacterImage.create).toHaveBeenCalled();
    expect(existsSync(join(mocks.imageStorageDir, "characters", "user-1", storedFileName()))).toBe(true);
    expect(
      mocks.prisma.libraryCharacter.updateMany.mock.calls.every(
        (call) => (call[0].where as { portraitStatus?: unknown }).portraitStatus !== undefined
      )
    ).toBe(true);
  });

  it("throws when the character is gone, leaving settlement to the failure path", async () => {
    mocks.prisma.libraryCharacter.findFirst.mockResolvedValue(null);
    await expect(generateCharacterPortrait(job)).rejects.toThrow("no longer exists");
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
  });

  it("lets a render failure propagate so the job settles through markFailed", async () => {
    mocks.generateImageBytes.mockRejectedValue(new Error("image provider down"));
    await expect(generateCharacterPortrait(job)).rejects.toThrow("image provider down");
    expect(referenceWrite()).toBeNull();
    expect(mocks.prisma.libraryCharacterImage.create).not.toHaveBeenCalled();
  });
});
