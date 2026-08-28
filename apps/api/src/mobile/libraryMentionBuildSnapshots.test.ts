import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { BUILD_CHARACTER_SNAPSHOT_LIMIT } from "../mobileCreationSchemas.js";
import { enqueueGenerationJob } from "../queue.js";
import {
  bearer,
  buildMobileApp,
  creationDraftRecord,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * What `POST /api/mobile/creation-sessions/:id/build` freezes into
 * `mediaSettings.mobile.characters` — the tapped refs, the typed-`@name` sweep
 * that finds the ones nobody tapped, and the look and provenance that travel
 * with each copy. The build is the moment the live library stops being read,
 * so a name bound wrongly here is a saved face on a stranger for the life of
 * the book.
 *
 * Its own suite because `libraryMentionChats.test.ts` was at its size budget, the
 * same reason `characterReads.test.ts` and `characterWriteConflicts.test.ts`
 * are their own; that file keeps the two chat surfaces, where a mention is
 * still a live read.
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
  // Several tests build more than once, and each build is its own book: the
  // plan job's dedupe key is `plan-book:<projectId>`, so a shared project id
  // would put every later attempt on the first one's job — the re-parent
  // `startGenerationAttempt` refuses.
  const build = (buildSequence += 1);
  const draftId = `session-draft-${build}`;
  const payload = { payloadVersion: 3, messages, selectedPresets: BUILD_PRESETS };
  mockPrisma.mobileCreationDraft.findFirst.mockResolvedValue(creationDraftRecord({ id: draftId, payload }));
  mockPrisma.template.findFirst.mockResolvedValue({ id: "template-kids" });
  // The typed-mention scan and graph expansion both load the bounded library.
  mockPrisma.libraryCharacter.findMany.mockImplementation(async ({ where }: { where: any }) =>
    where.id ? library.filter((row) => (where.id.in as string[]).includes(row.id as string)) : library
  );
  mockPrisma.project.create.mockImplementation(async ({ data }: { data: Record<string, any> }) =>
    projectRecord({
      id: `project-from-session-${build}`,
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
  vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: `job-plan-${build}` }));
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
    // The snapshot is fetched by id, never by reading the whole library: the
    // edited-away Ghost never becomes a root, so it is not even asked for.
    expect(mockPrisma.libraryCharacter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["char-1"] }, userId: "user-a" },
        include: expect.any(Object)
      })
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
    const created = mockPrisma.project.create.mock.calls.at(0)![0].data;
    expect(created.mediaSettings.mobile.characters).toHaveLength(10);
    expect(created.mediaSettings.mobile.characters.map((character: { id: string }) => character.id)).toEqual(
      ids.slice(0, 10)
    );
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

  it("binds nobody inside a hyphenated word the composer also refused", async () => {
    // The composer and this sweep must agree, and the agreed answer must be
    // the visible one: a hyphen reads as ordinary punctuation to a boundary
    // test, so "@Luna-Bear" showed no chip, attached no id — and was bound
    // here anyway, snapshotting a saved face onto a character nobody named.
    const luna = [libraryCharacterRow({ id: "char-luna", name: "Luna" })];
    const unbound = await buildWithMessages(
      [{ id: "m1", role: "user", content: "A story about @Luna-Bear", isActiveChild: true }],
      luna
    );
    expect(unbound.mediaSettings.mobile.characters).toBeUndefined();

    // The hyphen belongs to the saved name here, and longest-first is what
    // lets it claim its own whole token.
    const bear = await buildWithMessages(
      [{ id: "m1", role: "user", content: "A story about @Luna-Bear", isActiveChild: true }],
      [...luna, libraryCharacterRow({ id: "char-bear", name: "Luna-Bear" })]
    );
    expect(bear.mediaSettings.mobile.characters).toMatchObject([{ id: "char-bear", name: "Luna-Bear" }]);

    // A hyphen that joins nothing is punctuation, and a possessive ends the
    // token rather than swallowing it.
    for (const content of ["A story about @Luna - the rabbit", "A story about @Luna's hat"]) {
      const bound = await buildWithMessages(
        [{ id: "m1", role: "user", content, isActiveChild: true }],
        luna
      );
      expect(bound.mediaSettings.mobile.characters).toMatchObject([{ id: "char-luna", name: "Luna" }]);
    }
  });

  it("binds nobody after an astral letter the composer also refused", async () => {
    // UTF-16: 𐐀 is two units, and `@` sits at index 2. A boundary test that
    // reads haystack[at - 1] sees the trailing surrogate, which is not `\p{L}`,
    // and binds Luna — the composer, which backs up to the code point, does not.
    const created = await buildWithMessages(
      [{ id: "m1", role: "user", content: "𐐀@Luna", isActiveChild: true }],
      [libraryCharacterRow({ id: "char-luna", name: "Luna" })]
    );
    expect(created.mediaSettings.mobile.characters).toBeUndefined();
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
    // Nothing else is standing in the way here, so `isLibraryMentionNameCharacterAt` is what
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
    const created = await buildWithMessages(
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

    // First mentioned wins is still the rule and a scan only ever appends.
    expect(created.mediaSettings.mobile.characters.map((character: { id: string }) => character.id)).toEqual([
      "char-tapped",
      "char-typed"
    ]);
  });

  it("snapshots recursively linked profiles, portraits, and plain generation prose", async () => {
    const bram = libraryCharacterRow({
      id: "char-bram",
      name: "Bram",
      description: "A careful navigator.",
      appearance: "Tall, with a blue coat.",
      portraitStatus: "READY",
      portraitPath: "char-bram-portrait.webp"
    });
    const luna = libraryCharacterRow({
      id: "char-luna",
      name: "Luna",
      description: "Travels with @Bram.",
      outgoingMentions: [linkedCharacter(bram)]
    });
    const created = await buildWithMessages(
      [
        {
          id: "m1",
          role: "user",
          content: "A story about @Luna",
          isActiveChild: true,
          characters: [{ id: "char-luna", name: "Luna" }]
        }
      ],
      [bram, luna]
    );

    expect(created.mediaSettings.mobile.characters).toMatchObject([
      { id: "char-luna", description: "Travels with Bram." },
      {
        id: "char-bram",
        appearance: "Tall, with a blue coat.",
        portraitFile: "user-a/char-bram-portrait.webp"
      }
    ]);
    expect(created.prompt).not.toContain("@Bram");
  });

  it("spends the build's own snapshot limit on the expansion, not a cap the graph re-applies", async () => {
    // `BUILD_CHARACTER_SNAPSHOT_LIMIT` is the total this sweep owns — the
    // number `mobileCreationCharacterSnapshotSchema` accepts — and
    // `expandLibraryCharacterGraph` used to `Math.min` it against the chat's
    // own mention cap on the way in. Both are ten today, so the clamp was
    // invisible: raise this constant and the sweep would still have been handed
    // ten sheets, with the rest missing from the book and nothing at the call
    // site saying the argument had been ignored.
    const linkedRefs = Array.from({ length: BUILD_CHARACTER_SNAPSHOT_LIMIT + 4 }, (_, index) => ({
      id: `char-linked-${index}`,
      name: `Linked${index}`
    }));
    const linked = linkedRefs.map((ref) => libraryCharacterRow({ ...ref, description: "A friend." }));
    const luna = libraryCharacterRow({
      id: "char-luna",
      name: "Luna",
      description: "Travels with a crowd.",
      outgoingMentions: linkedRefs.map((ref, index) => linkedCharacter(ref, index))
    });

    const created = await buildWithMessages(
      [
        {
          id: "m1",
          role: "user",
          content: "A story about @Luna",
          isActiveChild: true,
          characters: [{ id: "char-luna", name: "Luna" }]
        }
      ],
      [luna, ...linked]
    );

    // The tapped root, then the description's own order until the total is
    // spent — ten today, and whatever this constant says tomorrow.
    expect(created.mediaSettings.mobile.characters).toHaveLength(BUILD_CHARACTER_SNAPSHOT_LIMIT);
    expect(created.mediaSettings.mobile.characters.map((character: { id: string }) => character.id)).toEqual([
      "char-luna",
      ...linkedRefs.slice(0, BUILD_CHARACTER_SNAPSHOT_LIMIT - 1).map((ref) => ref.id)
    ]);
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
