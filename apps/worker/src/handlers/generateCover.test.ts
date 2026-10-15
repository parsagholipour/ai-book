import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const mocks = vi.hoisted(() => ({
  prisma: {
    imageAsset: {
      deleteMany: vi.fn(),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async (): Promise<{ metadata: unknown; prompt?: string; provider?: string } | null> => null),
      create: vi.fn()
    },
    project: { findUnique: vi.fn(async () => ({ currentPlanId: "plan-1", contentRevision: 6, status: "EDITING" })) },
    generationJob: { update: vi.fn(), findUnique: vi.fn(async () => ({
      projectId: "project-1", type: "GENERATE_IMAGE", status: "ACTIVE", contentRevision: 6,
      payload: { assetType: "COVER" }, message: null, error: null
    })) },
    planVersion: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn<(callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>>()
  },
  generateImageBytes: vi.fn(),
  renderCoverPng: vi.fn(async (_options: unknown) => Buffer.from("cover-png")),
  maybeEnqueueCompile: vi.fn(),
  advanceJobStep: vi.fn(),
  cancelStaleGenerationJob: vi.fn(),
  updateJobProgress: vi.fn(),
  writeFile: vi.fn(),
  selectCoverDesign: vi.fn(),
  ensureCharacterReferenceAssets: vi.fn(async () => []),
  appendCharacterReferenceRunLog: vi.fn(),
  refundCreditLedgerEntry: vi.fn()
}));

vi.mock("@book-maker/db", () => ({ prisma: mocks.prisma, Prisma: {} }));
vi.mock("@book-maker/db/billing", () => ({ refundCreditLedgerEntry: mocks.refundCreditLedgerEntry }));
vi.mock("../runtime/dispatch.js", () => ({ maybeEnqueueCompile: mocks.maybeEnqueueCompile }));
vi.mock("../runtime/jobLifecycle.js", () => ({
  advanceJobStep: mocks.advanceJobStep,
  cancelStaleGenerationJob: mocks.cancelStaleGenerationJob,
  updateJobProgress: mocks.updateJobProgress
}));
vi.mock("../runtime/config.js", () => ({ config: { IMAGE_STORAGE_DIR: "/tmp/images", PUBLIC_API_URL: "http://api.test" } }));
vi.mock("../providers/loggedAdapters.js", () => ({
  coverImageSelectionForInput: () => undefined,
  createImageAdapterForSelection: () => ({}),
  createLoggedProviders: () => ({ text: {}, image: {} })
}));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: mocks.writeFile }));
// The tolerant wrapper is the code under test on the reference-sheet path, so
// only the pass it wraps is mocked out.
vi.mock("../generation/characterReferences.js", () => ({
  characterReferencePromptInstruction: () => "",
  ensureCharacterReferenceAssets: mocks.ensureCharacterReferenceAssets,
  selectCoverReferenceImagePaths: async () => ({ paths: [], libraryFaceNames: [] })
}));
vi.mock("../generation/characterReferenceRunLog.js", () => ({
  appendCharacterReferenceRunLog: mocks.appendCharacterReferenceRunLog
}));
vi.mock("../generation/bookHelpers.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/bookHelpers.js")>("../generation/bookHelpers.js");
  return {
    ...actual,
    getProjectOrThrow: async (id: string) => ({ id, title: "A Test Book", authorName: "A. Reader" }),
    strategyForInput: () => ({ generateImageBytes: mocks.generateImageBytes }),
    coverMetadataFromProject: () => ({ title: "A Test Book", authorName: "A. Reader" })
  };
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    createProviders: () => ({}),
    bookPlanSchema: { parse: () => ({ characters: [], premise: "p", audience: "a", illustrationPlan: {} }) },
    renderCoverPng: mocks.renderCoverPng,
    optimizeImageForStorage: async ({ bytes }: { bytes: Buffer }) => ({ bytes, extension: "jpg", contentType: "image/jpeg" }),
    selectCoverDesign: mocks.selectCoverDesign
  };
});

import { COVER_RETYPESET, coverDesign } from "@book-maker/core";
import { objectKey, objectStore } from "@book-maker/storage";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { BUNDLED_COVER_PROVIDER, coverTemplateOverrideForDesign, generateCover } from "./generateCover.js";

function job(): Job {
  return { data: { projectId: "project-1", planId: "plan-1", generationJobId: "gen-1" } } as unknown as Job;
}

function planVersion(mediaSettings: Record<string, unknown>) {
  return {
    planningPackage: {},
    inputSnapshot: {
      prompt: "A book about paying attention that is long enough to parse.",
      category: "STORY",
      targetPages: 10,
      mediaSettings: { fullIllustrations: false, illustrationCadence: "manual", toneProfile: "neutral", ...mediaSettings }
    }
  };
}

function storedAsset() {
  const call = mocks.prisma.imageAsset.create.mock.calls[0]?.[0] as
    | { data: { provider: string; prompt: string; metadata: Record<string, unknown> } }
    | undefined;
  return call?.data;
}

describe("generateCover", () => {
  beforeEach(() => {
    mocks.selectCoverDesign.mockResolvedValue({ design: coverDesign("moonlit-sea"), selectedBy: "model" });
    mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.prisma));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a bundled design without calling an image model", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: false, coverArtSource: "design" }));

    await generateCover(job());

    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    const asset = storedAsset();
    expect(asset?.provider).toBe(BUNDLED_COVER_PROVIDER);
    expect(asset?.prompt).toContain("Moonlit Sea");
    expect(asset?.metadata).toMatchObject({
      coverArtSource: "design",
      coverDesignId: "moonlit-sea",
      coverDesignSelectedBy: "model",
      // Free work, and saying so keeps it out of the Costs tab's unpriced bucket.
      costUsd: 0
    });
  });

  // A Studio publish that changes the title or byline queues a revision-owned
  // cover job over a book that already wears one: the typography moves, the
  // artwork the reader kept does not.
  it("re-typesets the design a book already wears when the cover job is revision-owned", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ coverArtSource: "design" }));
    mocks.prisma.imageAsset.findFirst.mockResolvedValueOnce({
      metadata: { coverArtSource: "design", coverDesignId: "moonlit-sea" }
    });
    const revisionOwned = {
      data: { ...job().data, assetType: "COVER", contentRevision: 6, exportPublicationProjectStatus: "EDITING" }
    } as unknown as Job;

    await generateCover(revisionOwned);

    expect(mocks.selectCoverDesign).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
    expect(storedAsset()?.metadata).toMatchObject({ coverDesignId: "moonlit-sea", coverDesignSelectedBy: "kept", costUsd: 0 });
  });

  it("chooses a design for a revision-owned first cover, and for any other job even when one exists", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ coverArtSource: "design" }));
    const revisionOwned = {
      data: { ...job().data, assetType: "COVER", contentRevision: 6, exportPublicationProjectStatus: "EDITING" }
    } as unknown as Job;

    await generateCover(revisionOwned);
    expect(mocks.selectCoverDesign).toHaveBeenCalledTimes(1);

    // The operator's regenerate route asks for a fresh pick, and is not revision-owned:
    // it never even looks at the cover it replaces.
    mocks.prisma.imageAsset.findFirst.mockClear();
    await generateCover(job());
    expect(mocks.prisma.imageAsset.findFirst).not.toHaveBeenCalled();
    expect(mocks.selectCoverDesign).toHaveBeenCalledTimes(2);
  });

  it("gives a designed cover its own typography rather than the book type's", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(
      planVersion({ includeCover: false, coverArtSource: "design", coverTemplate: "business" })
    );

    await generateCover(job());

    const [render] = mocks.renderCoverPng.mock.calls[0] as [{ template?: { id: string } }];
    expect(render?.template?.id).toBe("fiction");
  });

  it("finishes the book with a designed cover when every image provider fails", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));

    await generateCover(job());

    const asset = storedAsset();
    expect(asset?.provider).toBe(BUNDLED_COVER_PROVIDER);
    expect(asset?.metadata).toMatchObject({ coverArtSource: "design", coverFallbackReason: "ai_cover_failed" });
    // The book is written and paid for; failing here would refund the whole
    // run. The compile itself fires from maybeCompileAfterCompletedJob once
    // this job's row is COMPLETED — the handler finishing cleanly is the point.
  });

  // The Writing Studio's "Generate with AI" sells the artwork on its own, so a
  // design in its place is not what was paid for.
  it("refunds a purchased AI cover whose artwork falls back to a design", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true, coverArtSource: "ai" }));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));
    const purchase = {
      data: { ...job().data, assetType: "COVER", coverPurchase: true, billingLedgerEntryId: "ledger-cover" }
    } as unknown as Job;

    await generateCover(purchase);

    expect(storedAsset()?.metadata).toMatchObject({
      coverArtSource: "design",
      coverFallbackReason: "ai_cover_failed",
      coverPurchaseRefunded: true
    });
    expect(mocks.refundCreditLedgerEntry).toHaveBeenCalledWith("ledger-cover", expect.stringContaining("designed cover"));
  });

  it("hands an unpublished purchase to stale cancellation after its revision is superseded", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true, coverArtSource: "ai" }));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));
    mocks.prisma.project.findUnique.mockResolvedValueOnce({ currentPlanId: "plan-1", contentRevision: 7, status: "EDITING" });
    const purchase = {
      name: "generate-image",
      data: {
        ...job().data, assetType: "COVER", contentRevision: 6, exportPublicationProjectStatus: "EDITING",
        coverPurchase: true, attemptId: "attempt-cover", billingLedgerEntryId: "ledger-cover"
      }
    } as unknown as Job;

    await generateCover(purchase);

    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.cancelStaleGenerationJob).toHaveBeenCalledWith(purchase, expect.any(String));
    // Stale cancellation settles the purchase's attempt, not the fallback
    // refund for a design that was actually delivered.
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("leaves a completed cover delivery and its purchase settlement alone", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true, coverArtSource: "ai" }));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));
    mocks.prisma.generationJob.findUnique.mockResolvedValueOnce({
      projectId: "project-1", type: "GENERATE_IMAGE", status: "COMPLETED", contentRevision: 6,
      payload: { assetType: "COVER" }, message: null, error: null
    });

    await generateCover({ data: { ...job().data, assetType: "COVER", coverPurchase: true, billingLedgerEntryId: "ledger-cover" } } as Job);

    expect(mocks.prisma.imageAsset.deleteMany).not.toHaveBeenCalled();
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.cancelStaleGenerationJob).not.toHaveBeenCalled();
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("fails the job rather than completing a purchase whose refund could not be written", async () => {
    // Completing would commit the purchase's attempt over a design nobody paid
    // for; failing hands the refund to the attempt, and a failed Studio cover
    // never fails the book — the design just stored still prints.
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true, coverArtSource: "ai" }));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));
    mocks.refundCreditLedgerEntry.mockRejectedValueOnce(new Error("ledger unavailable"));
    const purchase = {
      data: {
        ...job().data,
        assetType: "COVER",
        contentRevision: 6,
        exportPublicationProjectStatus: "EDITING",
        coverPurchase: true,
        billingLedgerEntryId: "ledger-cover"
      }
    } as unknown as Job;

    await expect(generateCover(purchase)).rejects.toThrow("ledger unavailable");
    expect(storedAsset()?.metadata).toMatchObject({ coverArtSource: "design", coverPurchaseRefunded: true });
  });

  it("keeps the charge for a purchased AI cover that was drawn, and never refunds a book's own cover", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true, coverArtSource: "ai" }));
    mocks.generateImageBytes.mockResolvedValueOnce({ bytes: Buffer.from("art"), mimeType: "image/png", provider: "gemini", model: "m" });
    const purchase = {
      data: { ...job().data, assetType: "COVER", coverPurchase: true, billingLedgerEntryId: "ledger-cover" }
    } as unknown as Job;

    await generateCover(purchase);
    expect(storedAsset()?.metadata).toMatchObject({ coverArtSource: "ai" });

    // A cover that came with the book falls back without any refund of its own.
    mocks.generateImageBytes.mockRejectedValueOnce(new Error("all image providers failed"));
    await generateCover(job());
    expect(mocks.refundCreditLedgerEntry).not.toHaveBeenCalled();
  });

  it("still surfaces a user stop instead of quietly producing a design", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockRejectedValue(new StopRequestedError());

    await expect(generateCover(job())).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
  });

  it("hands the stop predicate to the design selection so a stop there surfaces too", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: false, coverArtSource: "design" }));
    mocks.selectCoverDesign.mockImplementation(async (options: { bailOnError?: (error: unknown) => boolean }) => {
      // The real selectCoverDesign re-throws errors this predicate claims; a
      // selection wired without it swallowed the stop and compiled the book.
      const stop = new StopRequestedError();
      expect(options.bailOnError?.(stop)).toBe(true);
      throw stop;
    });

    await expect(generateCover(job())).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueCompile).not.toHaveBeenCalled();
  });

  it("stores the model's artwork when it succeeds", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("art"),
      mimeType: "image/png",
      provider: "gemini",
      model: "gemini-3-pro-image"
    });

    await generateCover(job());

    const asset = storedAsset();
    expect(asset?.provider).toBe("gemini");
    expect(asset?.metadata).toMatchObject({ coverArtSource: "ai", sourceImageModel: "gemini-3-pro-image" });
    expect(mocks.selectCoverDesign).not.toHaveBeenCalled();
    // The picture is kept beside the cover it became, and the cover says what it was set with.
    const artworkKey = String(asset?.metadata.artworkObjectKey);
    expect(artworkKey).toMatch(/^images\/project-1\/cover-art-[\da-f-]+\.jpg$/);
    expect(asset?.metadata).toMatchObject({
      artworkObjectKey: artworkKey,
      typeset: { title: "A Test Book", subtitle: "", authorName: "A. Reader" }
    });
    expect((await objectStore().get(artworkKey))?.toString()).toBe("art");
  });

  // `ensureCharacterReferenceAssets` sits ~70 lines above the artwork guard, and
  // since the render lease split it into two interactive transactions with a
  // 10s `maxWait`, a P2024 pool timeout is an expected outcome of
  // `MAX_PARALLEL_IMAGE_JOBS + 1` claimants. `generate-image` owns the project
  // lifecycle, so that throw used to mark a fully written, fully paid book
  // FAILED and refund `FULL_BOOK_GENERATION` for a missing consistency aid.
  it("draws the cover without sheets when the reference pass cannot reach the database", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.ensureCharacterReferenceAssets.mockRejectedValueOnce(
      new Error("Timed out fetching a new connection from the connection pool")
    );
    mocks.generateImageBytes.mockResolvedValue({
      bytes: Buffer.from("art"),
      mimeType: "image/png",
      provider: "gemini",
      model: "gemini-3-pro-image"
    });

    await generateCover(job());

    const asset = storedAsset();
    expect(asset?.provider).toBe("gemini");
    expect(asset?.metadata).toMatchObject({ coverArtSource: "ai", characterReferenceCount: 0 });
    // Nothing else records the difference between a cast that has no sheets and
    // a pass that could not answer.
    expect(mocks.appendCharacterReferenceRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", planId: "plan-1" }),
      "character.reference.unavailable",
      expect.objectContaining({ drawing: "cover" })
    );
  });

  it("still falls back to a designed cover when the reference pass and the artwork both fail", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.ensureCharacterReferenceAssets.mockRejectedValueOnce(new Error("character reference lease commit aborted"));
    mocks.generateImageBytes.mockRejectedValue(new Error("all image providers failed"));

    await generateCover(job());

    const asset = storedAsset();
    expect(asset?.provider).toBe(BUNDLED_COVER_PROVIDER);
    expect(asset?.metadata).toMatchObject({ coverArtSource: "design", coverFallbackReason: "ai_cover_failed" });
  });

  it("surfaces a stop raised while the reference pass waits rather than finishing the book", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.ensureCharacterReferenceAssets.mockRejectedValueOnce(new StopRequestedError());

    await expect(generateCover(job())).rejects.toThrow(StopRequestedError);
    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
  });

  // During generation this job's failure fails the whole paid book, and the kept
  // artwork is only what makes a later re-typeset free.
  it("still stores the cover when keeping its artwork fails", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockResolvedValue({ bytes: Buffer.from("art"), mimeType: "image/png", provider: "gemini", model: "m" });
    const store = objectStore();
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, "put").mockImplementation(async (key, ...rest) => {
      if (key.includes("cover-art")) throw new Error("storage blip");
      return put(key, ...rest);
    });
    try {
      await expect(generateCover(job())).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    const asset = storedAsset();
    expect(asset?.metadata).toMatchObject({ coverArtSource: "ai", typeset: { title: "A Test Book" } });
    expect(asset?.metadata.artworkObjectKey).toBeUndefined();
  });

  it("keeps the published drawing when a redraw fails before a later free re-typeset", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
    mocks.generateImageBytes.mockResolvedValueOnce({
      bytes: Buffer.from("published-art"), mimeType: "image/png", provider: "gemini", model: "published-model"
    });
    await generateCover(job());
    const published = storedAsset()!;
    mocks.prisma.imageAsset.findFirst.mockResolvedValue(published);

    mocks.generateImageBytes.mockResolvedValueOnce({
      bytes: Buffer.from("failed-redraw-art"), mimeType: "image/png", provider: "gemini", model: "redraw-model"
    });
    mocks.renderCoverPng.mockResolvedValueOnce(Buffer.from("redrawn-cover-png"));
    const store = objectStore();
    const put = store.put.bind(store);
    const spy = vi.spyOn(store, "put").mockImplementation(async (key, bytes, options) => {
      if (Buffer.from(bytes).toString() === "redrawn-cover-png") throw new Error("cover upload failed");
      return put(key, bytes, options);
    });
    try {
      await expect(generateCover(job())).rejects.toThrow("cover upload failed");
    } finally {
      spy.mockRestore();
    }
    expect(mocks.prisma.imageAsset.create).toHaveBeenCalledTimes(1);

    await generateCover({ data: { ...job().data, assetType: "COVER", [COVER_RETYPESET]: true } } as Job);

    expect(mocks.generateImageBytes).toHaveBeenCalledTimes(2);
    const rendered = mocks.renderCoverPng.mock.calls.at(-1)?.[0] as { artwork: { bytes: Buffer } };
    expect(rendered.artwork.bytes.toString()).toBe("published-art");
    const retypeset = mocks.prisma.imageAsset.create.mock.calls.at(-1)?.[0] as { data: { metadata: Record<string, unknown> } };
    expect(retypeset.data.metadata).toMatchObject({
      model: "published-model", artworkObjectKey: published.metadata.artworkObjectKey
    });
  });

  describe("setting a cover's words again", () => {
    function retypesetJob(): Job {
      return {
        data: { projectId: "project-1", planId: "plan-1", generationJobId: "gen-1", assetType: "COVER", [COVER_RETYPESET]: true }
      } as unknown as Job;
    }

    function wearing(metadata: Record<string, unknown>) {
      mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: true }));
      mocks.prisma.imageAsset.findFirst.mockResolvedValue({
        metadata: { typeset: { title: "A Test Book", subtitle: "", authorName: "" }, width: 9, mimeType: "image/png", ...metadata },
        prompt: "the prompt the picture was drawn from",
        provider: "gemini"
      });
    }

    it("re-renders a drawn cover from its stored artwork, never drawing again", async () => {
      const key = objectKey("images", "project-1", "cover-art.jpg");
      await objectStore().put(key, Buffer.from("kept-art"), { contentType: "image/jpeg" });
      wearing({ coverArtSource: "ai", artworkObjectKey: key, artworkStoredMimeType: "image/jpeg", model: "gemini-3-pro-image" });

      await generateCover(retypesetJob());

      expect(mocks.generateImageBytes).not.toHaveBeenCalled();
      expect(mocks.selectCoverDesign).not.toHaveBeenCalled();
      const rendered = mocks.renderCoverPng.mock.calls[0]?.[0] as { artwork: { bytes: Buffer; mimeType: string } };
      expect(rendered.artwork.bytes.toString()).toBe("kept-art");
      const asset = storedAsset();
      expect(asset?.provider).toBe("gemini");
      expect(asset?.prompt).toBe("the prompt the picture was drawn from");
      // The drawing's provenance stays; the storage facts are the new file's.
      expect(asset?.metadata).toMatchObject({
        coverArtSource: "ai",
        model: "gemini-3-pro-image",
        artworkObjectKey: key,
        typeset: { title: "A Test Book", subtitle: "", authorName: "A. Reader" }
      });
      expect(asset?.metadata.width).toBeUndefined();
    });

    it("re-renders a designed cover in the design it wears", async () => {
      wearing({ coverArtSource: "design", coverDesignId: "moonlit-sea" });

      await generateCover(retypesetJob());

      expect(mocks.selectCoverDesign).not.toHaveBeenCalled();
      const rendered = mocks.renderCoverPng.mock.calls[0]?.[0] as { template?: { id: string } };
      expect(rendered.template?.id).toBe(coverDesign("moonlit-sea")!.template);
      expect(storedAsset()?.metadata).toMatchObject({ coverDesignId: "moonlit-sea" });
    });

    it.each(["legacy", "generated"])("keeps the %s cover's bytes when the replacement transaction fails", async (source) => {
      wearing({ coverArtSource: "design", coverDesignId: "moonlit-sea" });
      let previousPath = "http://api.test/assets/images/project-1/cover.jpg";
      const previousMetadata = { coverArtSource: "design", coverDesignId: "moonlit-sea", typeset: { authorName: "Old Byline" } };
      if (source === "generated") {
        mocks.renderCoverPng.mockResolvedValueOnce(Buffer.from("previous-cover"));
        await generateCover(retypesetJob());
        const previous = mocks.prisma.imageAsset.create.mock.calls.at(-1)?.[0] as { data: { path: string } } | undefined;
        if (!previous) throw new Error("The initial cover was not published");
        previousPath = previous.data.path;
      }
      const previousKey = objectKey("images", "project-1", new URL(previousPath).pathname.split("/").at(-1)!);
      await objectStore().put(previousKey, Buffer.from("previous-cover"), { contentType: "image/jpeg" });
      mocks.prisma.imageAsset.findFirst.mockResolvedValue({
        prompt: "kept prompt", provider: "bundled-cover", metadata: previousMetadata
      });
      mocks.prisma.$transaction.mockImplementationOnce(async (callback) => {
        await callback(mocks.prisma);
        throw new Error("cover row replacement response lost");
      });
      mocks.renderCoverPng.mockResolvedValueOnce(Buffer.from("replacement-cover"));

      await expect(generateCover(retypesetJob())).resolves.toBeUndefined();

      expect(mocks.updateJobProgress).toHaveBeenCalledWith("gen-1", { message: "Cover kept as it was" });
      expect((await objectStore().get(previousKey))?.toString()).toBe("previous-cover");
      // A lost transaction response can also hide a commit, so its candidate stays readable.
      const candidate = mocks.prisma.imageAsset.create.mock.calls.at(-1)?.[0] as { data: { path: string } };
      const candidateKey = objectKey("images", "project-1", new URL(candidate.data.path).pathname.split("/").at(-1)!);
      expect((await objectStore().get(candidateKey))?.toString()).toBe("replacement-cover");
    });

    it("publishes each typeset cover at its own URL and retains the previous URL's bytes", async () => {
      wearing({ coverArtSource: "design", coverDesignId: "moonlit-sea" });
      mocks.renderCoverPng.mockResolvedValueOnce(Buffer.from("first-cover"));
      await generateCover(retypesetJob());
      const first = mocks.prisma.imageAsset.create.mock.calls.at(-1)?.[0] as { data: { path: string } };
      mocks.renderCoverPng.mockResolvedValueOnce(Buffer.from("second-cover"));
      await generateCover(retypesetJob());
      const second = mocks.prisma.imageAsset.create.mock.calls.at(-1)?.[0] as { data: { path: string } };

      expect(second.data.path).not.toBe(first.data.path);
      for (const [path, bytes] of [[first.data.path, "first-cover"], [second.data.path, "second-cover"]] as const) {
        const filename = new URL(path).pathname.split("/").at(-1)!;
        expect((await objectStore().get(objectKey("images", "project-1", filename)))?.toString()).toBe(bytes);
      }
    });

    it("leaves a drawn cover from before artwork was kept exactly as it is", async () => {
      wearing({ coverArtSource: "ai" });

      await generateCover(retypesetJob());

      expect(mocks.renderCoverPng).not.toHaveBeenCalled();
      expect(mocks.generateImageBytes).not.toHaveBeenCalled();
      expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    });

    // While the book is still being written a cover job's failure is the book's,
    // so a re-set that fails keeps the cover rather than failing the run.
    it("never fails the job over a cover that keeps its words, but a stop still travels", async () => {
      wearing({ coverArtSource: "design", coverDesignId: "moonlit-sea" });
      mocks.renderCoverPng.mockRejectedValueOnce(new Error("chromium went away"));
      await expect(generateCover(retypesetJob())).resolves.toBeUndefined();
      expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();

      mocks.renderCoverPng.mockRejectedValueOnce(new StopRequestedError());
      await expect(generateCover(retypesetJob())).rejects.toBeInstanceOf(StopRequestedError);
    });
  });

  it("writes no cover at all only when the source is none", async () => {
    mocks.prisma.planVersion.findUnique.mockResolvedValue(planVersion({ includeCover: false, coverArtSource: "none" }));

    await generateCover(job());

    expect(mocks.prisma.imageAsset.create).not.toHaveBeenCalled();
    expect(mocks.generateImageBytes).not.toHaveBeenCalled();
  });
});

describe("coverTemplateOverrideForDesign", () => {
  it("carries the design's own scrim when it has one", () => {
    const linen = coverDesign("linen-minimal");
    expect(linen).toBeDefined();
    const override = coverTemplateOverrideForDesign(linen!);
    expect(override.id).toBe("minimal");
    // Light artwork needs a heavier scrim; every template sets light type.
    expect(override.overlayCss).toBeDefined();
  });

  it("leaves the template's own accent alone when the design does not override it", () => {
    expect(coverTemplateOverrideForDesign(coverDesign("moonlit-sea")!).accentColor).toBeUndefined();
  });
});
