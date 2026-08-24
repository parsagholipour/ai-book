import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookPlan, StoryExtractResult, StoryState } from "@book-maker/core";

/**
 * Final-QA repair semantic-memory publication, at the persist seam.
 *
 * The repaired page is already written. This transaction only claims that
 * snapshot and publishes the memory derived from it. A payload with nothing
 * to write must not open a transaction; a lost claim is superseded; a fence
 * that cannot be read or a user stop still travels; any other failure keeps
 * the repaired page.
 */

vi.mock("@book-maker/db", async () => (await import("./testing/compileExportMocks.js")).dbModuleMock());
vi.mock("../runtime/config.js", async () => (await import("./testing/compileExportMocks.js")).configModuleMock());
vi.mock(
  "../generation/projectInput.js",
  async () => (await import("./testing/compileExportMocks.js")).projectInputModuleMock()
);
vi.mock(
  "../generation/exportPublication.js",
  async () => (await import("./testing/compileExportMocks.js")).exportPublicationModuleMock()
);
vi.mock("../runtime/dispatch.js", async () => (await import("./testing/compileExportMocks.js")).dispatchModuleMock());
vi.mock(
  "../runtime/jobLifecycle.js",
  async () => (await import("./testing/compileExportMocks.js")).jobLifecycleModuleMock()
);
vi.mock(
  "../providers/loggedAdapters.js",
  async () => (await import("./testing/compileExportMocks.js")).loggedAdaptersModuleMock()
);
vi.mock(
  "../generation/embeddingWrites.js",
  async () => (await import("./testing/compileExportMocks.js")).embeddingWritesModuleMock()
);
vi.mock(
  "../generation/entityState.js",
  async () => (await import("./testing/compileExportMocks.js")).entityStateModuleMock()
);
vi.mock("./characters.js", async () => (await import("./testing/compileExportMocks.js")).charactersModuleMock());
vi.mock(
  "../generation/bookHelpers.js",
  async () => (await import("./testing/compileExportMocks.js")).bookHelpersModuleMock()
);
vi.mock("../generation/finalQaPageTargets.js", async () => {
  const actual =
    await vi.importActual<typeof import("../generation/finalQaPageTargets.js")>(
      "../generation/finalQaPageTargets.js"
    );
  return (await import("./testing/compileExportMocks.js")).finalQaPageTargetsModuleMock(actual);
});
vi.mock(
  "../generation/storyStateStore.js",
  async () => (await import("./testing/compileExportMocks.js")).storyStateStoreModuleMock()
);
vi.mock(
  "../generation/qualityEnrichment.js",
  async () => (await import("./testing/compileExportMocks.js")).qualityEnrichmentModuleMock()
);
vi.mock(
  "../generation/qualitySettings.js",
  async () => (await import("./testing/compileExportMocks.js")).qualitySettingsModuleMock()
);
vi.mock("../generation/pageReview.js", async () => {
  const actual = await vi.importActual<typeof import("../generation/pageReview.js")>("../generation/pageReview.js");
  return (await import("./testing/compileExportMocks.js")).pageReviewModuleMock(actual);
});
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return (await import("./testing/compileExportMocks.js")).coreModuleMock(actual);
});

import { persistFinalQaPageSemantics } from "./compileExportRepairSemantics.js";
import { ExportRepairFenceUnreadableError, ExportRepairSupersededError } from "./compileExportFence.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { mocks } from "./testing/compileExportMocks.js";

const updatedAt = new Date("2026-01-01T00:00:00.000Z");
const plan: BookPlan = {
  title: "Book",
  premise: "A book.",
  audience: "adults",
  writingComplexity: 3,
  voiceGuide: ["Use clear, direct prose."],
  antiAiRules: ["Avoid filler and stock transitions."],
  questions: [],
  chapters: [
    {
      index: 1,
      title: "The Key",
      summary: "Mara discovers what the brass key opens.",
      targetPages: 3,
      keyBeats: ["Mara finds the key.", "Mara tests the lock."]
    }
  ],
  characters: [],
  locations: [],
  continuityRules: [],
  researchQueries: [],
  researchNotes: [],
  promises: [],
  illustrationPlan: {
    cadence: "manual",
    globalStyle: "Naturalistic editorial illustration.",
    characterReferencePrompts: [],
    pageRules: []
  }
};
const keeperExtract = {
  storyDelta: {
    promisesOpened: [],
    promisesPaid: [],
    promisesBroken: [],
    factsAdded: ["Mara has the key."],
    entities: {},
    unansweredAdded: [],
    unansweredResolved: []
  },
  contradictions: []
} as StoryExtractResult;
const storyState: StoryState = { promises: [], facts: [], entities: {}, unanswered: [] };
const preparedEmbedding = { vectorLiteral: "[0]", error: null };
const continuityNotes = ["Mara has the key."];

let transactionOpen = false;

const persist = (
  overrides: Partial<Parameters<typeof persistFinalQaPageSemantics>[0]> &
    Pick<Parameters<typeof persistFinalQaPageSemantics>[0], "assertOwnership">
) =>
  persistFinalQaPageSemantics({
    projectId: "project-1",
    pageId: "page-1",
    pageIndex: 3,
    title: "Repaired",
    markdown: "Repaired prose.",
    summary: "Repaired summary.",
    imagePrompt: "A repaired scene.",
    revision: 2,
    status: "COMPLETED",
    updatedAt,
    plan,
    keeperExtract: null,
    continuityNotes: [],
    usesSemanticMemory: false,
    preparedEmbedding: null,
    ...overrides
  });

describe("persistFinalQaPageSemantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionOpen = false;
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 1 });
    mocks.persistStoryExtract.mockReset();
    mocks.writePreparedEmbedding.mockReset();
    mocks.updateEntityStateFromPage.mockReset();
    mocks.prisma.continuityNote.createMany.mockReset();
    mocks.prisma.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await run(mocks.prisma);
      } finally {
        transactionOpen = false;
      }
    });
  });

  it.each([
    {
      name: "no extract, notes, or embedding",
      usesSemanticMemory: false,
      preparedEmbedding: null
    },
    {
      name: "semantic memory on but no prepared embedding",
      usesSemanticMemory: true,
      preparedEmbedding: null
    },
    {
      name: "a prepared embedding without semantic memory",
      usesSemanticMemory: false,
      preparedEmbedding
    }
  ])("returns null without opening a transaction when there is $name", async (payload) => {
    const assertOwnership = vi.fn();

    await expect(persist({ assertOwnership, ...payload })).resolves.toBeNull();

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(assertOwnership).not.toHaveBeenCalled();
    expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
  });

  it("runs the fence inside the transaction before the page claim and publishes extract, notes, and embedding through the tx client", async () => {
    const assertOwnership = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
    });
    mocks.persistStoryExtract.mockImplementation(async (options: { client?: unknown }) => {
      expect(transactionOpen).toBe(true);
      expect(options.client).toBe(mocks.prisma);
      return storyState;
    });
    mocks.updateEntityStateFromPage.mockImplementation(async () => {
      expect(transactionOpen).toBe(true);
    });
    mocks.writePreparedEmbedding.mockImplementation(async () => {
      expect(transactionOpen).toBe(true);
    });

    await expect(
      persist({
        assertOwnership,
        keeperExtract,
        continuityNotes,
        usesSemanticMemory: true,
        preparedEmbedding
      })
    ).resolves.toBe(storyState);

    expect(assertOwnership).toHaveBeenCalledWith(mocks.prisma);
    expect(assertOwnership.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.page.updateMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.page.updateMany).toHaveBeenCalledWith({
      where: {
        id: "page-1",
        title: "Repaired",
        markdown: "Repaired prose.",
        summary: "Repaired summary.",
        imagePrompt: "A repaired scene.",
        revision: 2,
        status: "COMPLETED",
        updatedAt
      },
      data: { updatedAt }
    });
    expect(mocks.persistStoryExtract).toHaveBeenCalledWith({
      projectId: "project-1",
      pageIndex: 3,
      plan,
      extract: keeperExtract,
      client: mocks.prisma
    });
    expect(mocks.prisma.page.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.persistStoryExtract.mock.invocationCallOrder[0]!
    );
    expect(mocks.prisma.continuityNote.createMany).toHaveBeenCalledWith({
      data: [
        {
          projectId: "project-1",
          pageId: "page-1",
          scope: "page:3",
          body: "Mara has the key.",
          tags: ["page", "3", "final-qa-repair"]
        }
      ]
    });
    expect(mocks.updateEntityStateFromPage).toHaveBeenCalledWith(
      "project-1",
      3,
      continuityNotes,
      mocks.prisma
    );
    expect(mocks.writePreparedEmbedding).toHaveBeenCalledWith(
      {
        projectId: "project-1",
        scope: "page:3",
        sourceId: "page-1",
        text: "Repaired summary."
      },
      preparedEmbedding,
      mocks.prisma
    );
  });

  it("throws ExportRepairSupersededError when the exact page snapshot is no longer the row", async () => {
    const assertOwnership = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
    });
    mocks.prisma.page.updateMany.mockResolvedValue({ count: 0 });

    await expect(persist({ assertOwnership, keeperExtract })).rejects.toBeInstanceOf(
      ExportRepairSupersededError
    );

    expect(assertOwnership).toHaveBeenCalledWith(mocks.prisma);
    expect(assertOwnership.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prisma.page.updateMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.persistStoryExtract).not.toHaveBeenCalled();
    expect(mocks.prisma.continuityNote.createMany).not.toHaveBeenCalled();
    expect(mocks.writePreparedEmbedding).not.toHaveBeenCalled();
  });

  it("rethrows a fence-unreadable error from the ownership claim", async () => {
    const unreadable = new ExportRepairFenceUnreadableError(new Error("Connection terminated unexpectedly"), 2);
    const assertOwnership = vi.fn().mockRejectedValue(unreadable);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(persist({ assertOwnership, keeperExtract })).rejects.toBe(unreadable);
      expect(mocks.prisma.page.updateMany).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rethrows a stop-requested error from persist instead of swallowing it", async () => {
    const stop = new StopRequestedError();
    const assertOwnership = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
    });
    mocks.persistStoryExtract.mockRejectedValue(stop);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(persist({ assertOwnership, keeperExtract })).rejects.toBe(stop);
      expect(mocks.prisma.page.updateMany).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and returns null on a generic persist failure so the repaired page is kept", async () => {
    const assertOwnership = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
    });
    mocks.persistStoryExtract.mockRejectedValue(new Error("story store unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(persist({ assertOwnership, keeperExtract })).resolves.toBeNull();
      expect(mocks.prisma.page.updateMany).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Final-QA semantic memory publication failed; keeping the repaired page",
        expect.objectContaining({
          projectId: "project-1",
          pageId: "page-1",
          pageIndex: 3
        })
      );
    } finally {
      warn.mockRestore();
    }
  });
});
