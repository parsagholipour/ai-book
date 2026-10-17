import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "@book-maker/core";

const db = vi.hoisted(() => ({ authorProfile: { findUnique: vi.fn() } }));
const matter = vi.hoisted(() => ({ applyBookMatterPatch: vi.fn(), ownedBookMatterProject: vi.fn() }));
const chat = vi.hoisted(() => ({ createAssistantChatMessage: vi.fn() }));

vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("@book-maker/db/billing", () => ({}));
vi.mock("../queue.js", () => ({ enqueueJob: vi.fn() }));
vi.mock("./bookMatterEdits.js", async (importActual) => ({
  ...(await importActual<typeof import("./bookMatterEdits.js")>()),
  ...matter
}));
vi.mock("./projectChat.js", () => chat);
vi.mock("../contentRestrictions.js", async (importActual) => ({
  ...(await importActual<typeof import("../contentRestrictions.js")>()),
  copyrightRestrictionsEnabled: vi.fn(async () => false)
}));

import { bookMatterIntent } from "../bookEditMatter.js";
import { applyBookMatterChatEdit } from "./bookMatterChatEdits.js";
import { type ProjectForChat } from "./projectChat.js";

/**
 * The chat reads the reader's saved author profile. "The Last Table"
 * (2026-10-17) was made before its owner saved a profile, so it printed no
 * name; asked to "include my info in the cover pages", the chat asked them to
 * type it all out, and "Whatever I added in my profile" was answered "I didn't
 * find a change to the book's title and credits in that".
 */
const project = {
  id: "cmvcknby10014r7p65hvk5tlg",
  status: "COMPLETE",
  currentPlanId: "plan-1",
  mediaSettings: {},
  language: "en",
  contentRevision: 1,
  createdAt: new Date("2026-10-17T15:48:00Z")
} as unknown as ProjectForChat;

const profileRow = {
  userId: "user-1",
  penName: "Parsa Gholipour",
  bio: "",
  website: "",
  copyrightHolder: "",
  imprint: "",
  allRightsReserved: true,
  includeAboutAuthor: true,
  setupPromptSeenAt: new Date("2026-10-17T16:56:20Z")
};

function composer(answer: Record<string, unknown>) {
  const generateJson = vi.fn(async (options: GenerateJsonOptions<unknown>) => ({
    data: options.schema.parse(answer),
    text: JSON.stringify(answer),
    model: "test",
    provider: "test"
  }));
  const model = { generateText: vi.fn(), generateWithTools: vi.fn(), generateJson } as unknown as TextModelAdapter;
  const shown = () => JSON.parse(generateJson.mock.calls[0]![0].messages.at(-1)!.content as string);
  return { model, shown };
}

const FIRST = "I added my author info. I wanna remake this book or modify it to include my info in the cover pages";

async function send(message: string, model: TextModelAdapter) {
  const reply = await applyBookMatterChatEdit({
    userId: "user-1",
    project,
    intent: bookMatterIntent({ confidence: 0.8, reasoning: "", assistantMessage: "", responseLanguage: "en" }),
    userMessageId: "message-1",
    message,
    pendingRequest: message,
    textModel: model
  });
  return reply as unknown as { content: string; metadata: Record<string, any> };
}

describe("the matter chat and the reader's saved profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.createAssistantChatMessage.mockImplementation(async (message) => ({ id: "reply-1", ...message }));
    matter.ownedBookMatterProject.mockResolvedValue({
      id: project.id,
      userId: "user-1",
      status: "COMPLETE",
      authorName: null,
      bookMatter: null,
      mediaSettings: {},
      currentPlanId: "plan-1"
    });
    matter.applyBookMatterPatch.mockResolvedValue({ reprint: "queued", cover: "retypeset", contentRevision: 2 });
    db.authorProfile.findUnique.mockResolvedValue(profileRow);
  });

  it("puts the profile on the book when the reader points at it", async () => {
    const words = "include my info in the cover pages";
    const { model, shown } = composer({
      outcome: "change",
      changes: [
        { field: "authorName", action: "set", text: "Parsa Gholipour", requestedBy: words },
        { field: "allRightsReserved", action: "set", text: null, requestedBy: words }
      ]
    });
    const reply = await send(FIRST, model);

    // Shown as a new book would copy it: the blank bio, website, holder and publisher are not there.
    expect(shown().authorProfile).toEqual({ authorName: "Parsa Gholipour", allRightsReserved: true });
    expect(matter.applyBookMatterPatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id }),
      { authorName: "Parsa Gholipour", allRightsReserved: true }
    );
    expect(reply.content).toMatch(/^Done — /);
    expect(reply.content).toContain("Parsa Gholipour");
    expect(reply.content).toContain("The cover gets the new name too.");
    expect(reply.content).not.toContain("separate change");
    // The app draws the book under this reply until revision 2 is published (`bookUpdateMetadata`).
    expect(reply.metadata.bookUpdate).toEqual({ contentRevision: 2 });
    expect(reply.metadata.bookMatterEdit).toEqual({
      before: { authorName: null, allRightsReserved: false },
      after: { authorName: "Parsa Gholipour", allRightsReserved: true }
    });
  });

  it("asks as before when the profile cannot be read", async () => {
    db.authorProfile.findUnique.mockRejectedValue(new Error("connection lost"));
    const { model, shown } = composer({ outcome: "question", question: "What name should the cover print?" });
    const reply = await send(FIRST, model);
    expect(shown()).not.toHaveProperty("authorProfile");
    expect(matter.applyBookMatterPatch).not.toHaveBeenCalled();
    expect(reply.content).toBe("What name should the cover print?");
    expect(reply.metadata.pendingEdit).toMatchObject({ clarification: "matter" });
  });
});
