import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./client.ts";
import { retrieveHybridEmbeddings } from "./hybridRetrieval.ts";
import {
  LEXICAL_SIMILARITY_FLOOR,
  foldLexicalText,
  lexicalFoldSql,
  retrieveLexicalContinuityNotes,
  retrieveLexicalEmbeddings
} from "./lexicalRetrieval.ts";

/**
 * Opt-in integration suite against a real pg_trgm. Everything else in the
 * repo mocks the SQL, so nothing in the ordinary run can catch a ranking
 * function that measurably selects the wrong rows — the shipped first draft
 * ranked with symmetric `similarity()`, which scored a verbatim "brass key"
 * inside a ~370-char summary at 0.04 (excluded by its own floor) while two
 * completely unrelated notes outranked the related one on stop-word trigrams.
 * These tests re-run those scenarios against the database engine itself.
 *
 * Run with the dev container from `make up` (or any DATABASE_URL):
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/db exec vitest run src/lexicalRetrieval.integration.test.ts
 *
 * Without that variable `vitest.config.ts` keeps this file out of collection
 * entirely. Skipping the bodies is not enough on its own: the `prisma` import
 * above builds a client and a pg pool the moment the module is evaluated, in a
 * run that is supposed to need no database. The `skipIf` below is the second
 * guard, for a runner that reaches this file under some other config.
 */
const enabled = process.env.DB_INTEGRATION === "true";

const projectId = `trgm-integration-${randomUUID()}`;
const userId = `trgm-integration-user-${randomUUID()}`;

const BRASS_KEY_SUMMARY =
  "Tomas searches the abandoned clockmaker's shop at dusk, moving between overturned workbenches and " +
  "shattered display cases. Beneath a loose floorboard under the stairs he discovers a small brass key " +
  "wrapped in oilcloth, its teeth cut in an unfamiliar pattern. He pockets it as footsteps echo from the " +
  "alley outside, and slips out through the rear window into the rain.";

const UNRELATED_SUMMARY =
  "Mira argues with the harbormaster about the delayed shipment of lanterns while gulls wheel over the " +
  "quay. She counts the crates twice, finds one short, and accuses the dockhands of theft before noticing " +
  "the customs seal was never broken. Embarrassed, she pays the tariff and wheels the cart home through " +
  "the fish market as the tide comes in.";

const PERSIAN_SUMMARY =
  "توماس در مغازه ساعت‌ساز متروکه جست‌وجو می‌کند و میان میزهای کار واژگون حرکت می‌کند. " +
  "زیر تخته‌ای لق او یک کلید برنجی کوچک پیچیده در پارچه روغنی پیدا می‌کند و آن را در جیب می‌گذارد.";

const VAULT_SEALED =
  "Tomas circles the vault a third time, counting the rivets on its face and finding no seam wide enough " +
  "for a blade. The vault holds, as it has held since his grandfather sealed it, and he goes back up the " +
  "stairs with nothing but the shape of the lock memorised.";

const VAULT_OPENED =
  "The vault swings open at last and the archive behind it takes the lamplight badly, every ledger " +
  "curling as the air changes. Tomas reads two pages before the smoke drives him out, and by morning the " +
  "vault is a cold black mouth in the observatory floor.";

const VAULT_RESEARCH =
  "Nineteenth-century strongroom construction: a bank vault of the period was faced in wrought iron over " +
  "a brick core, and the lock furniture was fitted last so the vault door could be hung before the " +
  "mechanism arrived from the maker.";

/** The shape generatePage composes: purpose+beat, chapter title+summary, premise. */
const COMPOSED_BRIEF =
  "Tomas finally opens the locked vault beneath the observatory. The key he carries at last meets the " +
  "lock it was cut for, and the door swings open on the archive.\n" +
  "The Vault of Hours. Tomas descends into the hidden archive and confronts what his grandfather left behind.\n" +
  "A boy inherits a broken clock and a mystery.";

describe.skipIf(!enabled)("pg_trgm lexical retrieval (opt-in integration)", () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    await prisma.project.create({
      data: {
        id: projectId,
        userId,
        title: "Trigram retrieval fixture",
        prompt: "fixture",
        category: "STORY",
        targetPages: 10,
        complexity: 1,
        temperature: 0.5,
        mediaSettings: {}
      }
    });
    // The Prisma model has no vector field (the column is raw-SQL only), so
    // these rows land with a NULL vector — exactly the state of an embedding
    // outage, which is what the lexical arm must survive.
    await prisma.embedding.createMany({
      data: [
        { projectId, scope: "page:1", sourceId: null, text: BRASS_KEY_SUMMARY, metadata: {} },
        { projectId, scope: "page:2", sourceId: null, text: UNRELATED_SUMMARY, metadata: {} },
        { projectId, scope: "page:3", sourceId: null, text: PERSIAN_SUMMARY, metadata: {} }
      ]
    });
    await prisma.continuityNote.createMany({
      data: [
        {
          projectId,
          scope: "project",
          body: "The brass key is hidden beneath a loose floorboard in the clockmaker's shop.",
          tags: []
        },
        { projectId, scope: "project", body: "Tomas has not slept since the funeral and mistrusts the constable.", tags: [] },
        { projectId, scope: "project", body: "The dragon prefers to sleep in the warm ashes of the forge after sunset.", tags: [] },
        { projectId, scope: "project", body: "Captain Ortega keeps his medals in a velvet-lined box beneath his bunk.", tags: [] },
        // An unowned legacy page-scoped note: matched by needle, but the
        // ownership filter must keep it out of any generation prompt.
        { projectId, scope: "page:9", body: "Tomas keeps the brass key.", tags: [] }
      ]
    });
  });

  afterAll(async () => {
    // Explicit child-first deletes rather than trusting every FK in an
    // arbitrary DATABASE_URL target to cascade.
    await prisma.continuityNote.deleteMany({ where: { projectId } });
    await prisma.embedding.deleteMany({ where: { projectId } });
    await prisma.page.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("finds the page whose summary contains the needle verbatim, at full score", async () => {
    // similarity('brass key', <this summary>) measures 0.04 — the first draft's
    // floor of 0.05 excluded the exact-phrase match this feature exists for.
    const rows = await retrieveLexicalEmbeddings({
      projectId,
      queryTerms: ["brass key"],
      scopePrefix: "page:"
    });

    expect(rows.map((row) => row.scope)).toEqual(["page:1"]);
    expect(rows[0]?.similarity).toBeCloseTo(1, 4);
  });

  it("recalls Persian text by a Persian needle with no per-language config", async () => {
    const rows = await retrieveLexicalEmbeddings({
      projectId,
      queryTerms: ["کلید برنجی"],
      scopePrefix: "page:"
    });

    expect(rows.map((row) => row.scope)).toEqual(["page:3"]);
    expect(rows[0]?.similarity).toBeCloseTo(1, 4);
  });

  it("keeps a natural-language question above the floor and unrelated prose below it", async () => {
    const rows = await retrieveLexicalEmbeddings({
      projectId,
      queryTerms: ["what happened to the brass key"],
      scopePrefix: "page:"
    });

    expect(rows.map((row) => row.scope)).toEqual(["page:1"]);
  });

  it("returns pages lexical-only when the embedding arm is down", async () => {
    const rows = await retrieveHybridEmbeddings({
      projectId,
      vector: [],
      queryTerms: ["brass key"],
      scopePrefix: "page:",
      rethrowIf: null
    });

    expect(rows.map((row) => row.scope)).toEqual(["page:1"]);
    expect(rows[0]?.lexicalSimilarity).toBeCloseTo(1, 4);
    expect(rows[0]?.cosineSimilarity).toBe(0);
  });

  it("treats a whole composed brief as no needle at all", async () => {
    // A ~300-char brief scores ≤ 0.21 against everything — related or not — so
    // it must select nothing rather than rank the corpus by stop-word noise.
    const [embeddings, notes] = await Promise.all([
      retrieveLexicalEmbeddings({ projectId, queryTerms: [COMPOSED_BRIEF], scopePrefix: "page:" }),
      retrieveLexicalContinuityNotes({ projectId, queryTerms: [COMPOSED_BRIEF], beforePageIndex: null })
    ]);

    expect(embeddings).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("selects continuity notes by entity needle and excludes unrelated same-language notes", async () => {
    // The first draft's symmetric ranking scored the unrelated dragon (0.08)
    // and Ortega (0.106) notes above the note sharing the name (0.065).
    const notes = await retrieveLexicalContinuityNotes({
      projectId,
      queryTerms: ["Tomas", "brass key"],
      beforePageIndex: null
    });

    const bodies = notes.map((note) => note.body);
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual(
      expect.arrayContaining([
        "The brass key is hidden beneath a loose floorboard in the clockmaker's shop.",
        "Tomas has not slept since the funeral and mistrusts the constable."
      ])
    );
  });

  it("never returns an unowned legacy page-scoped note, however well it matches", async () => {
    const notes = await retrieveLexicalContinuityNotes({ projectId, queryTerms: ["Tomas keeps the brass key"], beforePageIndex: null });

    expect(notes.map((note) => note.body)).not.toContain("Tomas keeps the brass key.");
  });

  /**
   * `beforePageIndex` against the engine. Two things only a real Postgres can
   * answer: that the index really is read out of the scope string, and that the
   * cast which reads it resolves a `research:` scope to NULL instead of
   * erroring — `AND` is not evaluated left to right, so a guard-then-cast
   * predicate would have taken the whole retrieval down with it.
   */
  describe("page-index bound", () => {
    const boundProjectScopes = ["page:29", "page:41", "research:vault"];

    beforeAll(async () => {
      await prisma.embedding.createMany({
        data: [
          { projectId, scope: "page:29", sourceId: null, text: VAULT_SEALED, metadata: {} },
          { projectId, scope: "page:41", sourceId: null, text: VAULT_OPENED, metadata: {} },
          { projectId, scope: "research:vault", sourceId: null, text: VAULT_RESEARCH, metadata: {} }
        ]
      });
      // Real pages, because the continuity-note bound goes through the `pageId`
      // foreign key rather than the scope string — the half of it a mock cannot
      // vouch for is that the join finds them.
      for (const [index, text] of [[29, VAULT_SEALED] as const, [41, VAULT_OPENED] as const]) {
        await prisma.page.create({
          data: {
            id: `${projectId}-page-${index}`,
            projectId,
            index,
            title: `Page ${index}`,
            markdown: text,
            summary: text,
            status: "COMPLETED"
          }
        });
      }
      await prisma.continuityNote.createMany({
        data: [
          {
            projectId,
            pageId: `${projectId}-page-29`,
            scope: "page:29",
            body: "The vault is still sealed and Tomas has never seen inside it.",
            tags: ["page", "29"]
          },
          {
            projectId,
            pageId: `${projectId}-page-41`,
            scope: "page:41",
            body: "The vault stands open and the archive behind it has burned.",
            tags: ["page", "41"]
          },
          {
            // An edit's notes are scoped `page:<index>:edit:<operationId>`,
            // which no `^page:([0-9]+)$` reader can place — the foreign key can,
            // so this one is bounded like any other page 41 note.
            projectId,
            pageId: `${projectId}-page-41`,
            scope: "page:41:edit:op-1",
            body: "After the fire the vault door hangs off one hinge.",
            tags: ["page", "41", "edit"]
          }
        ]
      });
    });

    it("recalls the page before the bound and never the one after it", async () => {
      const rows = await retrieveLexicalEmbeddings({
        projectId,
        queryTerms: ["vault"],
        scopePrefix: "page:",
        beforePageIndex: 30
      });

      expect(rows.map((row) => row.scope)).toEqual(["page:29"]);
    });

    it("resolves a scope carrying no index to NULL rather than erroring the retrieval", async () => {
      // No scopePrefix, so the `research:` row is in the sweep the cast sees.
      const rows = await retrieveLexicalEmbeddings({
        projectId,
        queryTerms: ["vault"],
        beforePageIndex: 30
      });

      expect(rows.map((row) => row.scope)).toEqual(["page:29"]);
    });

    it("runs the cosine arm's copy of the predicate too", async () => {
      // These fixture rows carry no vector, so the cosine arm returns nothing —
      // what is under test is that its bounded SQL parses and runs at all.
      const rows = await retrieveHybridEmbeddings({
        projectId,
        vector: [0.1, 0.2, 0.3],
        queryTerms: ["vault"],
        beforePageIndex: 30,
        rethrowIf: null
      });

      expect(rows.map((row) => row.scope)).toEqual(["page:29"]);
    });

    it("reaches the later page and the research note when nothing bounds it", async () => {
      const rows = await retrieveLexicalEmbeddings({ projectId, queryTerms: ["vault"] });

      expect(rows.map((row) => row.scope).sort()).toEqual(boundProjectScopes);
    });

    it("keeps a later page's continuity notes out of an earlier page's redraft", async () => {
      const notes = await retrieveLexicalContinuityNotes({
        projectId,
        queryTerms: ["vault"],
        beforePageIndex: 30
      });

      const bodies = notes.map((note) => note.body);
      expect(bodies).toContain("The vault is still sealed and Tomas has never seen inside it.");
      expect(bodies).not.toContain("The vault stands open and the archive behind it has burned.");
      // The edit-scoped note is page 41's too, and the foreign key places it
      // where the scope string cannot.
      expect(bodies).not.toContain("After the fire the vault door hangs off one hinge.");
    });

    it("leaves project-scoped notes in the result, since no page bounds them", async () => {
      const notes = await retrieveLexicalContinuityNotes({
        projectId,
        queryTerms: ["brass key"],
        beforePageIndex: 30
      });

      expect(notes.map((note) => note.body)).toContain(
        "The brass key is hidden beneath a loose floorboard in the clockmaker's shop."
      );
    });

    it("reaches every page's notes when nothing bounds them", async () => {
      const notes = await retrieveLexicalContinuityNotes({
        projectId,
        queryTerms: ["vault"],
        beforePageIndex: null
      });

      expect(notes.map((note) => note.body)).toEqual(
        expect.arrayContaining([
          "The vault is still sealed and Tomas has never seen inside it.",
          "The vault stands open and the archive behind it has burned.",
          "After the fire the vault door hangs off one hinge."
        ])
      );
    });
  });

  /**
   * The script fold, against the engine that is the whole reason it exists.
   *
   * The worker selects a page's needles with `foldCharacterName`, so a plan
   * character named "علی" is correctly recognised in a brief that spells him
   * "علي" — and then it sent the *raw* plan name to
   * `strict_word_similarity`, which folds nothing. Every one of these
   * measurements is under `LEXICAL_SIMILARITY_FLOOR`, so the mentor's own pages
   * were unreachable by his own name for the whole book.
   */
  describe("cross-script recall", () => {
    /** The mentor as the plan spells him: Persian yeh U+06CC. */
    const PERSIAN_ALI = "علی";
    /** The same three letters with the Arabic yeh U+064A — a different string. */
    const ARABIC_ALI = "علي";
    const PERSIAN_YASMIN = "یاسمین";
    const PERSIAN_KARIM = "کریم";
    /** Persian prose as a model trained on Arabic text writes it: ي for ی, ك for ک. */
    const ARABIC_KEYBOARD_SUMMARY =
      "علي در كتابخانه قديمي نشسته بود و نامه‌اي را كه از بازار آورده بود دوباره مي‌خواند.";
    const ARABIC_KEYBOARD_NOTE = "علي كليد برنجي را به ياسمين سپرد.";
    const ARABIC_KEYBOARD_YASMIN = "ياسمين در بازار ايستاده بود.";
    const ARABIC_KEYBOARD_KARIM = "كريم به بازار رفت.";

    async function measure(needle: string, haystack: string): Promise<number> {
      const [row] = await prisma.$queryRawUnsafe<Array<{ score: number }>>(
        `SELECT strict_word_similarity($1, $2) AS "score"`,
        needle,
        haystack
      );
      return Number(row?.score);
    }

    beforeAll(async () => {
      await prisma.embedding.create({
        data: { projectId, scope: "page:61", sourceId: null, text: ARABIC_KEYBOARD_SUMMARY, metadata: {} }
      });
      await prisma.continuityNote.create({
        data: { projectId, scope: "project", body: ARABIC_KEYBOARD_NOTE, tags: [] }
      });
    });

    it("recalls a page the model spelled from an Arabic keyboard, by the plan's Persian name", async () => {
      const rows = await retrieveLexicalEmbeddings({
        projectId,
        queryTerms: [PERSIAN_ALI],
        scopePrefix: "page:"
      });

      expect(rows.map((row) => row.scope)).toEqual(["page:61"]);
      expect(rows[0]?.similarity).toBeCloseTo(1, 4);
      // The stored prose comes back as written — the fold is for scoring only.
      expect(rows[0]?.text).toBe(ARABIC_KEYBOARD_SUMMARY);
    });

    it("recalls a continuity note across the same spelling gap", async () => {
      const notes = await retrieveLexicalContinuityNotes({
        projectId,
        queryTerms: [PERSIAN_YASMIN],
        beforePageIndex: null
      });

      expect(notes.map((note) => note.body)).toEqual([ARABIC_KEYBOARD_NOTE]);
    });

    /**
     * What the unfolded needle actually scored. A name is three to six letters,
     * so a single differing codepoint takes out most of its trigrams — and the
     * padded leading trigrams too, which is why "یاسمین" collapses to noise
     * while Latin "José" against "Jose" stays comfortably above the floor.
     */
    it.each([
      { name: `${PERSIAN_ALI} / ${ARABIC_ALI}`, needle: PERSIAN_ALI, prose: ARABIC_KEYBOARD_SUMMARY },
      { name: PERSIAN_YASMIN, needle: PERSIAN_YASMIN, prose: ARABIC_KEYBOARD_YASMIN },
      { name: PERSIAN_KARIM, needle: PERSIAN_KARIM, prose: ARABIC_KEYBOARD_KARIM }
    ])("scored $name below the floor unfolded and 1.0 folded", async ({ needle, prose }) => {
      const raw = await measure(needle, prose);
      const folded = await measure(foldLexicalText(needle), foldLexicalText(prose));

      expect(raw).toBeLessThan(LEXICAL_SIMILARITY_FLOOR);
      expect(folded).toBeCloseTo(1, 4);
    });

    it("keeps José findable without folding an accent", async () => {
      expect(await measure("José", "Jose walked to the harbour and counted the crates.")).toBeGreaterThan(
        LEXICAL_SIMILARITY_FLOOR
      );
    });

    /**
     * Why this is not `foldCharacterName`. That fold deletes ZWNJ, and pg_trgm
     * scores *words*: the ZWNJ is the word break that makes a compound surname
     * contain the given name at all. Deleting it on the haystack side would
     * have taken a page that is recalled today and pushed it under the floor —
     * a regression bought with the fix.
     */
    it("leaves ZWNJ alone, because it is the word break the compound name matches on", async () => {
      const compound = "علی‌محمدیان فانوس را روشن کرد و از پله‌های انبار پایین رفت.";
      const kept = await measure(PERSIAN_ALI, compound);
      const deleted = await measure(PERSIAN_ALI, compound.replaceAll("\u200c", ""));

      expect(kept).toBeCloseTo(1, 4);
      expect(deleted).toBeLessThan(LEXICAL_SIMILARITY_FLOOR);
    });
  });

  /**
   * The needle fold and the column fold are one table because they have to land
   * in one space, and `translate()` is what makes an unpaired character worse
   * than a missing one. Both halves of that are measured here rather than
   * reasoned about: the engine's own deletion rule, and the module's own fold
   * expression run over a probe holding every character the fold names.
   */
  describe("the needle and the column fold into one space", () => {
    /**
     * Taken out of the expression the module emits rather than restated here,
     * so a widened table brings its own new characters into the probe and
     * neither of these tests has to be remembered.
     */
    const foldExpression = lexicalFoldSql("$1");
    const [, foldFrom = ""] = /translate\(\$1, '([^']*)', '([^']*)'\)/.exec(foldExpression) ?? [];
    const probe = `Probe ${foldFrom} probe.`;

    it("deletes a character the `to` string is too short to answer", async () => {
      const [row] = await prisma.$queryRawUnsafe<Array<{ short: string; paired: string }>>(
        `SELECT translate('abc', 'abc', 'x') AS "short", translate('abc', 'abc', 'xyz') AS "paired"`
      );

      // This is why the two strings are one table: an unpaired `from` character
      // is dropped out of the haystack, while a needle map built from the same
      // pair of strings keeps it — both sides folded, into different spaces,
      // with nothing raised anywhere.
      expect(row?.short).toBe("x");
      expect(row?.paired).toBe("xyz");
    });

    it("folds a column to exactly what foldLexicalText makes of the needle", async () => {
      expect([...foldFrom].length).toBeGreaterThan(0);

      const [row] = await prisma.$queryRawUnsafe<Array<{ folded: string }>>(
        `SELECT ${foldExpression} AS "folded"`,
        probe
      );

      expect(row?.folded).toBe(foldLexicalText(probe));
    });

    it("scores a word written in every folded character against its folded needle at 1.0", async () => {
      const scope = "page:97";
      await prisma.embedding.create({ data: { projectId, scope, sourceId: null, text: probe, metadata: {} } });

      try {
        const rows = await retrieveLexicalEmbeddings({
          projectId,
          queryTerms: [foldLexicalText(foldFrom)],
          scopePrefix: "page:"
        });

        // Exactly 1.0, because the column folded to the needle character for
        // character. A character the column dropped instead would leave that
        // word short of the needle and cost it the trigrams around it.
        expect(rows.find((row) => row.scope === scope)?.similarity).toBeCloseTo(1, 4);
      } finally {
        await prisma.embedding.deleteMany({ where: { projectId, scope } });
      }
    });
  });
});
