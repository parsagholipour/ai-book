import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  imageAsset: { findFirst: vi.fn() },
  $transaction: vi.fn(),
  bookEditOperation: { create: vi.fn() }
}));
const billing = vi.hoisted(() => ({ startGenerationAttempt: vi.fn() }));
const cover = vi.hoisted(() => ({ commitCoverChange: vi.fn(), dispatchCoverJobs: vi.fn() }));
const chat = vi.hoisted(() => ({ createAssistantChatMessage: vi.fn() }));

vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("@book-maker/db/billing", () => billing);
vi.mock("./coverChange.js", async (importActual) => ({
  ...(await importActual<typeof import("./coverChange.js")>()),
  ...cover
}));
vi.mock("./projectChat.js", () => chat);

import { creditPricing } from "@book-maker/core";
import { bookTitleIntent } from "../bookEditBookTitle.js";
import { applyBookTitleEdit } from "./bookTitleEdits.js";
import { type ProjectForChat } from "./projectChat.js";

/**
 * A title change is free unless the cover is AI artwork, which has the title
 * set into its pixels and is redrawn at the cover price — a card the reader
 * confirms, charged like the Writing Studio's AI cover and claimed by a
 * `BOOK_TITLE` operation row.
 */
const project = {
  id: "project-1",
  title: "Tiko and the Quiet Sea",
  status: "COMPLETE",
  currentPlanId: "plan-1",
  currentPlan: { planningPackage: { title: "Tiko and the Quiet Sea" } },
  category: "STORY",
  prompt: "A story about a sea turtle",
  mediaSettings: {}
} as unknown as ProjectForChat;

const intent = bookTitleIntent("Tiko and the Silver Sea", { confidence: 0.95, reasoning: "", assistantMessage: "" });
const committed = { jobIds: ["compile-1", "cover-1"], primaryJobId: "cover-1", contentRevision: 2, restoreStatus: "COMPLETE" };

function run(overrides: Partial<Parameters<typeof applyBookTitleEdit>[0]> = {}) {
  return applyBookTitleEdit({
    userId: "user-1",
    project,
    intent,
    userMessageId: "message-1",
    message: "change the book title to Tiko and the Silver Sea",
    pendingEditMetadata: (state) => ({ ...state }),
    ...overrides
  });
}

describe("changing a book's title from the chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.createAssistantChatMessage.mockImplementation(async (message) => ({ id: "reply-1", ...message }));
    cover.commitCoverChange.mockResolvedValue(committed);
    db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
    db.bookEditOperation.create.mockResolvedValue({ id: "operation-1" });
  });

  it("prices a redraw of an AI cover as a card, and charges nothing yet", async () => {
    db.imageAsset.findFirst.mockResolvedValue({ metadata: { coverArtSource: "ai", model: "imagen" } });
    const { reply } = await run();
    const metadata = (reply as unknown as { metadata: Record<string, any> }).metadata;
    expect(metadata.editProposal).toMatchObject({
      kind: "book_title",
      credits: creditPricing().coverRegeneration,
      summary: "Retitle the book “Tiko and the Silver Sea” and draw a new AI cover with it"
    });
    expect(metadata.pendingEdit).toMatchObject({ clarification: "confirm", credits: creditPricing().coverRegeneration });
    expect(billing.startGenerationAttempt).not.toHaveBeenCalled();
    expect(cover.commitCoverChange).not.toHaveBeenCalled();
  });

  it("on Apply charges the redraw, claims the card and commits the title with a paid cover", async () => {
    db.imageAsset.findFirst.mockResolvedValue({ metadata: { coverArtSource: "ai" } });
    billing.startGenerationAttempt.mockImplementation(async (options) => {
      await options.create(db, { attemptId: "attempt-1", ledgerEntry: { id: "ledger-1" } });
      return { attempt: { id: "attempt-1" }, replayed: false };
    });
    const cost = creditPricing().coverRegeneration;
    const { reply } = await run({ executeProposal: true, executionCommandId: "proposal-1", quotedCredits: cost });

    expect(billing.startGenerationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        commandKey: "mobile:book-title:project-1:proposal-1",
        operation: "COVER_REGENERATION",
        quotedCredits: cost
      })
    );
    expect(db.bookEditOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "BOOK_TITLE", requestId: "proposal-1", status: "APPLIED", creditsCharged: cost })
      })
    );
    expect(cover.commitCoverChange).toHaveBeenCalledWith(db, "project-1", {
      title: "Tiko and the Silver Sea",
      drawCover: { attemptId: "attempt-1", ledgerEntryId: "ledger-1", purchase: true }
    });
    expect(cover.dispatchCoverJobs).toHaveBeenCalledWith("project-1", committed);
    expect(reply).toMatchObject({ operationId: "operation-1", metadata: { charged: true, creditsCharged: cost } });
  });

  it("asks again rather than charge more than the card said", async () => {
    db.imageAsset.findFirst.mockResolvedValue({ metadata: { coverArtSource: "ai" } });
    const { reply } = await run({ executeProposal: true, executionCommandId: "proposal-1", quotedCredits: 1 });
    expect(billing.startGenerationAttempt).not.toHaveBeenCalled();
    expect((reply as unknown as { metadata: Record<string, any> }).metadata.editProposal?.kind).toBe("book_title");
  });

  it("re-sets a designed cover for free, in the design it wears", async () => {
    db.imageAsset.findFirst.mockResolvedValue({ metadata: { coverArtSource: "design", coverDesignId: "moonlit-sea" } });
    const { reply } = await run();
    expect(billing.startGenerationAttempt).not.toHaveBeenCalled();
    expect(cover.commitCoverChange).toHaveBeenCalledWith(db, "project-1", {
      title: "Tiko and the Silver Sea",
      coverArtSource: "design",
      drawCover: { purchase: false }
    });
    expect((reply as unknown as { content: string }).content).toBe(
      "Done — the book is now called “Tiko and the Silver Sea”. I’m setting the cover again with the new title and refreshing the exports. This one’s free."
    );
  });

  it("keeps a children's book in the page design its old title chose", async () => {
    db.imageAsset.findFirst.mockResolvedValue(null);
    await run({
      project: {
        ...project,
        category: "KIDS",
        currentPlan: { planningPackage: { title: "Tiko under the Night Sky" } }
      } as unknown as ProjectForChat
    });
    expect(cover.commitCoverChange).toHaveBeenCalledWith(
      db,
      "project-1",
      expect.objectContaining({ mediaSettingsPatch: { storyPageDesign: expect.any(String) } })
    );
  });

  it("sends an author to the Writing Studio, and leaves an unchanged title alone", async () => {
    const author = { ...project, mediaSettings: { mobile: { studio: { kind: "story", layout: "flow", createdAt: "2026-10-01T23:18:21.124Z" } } } } as unknown as ProjectForChat;
    const studio = await run({ project: author });
    expect((studio.reply as unknown as { content: string }).content).toContain("Writing Studio");
    const same = await run({ intent: { ...intent, bookTitle: "Tiko and the Quiet Sea" } });
    expect((same.reply as unknown as { content: string }).content).toBe("The book is already called “Tiko and the Quiet Sea”.");
    expect(cover.commitCoverChange).not.toHaveBeenCalled();
  });
});
