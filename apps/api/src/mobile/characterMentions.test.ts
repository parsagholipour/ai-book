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
    ...overrides
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
});

const BUILD_PRESETS = {
  bookType: "short_story",
  lengthPreset: "short",
  qualityPreset: "balanced",
  imagesEnabled: true,
  pageCountMode: "custom",
  targetPages: 12,
  pageCountSource: "settings"
};

/** A fresh draft id per build: a replayed one is an idempotent 409, not a build. */
let buildSequence = 0;

/**
 * Builds a book from one chat branch against one library, and hands back the
 * `Project.create` input — `mediaSettings.mobile.characters` is the snapshot
 * everything downstream reads.
 */
async function buildWithMessages(
  messages: Array<Record<string, unknown>>,
  library: Array<Record<string, unknown>>
): Promise<Record<string, any>> {
  mockAccessTokens({ "token-a": "user-a" });
  const draftId = `session-draft-${(buildSequence += 1)}`;
  const payload = { payloadVersion: 3, messages, selectedPresets: BUILD_PRESETS };
  mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: draftId, payload }));
  mockPrisma.template.findFirst.mockResolvedValue({ id: "template-kids" });
  // The id lookup and the whole-library name read the typed-mention scan makes
  // both land here.
  mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) =>
    where.id ? library.filter((row) => (where.id.in as string[]).includes(row.id as string)) : library
  );
  mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
    projectRecord({
      id: "project-from-session",
      title: data.title,
      prompt: data.prompt,
      mediaSettings: data.mediaSettings,
      currentPlan: null,
      pages: [],
      _count: { pages: 0, images: 0, jobs: 0 }
    })
  );
  mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    creationDraftRecord({ id: draftId, payload, ...data })
  );
  mockPrisma.project.update.mockResolvedValue({});
  vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
  const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });
  const response = await app.inject({
    method: "POST",
    url: `/api/mobile/creation-sessions/${draftId}/build`,
    headers: bearer("token-a"),
    payload: {}
  });
  expect(response.statusCode).toBe(201);
  await app.close();
  return mockPrisma.project.create.mock.calls.at(-1)![0].data;
}

describe("character snapshots at build time", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("snapshots active-branch mentions into mediaSettings and the prompt, skipping edited-away branches", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      payloadVersion: 3,
      rawIdea: "A bedtime story about the moon",
      messages: [
        { id: "m1", role: "assistant", content: "Hi!", parentId: null, isActiveChild: true },
        {
          id: "m2",
          role: "user",
          content: "Star @Ghost in it",
          parentId: "m1",
          isActiveChild: false,
          characters: [{ id: "char-ghost", name: "Ghost" }]
        },
        {
          id: "m3",
          role: "user",
          content: "Star @Luna in it",
          parentId: "m1",
          isActiveChild: true,
          characters: [{ id: "char-1", name: "Luna" }]
        }
      ],
      selectedPresets: {
        bookType: "short_story",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        pageCountMode: "custom",
        targetPages: 12,
        pageCountSource: "settings"
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-kids" });
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      libraryCharacterRow({
        portraitStatus: "READY",
        portraitPath: "char-1-portrait.webp",
        appearance: "Adult woman in a black hijab and a grey embroidered top."
      })
    ]);
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-from-session",
        title: data.title,
        prompt: data.prompt,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(201);
    // Only the ACTIVE branch's mention is looked up — the edited-away Ghost
    // never reaches the book.
    expect(mockPrisma.libraryCharacter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["char-1"] } }) })
    );
    const created = mockPrisma.project.create.mock.calls.at(0)![0].data;
    expect(created.prompt).toContain("Characters from the user's library");
    expect(created.prompt).toContain("Luna");
    const snapshots = created.mediaSettings.mobile.characters;
    expect(snapshots).toEqual([
      {
        id: "char-1",
        name: "Luna",
        description: "A brave night-flying rabbit.",
        // The look travels with the copy. Without it the planner has nothing
        // but a name and a biography, invents a look to fill the gap, and the
        // invented one wins at render time over the attached portrait.
        appearance: "Adult woman in a black hijab and a grey embroidered top.",
        fields: [{ key: "Age", value: "9" }],
        portraitFile: "user-a/char-1-portrait.webp",
        // A row written before adoption existed carries no source; the
        // snapshot names the only thing it can have been.
        portraitSource: "generated"
      }
    ]);
    await app.close();
  });

  it("clamps a branch that mentions more characters than one build can carry", async () => {
    // Each message caps its own mentions at ten, but a chat is many messages
    // and the build takes their union — over-long, the payload re-parse threw
    // a ZodError straight out as a 500 that no retry could clear.
    mockAccessTokens({ "token-a": "user-a" });
    const ids = Array.from({ length: 14 }, (_, index) => `char-${index}`);
    const payload = {
      messages: ids.map((characterId, index) => ({
        id: `m${index}`,
        role: "user",
        content: `Add @Name${index}`,
        ...(index === 0 ? {} : { parentId: `m${index - 1}` }),
        isActiveChild: true,
        characters: [{ id: characterId, name: `Name${index}` }]
      })),
      selectedPresets: {
        bookType: "short_story",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        pageCountMode: "custom",
        targetPages: 12,
        pageCountSource: "settings"
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-kids" });
    const library = ids.map((characterId, index) =>
      libraryCharacterRow({ id: characterId, name: `Name${index}` })
    );
    // Two different queries reach this now: the id lookup for the snapshot, and
    // the whole-library name read the typed-mention scan makes.
    mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) =>
      where.id ? library.filter((row) => (where.id.in as string[]).includes(row.id)) : library
    );
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-many",
        title: data.title,
        prompt: data.prompt,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(201);
    // First mentioned wins — the cast the chat was built around.
    expect(mockPrisma.libraryCharacter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ids.slice(0, 10) } }) })
    );
    const created = mockPrisma.project.create.mock.calls.at(0)![0].data;
    expect(created.mediaSettings.mobile.characters).toHaveLength(10);
    await app.close();
  });

  it("snapshots a name the reader typed but never tapped", async () => {
    // `message.characters` is written only when the suggestion chip was tapped.
    // Typing "@Natalia" by hand — or tapping and then editing the message,
    // which rebuilds the text and drops the refs — sent no id at all, so the
    // book was planned *about* the saved character while carrying no snapshot
    // of them, and the planner invented the look it was told to reuse.
    const created = await buildWithMessages([
      { id: "m1", role: "user", content: "A story about @Natalia and her team", isActiveChild: true }
    ], [libraryCharacterRow({ id: "char-nat", name: "Natalia", appearance: "Black hijab, grey top." })]);

    expect(created.mediaSettings.mobile.characters).toMatchObject([
      { id: "char-nat", name: "Natalia", appearance: "Black hijab, grey top." }
    ]);
  });

  it("takes only the mention, never the bare word", async () => {
    // "Rose", "Hope" and "می" are ordinary words. Matching prose would drag a
    // saved character into every book that happened to use one, so the literal
    // "@" is required — and it has to start a word itself, or an email address
    // becomes a cast list.
    const rose = [libraryCharacterRow({ id: "char-rose", name: "Rose" })];
    for (const content of [
      "She held a rose from the garden",
      "Rose early and wrote all morning",
      "Write to rose@example.com about it"
    ]) {
      const created = await buildWithMessages(
        [{ id: "m1", role: "user", content, isActiveChild: true }],
        rose
      );
      expect(created.mediaSettings.mobile.characters).toBeUndefined();
    }
  });

  it("binds the longest name, and ignores the assistant echoing one back", async () => {
    const library = [
      libraryCharacterRow({ id: "char-luna", name: "Luna" }),
      libraryCharacterRow({ id: "char-vega", name: "Luna Vega" }),
      libraryCharacterRow({ id: "char-bram", name: "Bram" })
    ];
    const created = await buildWithMessages(
      [
        { id: "m1", role: "user", content: "Make it about @Luna Vega", isActiveChild: true },
        { id: "m2", role: "assistant", content: "Lovely — should @Bram be in it too?", parentId: "m1", isActiveChild: true }
      ],
      library
    );

    // "@Luna" sits inside "@Luna Vega" and must not bind its own character;
    // and nothing the assistant writes decides who is in the book.
    expect(created.mediaSettings.mobile.characters).toMatchObject([{ id: "char-vega", name: "Luna Vega" }]);
  });

  it("takes neither of two characters whose names fold together", async () => {
    // "Luna" and "luna" are two rows the unique index allows, and typed text
    // carries no id to tell them apart. A missing seed is a character drawn
    // from prose; a wrong one is a stranger wearing the reader's saved face.
    const created = await buildWithMessages(
      [{ id: "m1", role: "user", content: "A story about @Luna", isActiveChild: true }],
      [
        libraryCharacterRow({ id: "char-upper", name: "Luna" }),
        libraryCharacterRow({ id: "char-lower", name: "luna" })
      ]
    );

    expect(created.mediaSettings.mobile.characters).toBeUndefined();
  });

  it("treats a Devanagari vowel sign as part of the word, in both directions", async () => {
    const typed = [{ id: "m1", role: "user", content: "@मीरा को कहानी में डालो", isActiveChild: true }];

    // The fold used to strip every combining mark, and Devanagari matras are
    // combining marks: "मीरा" and "मारा" were both "मर", so this pair looked
    // like the "Luna"/"luna" collision above and neither bound. They are two
    // different people, and the typed name says which.
    const bound = await buildWithMessages(typed, [
      libraryCharacterRow({ id: "char-meera", name: "मीरा" }),
      libraryCharacterRow({ id: "char-mara", name: "मारा" })
    ]);
    expect(bound.mediaSettings.mobile.characters).toMatchObject([{ id: "char-meera", name: "मीरा" }]);

    // And the other direction: with the matra kept, a saved "मीर" is a prefix
    // of the typed "@मीरा" that ends in front of a mark rather than a letter.
    // Nothing else is standing in the way here, so `isNameCharacter` is what
    // has to refuse it — sub-token binding is how "Luna" once seeded
    // "Luna-Bear", and a wrong seed is the unrecoverable one.
    const unbound = await buildWithMessages(typed, [libraryCharacterRow({ id: "char-meer", name: "मीर" })]);
    expect(unbound.mediaSettings.mobile.characters).toBeUndefined();
  });

  it("keeps an edited-away mention out, tapped or typed", async () => {
    // The scan reads the ACTIVE branch's current text, never history, which is
    // the same rule the tapped ids already followed — expressed against the
    // words rather than against the refs.
    const created = await buildWithMessages(
      [
        { id: "m1", role: "assistant", content: "Who is it about?", parentId: null, isActiveChild: true },
        {
          id: "m2",
          role: "user",
          content: "Star @Luna in it",
          parentId: "m1",
          isActiveChild: false,
          characters: [{ id: "char-luna", name: "Luna" }]
        },
        { id: "m3", role: "user", content: "Actually, make it about a lighthouse", parentId: "m1", isActiveChild: true }
      ],
      [libraryCharacterRow({ id: "char-luna", name: "Luna" })]
    );

    expect(created.mediaSettings.mobile.characters).toBeUndefined();
  });

  it("keeps tapped mentions ahead of scanned ones when the build clamps", async () => {
    const library = [
      libraryCharacterRow({ id: "char-typed", name: "Typed" }),
      libraryCharacterRow({ id: "char-tapped", name: "Tapped" })
    ];
    await buildWithMessages(
      [
        {
          id: "m1",
          role: "user",
          content: "A story with @Typed in it",
          isActiveChild: true,
          characters: [{ id: "char-tapped", name: "Tapped" }]
        }
      ],
      library
    );

    // First mentioned wins is still the rule and a scan only ever appends, so
    // the cast the chat was built around is the cast that survives the clamp.
    // The order of the *lookup* is what carries that, not the row order.
    const lookup = mockPrisma.libraryCharacter.findMany.mock.calls
      .map((call: any[]) => call[0].where.id?.in as string[] | undefined)
      .find(Boolean);
    expect(lookup).toEqual(["char-tapped", "char-typed"]);
  });

  it("carries adopted artwork into the book, and its provenance with it", async () => {
    // The whole point of the upload path: a reader who attached their own
    // drawing gets that drawing into the book, and the renderer is told it is
    // artwork to re-pose rather than a portrait to reinterpret.
    mockAccessTokens({ "token-a": "user-a" });
    const payload = {
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Star @Luna in it",
          isActiveChild: true,
          characters: [{ id: "char-1", name: "Luna" }]
        }
      ],
      selectedPresets: {
        bookType: "short_story",
        lengthPreset: "short",
        qualityPreset: "balanced",
        imagesEnabled: true,
        pageCountMode: "custom",
        targetPages: 12,
        pageCountSource: "settings"
      }
    };
    mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: "session-draft", payload }));
    mockPrisma.template.findFirst.mockResolvedValue({ id: "template-kids" });
    mockPrisma.libraryCharacter.findMany.mockResolvedValue([
      libraryCharacterRow({
        portraitStatus: "READY",
        portraitPath: "char-1-portrait.jpg",
        portraitSource: "ADOPTED_UPLOAD"
      })
    ]);
    mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
      projectRecord({
        id: "project-adopted",
        title: data.title,
        prompt: data.prompt,
        mediaSettings: data.mediaSettings,
        currentPlan: null,
        pages: [],
        _count: { pages: 0, images: 0, jobs: 0 }
      })
    );
    mockPrisma.mobileCreationDraft.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      creationDraftRecord({ id: "session-draft", payload, ...data })
    );
    mockPrisma.project.update.mockResolvedValue({});
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-plan" }));
    const app = await buildMobileApp({ advisorEnrichment: false, creationEnrichment: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/creation-sessions/session-draft/build",
      headers: bearer("token-a"),
      payload: {}
    });

    expect(response.statusCode).toBe(201);
    const created = mockPrisma.project.create.mock.calls.at(0)![0].data;
    expect(created.mediaSettings.mobile.characters).toEqual([
      {
        id: "char-1",
        name: "Luna",
        description: "A brave night-flying rabbit.",
        fields: [{ key: "Age", value: "9" }],
        portraitFile: "user-a/char-1-portrait.jpg",
        portraitSource: "adopted_upload"
      }
    ]);
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
});
