import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = await vi.hoisted(async () => ({
  continuityFindMany: vi.fn(),
  researchFindMany: vi.fn(),
  retrieveSemanticResearchNotes: vi.fn(),
  retrieveLexicalContinuityNotes: vi.fn(),
  /**
   * The shared degrade stand-in from `testing/degradeRetrievalArmFake.ts`. What
   * this file has to prove is that the lexical arm is handed to the policy at
   * all — the hybrid page-memory retrieval hand-rolled its own wrap instead and
   * lost both arms to one pg_trgm fault.
   */
  degradeRetrievalArm: (await import("./testing/degradeRetrievalArmFake.js")).createDegradeRetrievalArmFake()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: {
    continuityNote: { findMany: mocks.continuityFindMany },
    researchSource: { findMany: mocks.researchFindMany }
  },
  retrieveLexicalContinuityNotes: mocks.retrieveLexicalContinuityNotes,
  degradeRetrievalArm: mocks.degradeRetrievalArm,
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("./researchMemory.js", () => ({ retrieveSemanticResearchNotes: mocks.retrieveSemanticResearchNotes }));

import { CONTINUITY_NOTE_PROMPT_LIMITS, continuityNotesForPrompt } from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { loadContinuityNotes, loadResearchNotesForGeneration } from "./generationContext.js";

describe("loadContinuityNotes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps owned page notes and project notes while excluding ambiguous legacy page scopes", async () => {
    mocks.continuityFindMany.mockResolvedValue([
      { id: "n1", body: "A current page fact." },
      { id: "n2", body: "A project-wide rule." }
    ]);

    // Ascending priority: `createdAt: desc` picked the newest two, and the
    // newest ends up last, where a truncating prompt keeps it.
    await expect(loadContinuityNotes("project-1", { beforePageIndex: null })).resolves.toEqual([
      "A project-wide rule.",
      "A current page fact."
    ]);
    expect(mocks.continuityFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        NOT: { pageId: null, scope: { startsWith: "page:" } }
      },
      orderBy: { createdAt: "desc" },
      take: 28,
      select: { id: true, body: true }
    });
    expect(mocks.retrieveLexicalContinuityNotes).not.toHaveBeenCalled();
  });

  it("takes the same recency window in both branches, so the two projections cannot drift", async () => {
    mocks.continuityFindMany.mockResolvedValue([]);
    mocks.retrieveLexicalContinuityNotes.mockResolvedValue([]);

    await loadContinuityNotes("project-1", { beforePageIndex: null });
    await loadContinuityNotes("project-1", { queryTerms: ["Tomas"], beforePageIndex: null });

    const [recencyOnly, withTerms] = mocks.continuityFindMany.mock.calls;
    expect(recencyOnly).toEqual(withTerms);
    // Two columns, because two are read: `body` is the only thing that leaves
    // this function and `id` only ever dedupes these rows against the lexical
    // arm's, whose rows are the same shape. The no-terms branch used to pass no
    // `select` at all, hydrating `scope`, `tags`, `pageId` and `createdAt` for
    // 28 rows that are read one column deep.
    expect(recencyOnly?.[0]?.select).toEqual({ id: true, body: true });
  });

  it("gives entity-named notes a relevance share and backfills the rest with recency", async () => {
    // The lexical arm returns needle-ranked hits; a hit also present in the
    // recency list is emitted once. Relevance hits outrank recency for the
    // budget, and the result is emitted lowest priority first — so the
    // best-scoring hit is last and the recency backfill leads.
    mocks.continuityFindMany.mockResolvedValue([
      { id: "n1", body: "The newest fact." },
      { id: "n2", body: "The brass key is on page four." }
    ]);
    mocks.retrieveLexicalContinuityNotes.mockResolvedValue([
      { id: "n2", body: "The brass key is on page four." },
      { id: "n3", body: "Tomas guards the vault." }
    ]);

    const notes = await loadContinuityNotes("project-1", { queryTerms: ["Tomas", "the vault"], beforePageIndex: null });

    expect(notes).toEqual(["The newest fact.", "Tomas guards the vault.", "The brass key is on page four."]);
    // The recency fetch takes the whole budget so a thin lexical result never
    // wastes slots; the lexical arm is capped at half.
    expect(mocks.continuityFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        NOT: { pageId: null, scope: { startsWith: "page:" } }
      },
      orderBy: { createdAt: "desc" },
      take: 28,
      select: { id: true, body: true }
    });
    expect(mocks.retrieveLexicalContinuityNotes).toHaveBeenCalledWith({
      projectId: "project-1",
      queryTerms: ["Tomas", "the vault"],
      topK: 14,
      beforePageIndex: null
    });
  });

  it("stays pure recency when no distinctive terms exist, instead of ranking by noise", async () => {
    // A page whose brief names no entity has nothing worth needling for; the
    // old behaviour of querying with whatever text was at hand is what let
    // stop-word trigram overlap displace half the recency window.
    mocks.continuityFindMany.mockResolvedValue([{ id: "n1", body: "A current page fact." }]);

    await expect(loadContinuityNotes("project-1", { queryTerms: ["", "  "], beforePageIndex: null })).resolves.toEqual([
      "A current page fact."
    ]);
    expect(mocks.continuityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 28, orderBy: { createdAt: "desc" } })
    );
    expect(mocks.retrieveLexicalContinuityNotes).not.toHaveBeenCalled();
  });

  it("degrades to recency-only when lexical retrieval fails", async () => {
    mocks.continuityFindMany.mockResolvedValue([
      { id: "n1", body: "The newest fact." },
      { id: "n2", body: "The brass key is on page four." }
    ]);
    const lexicalFailure = new Error("function strict_word_similarity does not exist");
    mocks.retrieveLexicalContinuityNotes.mockRejectedValue(lexicalFailure);

    await expect(loadContinuityNotes("project-1", { queryTerms: ["Tomas"], beforePageIndex: null })).resolves.toEqual([
      "The brass key is on page four.",
      "The newest fact."
    ]);

    expect(mocks.continuityFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        NOT: { pageId: null, scope: { startsWith: "page:" } }
      },
      orderBy: { createdAt: "desc" },
      take: 28,
      select: { id: true, body: true }
    });
    expect(mocks.degradeRetrievalArm).toHaveBeenCalledWith({
      arm: "Lexical continuity retrieval",
      projectId: "project-1",
      error: lexicalFailure,
      fallback: [],
      // The stop signal is not this arm's to swallow: a stopped generation has
      // to reach the job runner as a stop, not as a thinner context pack.
      rethrowIf: expect.any(Function)
    });
  });
});

describe("loadResearchNotesForGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retrieveSemanticResearchNotes.mockResolvedValue([]);
  });

  it("drops URL-less bootstrap rows and keeps reader-facing sources", async () => {
    mocks.researchFindMany.mockResolvedValue([
      { query: "bootstrap", title: "Gemini grounded summary", summary: "No link.", url: null },
      { query: "archive", title: "Boundary papers", summary: "Commission records.", url: "https://example.com/papers" },
      { query: "blank", title: "Blank link", summary: "Not citeable.", url: "   " }
    ]);

    await expect(
      loadResearchNotesForGeneration("project-1", { researchDepth: 0 } as never)
    ).resolves.toEqual(["Boundary papers: Commission records."]);
  });

  it("filters semantic hits through the same URL-backed source set", async () => {
    mocks.researchFindMany.mockResolvedValue([
      { query: "bootstrap", title: "Grounding summary", summary: "No link.", url: null },
      { query: "archive", title: "Boundary papers", summary: "Commission records.", url: "https://example.com/papers" }
    ]);
    mocks.retrieveSemanticResearchNotes.mockResolvedValue([
      "Grounding summary: No link.",
      "Boundary papers: Commission records."
    ]);

    await expect(
      loadResearchNotesForGeneration(
        "project-1",
        { researchDepth: 4 } as never,
        undefined,
        { embedding: { embed: async () => [0.1] }, queryText: "commission" }
      )
    ).resolves.toEqual(["Boundary papers: Commission records."]);
  });

  it("lets a semantic stop outrank a concurrent research-source read failure", async () => {
    const stop = new StopRequestedError();
    mocks.retrieveSemanticResearchNotes.mockRejectedValue(stop);
    mocks.researchFindMany.mockRejectedValue(new Error("research source read failed"));

    await expect(
      loadResearchNotesForGeneration(
        "project-1",
        { researchDepth: 4 } as never,
        undefined,
        { embedding: { embed: async () => [0.1] }, queryText: "commission" }
      )
    ).rejects.toBe(stop);
  });
});

/**
 * The producer's ordering and the consumers' truncation are one contract, and
 * they live in two workspaces — which is how they came to disagree. These cases
 * hold the real `loadContinuityNotes` result against the real
 * `continuityNotesForPrompt` limits from `@book-maker/core`, at the full budget
 * where truncation actually bites.
 */
describe("loadContinuityNotes ordering against the prompt limits", () => {
  beforeEach(() => vi.clearAllMocks());

  // `retrieveLexicalContinuityNotes` orders by `similarity DESC`, so index 0 is
  // the best-scoring hit — the one a `.slice(-20)` used to throw away first.
  const lexical = Array.from({ length: 14 }, (_, index) => ({
    id: `lex-${index}`,
    body: `Relevance hit ${index}: Tomas guards the vault.`
  }));
  // `createdAt: desc`, so index 0 is the newest note.
  const recency = Array.from({ length: 28 }, (_, index) => ({
    id: `rec-${index}`,
    body: `Recency note ${index}.`
  }));

  it("leaves every relevance hit inside the tightest prompt's window", async () => {
    mocks.continuityFindMany.mockResolvedValue(recency);
    mocks.retrieveLexicalContinuityNotes.mockResolvedValue(lexical);

    const notes = await loadContinuityNotes("project-1", { queryTerms: ["Tomas"], beforePageIndex: null });

    expect(notes).toHaveLength(28);
    expect(notes.at(-1)).toBe(lexical[0]!.body);

    for (const limit of Object.values(CONTINUITY_NOTE_PROMPT_LIMITS)) {
      const kept = continuityNotesForPrompt(notes, limit);
      expect(kept).toHaveLength(limit);
      // The best-scoring hit lands closest to the model's attention, and no
      // hit is trimmed away: the review prompt keeps 20 of these 28, and it
      // used to spend that budget dropping the eight best hits.
      expect(kept.at(-1)).toBe(lexical[0]!.body);
      expect(kept.filter((note) => note.startsWith("Relevance hit"))).toHaveLength(lexical.length);
    }
  });

  it("leaves the newest notes inside the window when there is no relevance arm", async () => {
    mocks.continuityFindMany.mockResolvedValue(recency);

    const notes = await loadContinuityNotes("project-1", { beforePageIndex: null });
    const kept = continuityNotesForPrompt(notes, CONTINUITY_NOTE_PROMPT_LIMITS.review);

    expect(notes.at(-1)).toBe(recency[0]!.body);
    expect(kept).toHaveLength(CONTINUITY_NOTE_PROMPT_LIMITS.review);
    expect(kept.at(-1)).toBe(recency[0]!.body);
    expect(kept).not.toContain(recency[CONTINUITY_NOTE_PROMPT_LIMITS.review]!.body);
  });
});

/**
 * The forward bound, against a store that behaves like the two queries rather
 * than against a canned answer. `ContinuityNote` is not a prefix of the
 * manuscript: pages generate in waves, and a FAILED_QA page is redrafted long
 * after its successors are COMPLETED and have written notes of their own — so
 * "the newest notes" and "the best-matching notes" both reach forward, into
 * prose the page being drafted has not happened yet.
 *
 * The fakes below apply the bound the way each real query does — the recency
 * arm through the `page` relation Prisma is handed, the lexical arm through the
 * `beforePageIndex` it is passed — so a bound that never leaves this function
 * shows up here as the later note coming back.
 */
describe("loadContinuityNotes forward bound", () => {
  type FixtureNote = { id: string; body: string; pageIndex: number | null; createdAt: number };

  /** A finished 60-page book. Page 30 is the one being redrafted. */
  const fixture: FixtureNote[] = [
    { id: "p12", body: "Tomas has never been inside the Vault of Hours.", pageIndex: 12, createdAt: 12 },
    { id: "p28", body: "Tomas carries his grandfather's brass key everywhere.", pageIndex: 28, createdAt: 28 },
    // The strongest lexical match in the book for this page's own cast, and
    // written fifteen pages after it.
    { id: "p45", body: "The Vault of Hours opens and the archive burns; Tomas walks out through the ash.", pageIndex: 45, createdAt: 45 },
    { id: "p58", body: "Mira repaints the observatory door.", pageIndex: 58, createdAt: 58 },
    { id: "p59", body: "The harbour freezes early that year.", pageIndex: 59, createdAt: 59 },
    { id: "p60", body: "Mira keeps the last ledger under her bunk.", pageIndex: 60, createdAt: 60 },
    // No page of its own: a project-scoped rule, which no page bound applies to.
    { id: "book", body: "The book is narrated in the past tense.", pageIndex: null, createdAt: 1 }
  ];

  /** The `page: { index: { lt } }` arm of the relation filter, or null. */
  const relationBound = (where: { OR?: Array<{ page?: { index?: { lt?: number } } }> }): number | null =>
    where.OR?.find((arm) => arm.page)?.page?.index?.lt ?? null;

  /**
   * Absent and `null` are the same thing to a store: no predicate is no bound.
   * Modelling it that way is what makes these cases fail against a
   * `loadContinuityNotes` that never sends one, instead of failing because the
   * fixture went empty.
   */
  const withinBound = (note: FixtureNote, bound: number | null | undefined): boolean =>
    bound === null || bound === undefined || note.pageIndex === null || note.pageIndex < bound;

  beforeEach(() => {
    vi.clearAllMocks();
    // Recency: newest first, cut to `take`, bounded before the cut.
    mocks.continuityFindMany.mockImplementation(
      async (args: { where: { OR?: Array<{ page?: { index?: { lt?: number } } }> }; take: number }) => {
        const bound = relationBound(args.where);
        return fixture
          .filter((note) => withinBound(note, bound))
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, args.take)
          .map((note) => ({ id: note.id, body: note.body }));
      }
    );
    // Lexical: needle hits, best score first, bounded in the same query as the
    // `LIMIT` — a longer match scores higher, which is what makes the page-45
    // note the top hit for this page's own cast.
    mocks.retrieveLexicalContinuityNotes.mockImplementation(
      async (options: { queryTerms: string[]; topK: number; beforePageIndex?: number | null }) => {
        const scored = fixture
          .filter((note) => withinBound(note, options.beforePageIndex))
          .map((note) => ({
            note,
            score: options.queryTerms.filter((term) => note.body.includes(term)).length
          }))
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score || right.note.createdAt - left.note.createdAt);
        return scored.slice(0, options.topK).map((hit) => ({ id: hit.note.id, body: hit.note.body }));
      }
    );
  });

  it("never hands a page-30 redraft a note page 45 wrote, however well it matches", async () => {
    const notes = await loadContinuityNotes("project-1", {
      queryTerms: ["Tomas", "the Vault of Hours"],
      beforePageIndex: 30
    });

    // The best lexical hit in the whole book for these needles, and the end of
    // the list is the end every prompt keeps — so an unbounded arm puts the
    // book's ending closest to the model's attention while page 30 is written.
    expect(notes).not.toContain("The Vault of Hours opens and the archive burns; Tomas walks out through the ash.");
    // Bounded on the recency side too: one arm stopping at the page while the
    // other keeps ranking the future in leaves the leak and the guarantee both
    // standing.
    expect(notes).not.toContain("Mira repaints the observatory door.");
    expect(notes).not.toContain("The harbour freezes early that year.");
    expect(notes).not.toContain("Mira keeps the last ledger under her bunk.");
    // What it does get: its own past, and the project-scoped rule that belongs
    // to no page.
    expect(notes).toContain("Tomas has never been inside the Vault of Hours.");
    expect(notes).toContain("Tomas carries his grandfather's brass key everywhere.");
    expect(notes).toContain("The book is narrated in the past tense.");
    expect(mocks.retrieveLexicalContinuityNotes).toHaveBeenCalledWith(
      expect.objectContaining({ beforePageIndex: 30 })
    );
  });

  it("bounds the recency arm through the page relation, not the display scope", async () => {
    await loadContinuityNotes("project-1", { beforePageIndex: 30 });

    // `page:<index>` is display text the schema refuses as identity, and an
    // edit's notes are scoped `page:<index>:edit:<operationId>`, which no
    // `page:<integer>` reader can place at all. The `pageId` foreign key can.
    expect(mocks.continuityFindMany).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        NOT: { pageId: null, scope: { startsWith: "page:" } },
        OR: [{ pageId: null }, { page: { projectId: "project-1", index: { lt: 30 } } }]
      },
      orderBy: { createdAt: "desc" },
      take: 28,
      select: { id: true, body: true }
    });
  });

  it("still spans the whole book for the loads that say so", async () => {
    // The reviewer, the whole-book passes and a page inserted into finished
    // prose all judge a draft against what the book now holds, later pages
    // included — `null` is that claim, and it has to keep meaning it.
    const notes = await loadContinuityNotes("project-1", {
      queryTerms: ["Tomas", "the Vault of Hours"],
      beforePageIndex: null
    });

    expect(notes).toContain("The Vault of Hours opens and the archive burns; Tomas walks out through the ash.");
    expect(notes).toContain("Mira keeps the last ledger under her bunk.");
  });
});
