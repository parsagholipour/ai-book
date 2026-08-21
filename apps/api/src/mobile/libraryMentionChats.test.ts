import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { enqueueGenerationJob } from "../queue.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  creationDraftRecord,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * Mentions on the two chat surfaces, where the library is still read live: the
 * refs a message carries, the 404 for a character the user does not own, and
 * the linked profiles that reach the model without reaching the transcript.
 * The moment those reads stop and become a copy is `POST …/build`, which has
 * its own suite in `libraryMentionBuildSnapshots.test.ts`.
 */

function libraryCharacterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "char-1",
    userId: "user-a",
    name: "Luna",
    description: "A brave night-flying rabbit.",
    fields: [{ key: "Age", value: "9" }],
    photoPath: null,
    photoKind: null,
    suggestedDescription: null,
    appearance: null,
    portraitPath: null,
    portraitSource: null,
    portraitStatus: "NONE",
    portraitError: null,
    portraitJobId: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    outgoingMentions: [],
    ...overrides
  };
}

function linkedCharacter(target: { id: string; name: string }, sortOrder = 0) {
  return {
    sourceCharacterId: "char-1",
    targetKind: "CHARACTER" as const,
    targetId: target.id,
    targetCharacterId: target.id,
    otherType: null,
    sortOrder,
    targetCharacter: { id: target.id, name: target.name }
  };
}

describe("character mentions in the creation chat", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("stores light refs on the message and exposes them in the session", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({
        id: "draft-1",
        payload: {
          payloadVersion: 3,
          messages: [{ id: "m1", role: "user", content: "A bedtime story", parentId: null, isActiveChild: true }]
        }
      })
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([libraryCharacterRow()]);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/draft-1/messages",
      headers: bearer("token-a"),
      payload: { message: "Put @Luna at the center of it", mentionedCharacterIds: ["char-1"] }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    const userMessage = body.session.messages.find(
      (message: { role: string; content: string }) => message.content.includes("@Luna")
    );
    expect(userMessage.characters).toEqual([{ id: "char-1", name: "Luna" }]);
    // The turn re-reads the library rows scoped to this user, every turn.
    expect(mockPrisma.libraryCharacter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "user-a" }) })
    );
    await app.close();
  });

  it("refuses a mention of a character that is not in the user's library", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "draft-1", payload: { payloadVersion: 3, messages: [] } })
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/draft-1/messages",
      headers: bearer("token-a"),
      payload: { message: "Add @Ghost", mentionedCharacterIds: ["char-ghost"] }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("CHARACTER_NOT_FOUND");
    await app.close();
  });

  it("attaches mentions on the very first message of a brand-new chat", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([libraryCharacterRow()]);
    mockPrisma.mobileCreationDraft.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", status: "ACTIVE", payload: data.payload })
    );
    const app = await buildMobileApp({ creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions",
      headers: bearer("token-a"),
      payload: { message: "A bedtime story about @Luna", mentionedCharacterIds: ["char-1"] }
    });
    const body = response.json();

    expect(response.statusCode).toBe(201);
    const userMessage = body.session.messages.find(
      (message: { role: string }) => message.role === "user"
    );
    expect(userMessage.characters).toEqual([{ id: "char-1", name: "Luna" }]);
    await app.close();
  });

  it("sends linked profiles to the turn while storing only the explicit mention", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({ id: "draft-1", payload: { payloadVersion: 3, messages: [] } })
    );
    const bram = libraryCharacterRow({ id: "char-2", name: "Bram", description: "A careful navigator." });
    const luna = libraryCharacterRow({
      description: "Travels with @Bram.",
      outgoingMentions: [linkedCharacter(bram)]
    });
    // Answers by id: the graph fetches the roots and then each level's own
    // new targets, so a mock that ignored `where.id` would hand the level back
    // a character it had already seen and lose the linked profile.
    mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) =>
      [luna, bram].filter((row) => !where.id || (where.id.in as string[]).includes(row.id))
    );
    let turnCharacters: Array<Record<string, unknown>> | undefined;
    const app = await buildMobileApp({
      creationEnrichment: async (request: any) => {
        turnCharacters = request.characters;
        return {};
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/draft-1/messages",
      headers: bearer("token-a"),
      payload: { message: "Put @Luna at the center.", mentionedCharacterIds: ["char-1"] }
    });

    expect(response.statusCode).toBe(200);
    expect(turnCharacters).toMatchObject([
      { id: "char-1", description: "Travels with Bram." },
      { id: "char-2", description: "A careful navigator." }
    ]);
    const visible = response.json().session.messages.find(
      (message: { role: string; content: string }) => message.content.includes("@Luna")
    );
    expect(visible.characters).toEqual([{ id: "char-1", name: "Luna" }]);
    await app.close();
  });

  it("sends every character the branch tapped, past the linked-graph cap", async () => {
    // One message caps its own picks at ten; the branch union is not capped
    // and must not be. The turn's system prompt promises the model that every
    // selected character's sheet arrives under `characters`, so a cast trimmed
    // to the graph's expansion limit meant the eleventh and twelfth characters
    // were named all through the chat with nothing behind the name — a book
    // written about a stranger the reader had already saved.
    mockAccessTokens({ "token-a": "user-a" });
    const cast = Array.from({ length: 12 }, (_, index) => ({ id: `char-${index}`, name: `Name${index}` }));
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(
      creationDraftRecord({
        id: "draft-1",
        payload: {
          payloadVersion: 3,
          messages: cast.map((character, index) => ({
            id: `m${index}`,
            role: "user",
            content: `Add @${character.name}`,
            parentId: index === 0 ? null : `m${index - 1}`,
            isActiveChild: true,
            characters: [character]
          }))
        }
      })
    );
    const shelf = cast.map((character) => libraryCharacterRow({ id: character.id, name: character.name }));
    mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) =>
      shelf.filter((row) => !where.id || (where.id.in as string[]).includes(row.id))
    );
    let turnCharacters: Array<Record<string, unknown>> | undefined;
    const app = await buildMobileApp({
      creationEnrichment: async (request: any) => {
        turnCharacters = request.characters;
        return {};
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/draft-1/messages",
      headers: bearer("token-a"),
      payload: { message: "Now write it around all of them." }
    });

    expect(response.statusCode).toBe(200);
    expect(turnCharacters?.map((character) => character.id)).toEqual(cast.map((character) => character.id));
    await app.close();
  });
});

describe("character mentions in the finished-book chat", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("carries the sheets on the stored request but never the visible transcript", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([libraryCharacterRow()]);
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-edit", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();

    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: {
        message: "Rewrite the whole book so @Luna is the main character.",
        mentionedCharacterIds: ["char-1"]
      }
    });
    const proposalBody = proposal.json();

    expect(proposal.statusCode).toBe(200);
    // The card the reader sees stays clean; the sheet rides the resumable
    // pending state so Apply still has it.
    expect(proposalBody.reply.content).not.toContain("night-flying");
    expect(proposalBody.reply.metadata.pendingEdit.characterContext).toContain("Luna");
    expect(proposalBody.reply.metadata.pendingEdit.characterContext).toContain("night-flying");
    expect(proposalBody.reply.metadata.pendingEdit.request).not.toContain("night-flying");
    const userMessage = proposalBody.messages.find(
      (message: { role: string }) => message.role === "user"
    );
    expect(userMessage.metadata.characters).toEqual([{ id: "char-1", name: "Luna" }]);

    const confirm = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId: proposalBody.reply.metadata.editProposal.id }
    });

    expect(confirm.statusCode).toBe(200);
    const queued = vi.mocked(enqueueGenerationJob).mock.calls.at(-1)![0];
    expect(queued.type).toBe("APPLY_BOOK_EDIT");
    const request = queued.payload.request as string;
    expect(request.startsWith("Rewrite the whole book so @Luna is the main character.")).toBe(true);
    expect(request).toContain("Mentioned character profiles");
    expect(request).toContain("night-flying");
    await app.close();
  });

  it("refuses a mention of a character that is not in the user's library", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([]);
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Add @Ghost to page 2", mentionedCharacterIds: ["char-ghost"] }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("CHARACTER_NOT_FOUND");
    await app.close();
  });

  it("adds linked profiles to edit context but not stored message metadata", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    const bram = libraryCharacterRow({ id: "char-2", name: "Bram", description: "A careful navigator." });
    const luna = libraryCharacterRow({
      description: "Travels with @Bram.",
      outgoingMentions: [linkedCharacter(bram)]
    });
    mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) =>
      [luna, bram].filter((row) => !where.id || (where.id.in as string[]).includes(row.id))
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: {
        message: "Rewrite the book around @Luna.",
        mentionedCharacterIds: ["char-1"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.metadata.pendingEdit.characterContext).toContain("Bram");
    expect(response.json().reply.metadata.pendingEdit.characterContext).not.toContain("@Bram");
    const userMessage = response.json().messages.find((message: { role: string }) => message.role === "user");
    expect(userMessage.metadata.characters).toEqual([{ id: "char-1", name: "Luna" }]);
    await app.close();
  });
});
