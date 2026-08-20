import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(async (_sql: string, ..._params: unknown[]) => [] as unknown[])
}));

vi.mock("./client.ts", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
  PrismaClient: class PrismaClient {},
  Prisma: {}
}));

const {
  LEXICAL_SIMILARITY_FLOOR,
  compileLexicalFold,
  foldLexicalText,
  retrieveLexicalContinuityNotes,
  retrieveLexicalEmbeddings
} = await import("./lexicalRetrieval.ts");

/**
 * Thresholds, `strict_word_similarity` ranking, and the similarity-vs-noise
 * measurements live in the opt-in suite `lexicalRetrieval.integration.test.ts`
 * (`DB_INTEGRATION=true`). Mocks cannot exercise pg_trgm.
 */

beforeEach(() => {
  mocks.queryRawUnsafe.mockReset();
  mocks.queryRawUnsafe.mockResolvedValue([]);
});

describe("retrieveLexicalEmbeddings", () => {
  it("returns [] without querying for empty, whitespace, or duplicate-blank terms", async () => {
    for (const queryTerms of [[], ["  "], ["", "  ", ""], ["  ", "  "]]) {
      await expect(retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms })).resolves.toEqual([]);
    }
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("queries with strict_word_similarity above the lexical floor", async () => {
    await retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: ["brass key", " brass key ", ""] });

    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    const sql = String(mocks.queryRawUnsafe.mock.calls[0]?.[0]);
    expect(sql).toContain("strict_word_similarity");
    expect(sql).toContain(`> ${LEXICAL_SIMILARITY_FLOOR}`);
    expect(mocks.queryRawUnsafe.mock.calls[0]?.[1]).toBe("project-1");
    expect(mocks.queryRawUnsafe.mock.calls[0]?.[2]).toEqual(["brass key"]);
  });

  it("bounds page scopes below beforePageIndex, in the same query as the LIMIT", async () => {
    await retrieveLexicalEmbeddings({
      projectId: "project-1",
      queryTerms: ["the vault"],
      scopePrefix: "page:",
      beforePageIndex: 30,
      topK: 5
    });

    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] ?? [];
    const text = String(sql);
    // `substring(... from pattern)` is NULL for a research or parked scope, so
    // the comparison drops that row instead of the cast erroring on it.
    expect(text).toContain(`substring(e."scope" from '^page:([0-9]{1,9})$')::int < $4::int`);
    // In the WHERE, ahead of the LIMIT: a bound applied after a top-K cut would
    // silently return fewer rows than the caller asked for.
    expect(text.indexOf("$4::int")).toBeLessThan(text.indexOf("LIMIT"));
    expect(params[3]).toBe(30);
  });

  it("leaves the query unbounded without beforePageIndex, so research scopes still match", async () => {
    await retrieveLexicalEmbeddings({
      projectId: "project-1",
      queryTerms: ["clockmaking"],
      scopePrefix: "research:"
    });

    expect(String(mocks.queryRawUnsafe.mock.calls[0]?.[0])).not.toContain("substring(");
  });

  it("caps needles at LEXICAL_TERM_LIMIT after deduping", async () => {
    const queryTerms = [
      "one",
      "two",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine"
    ];

    await retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms });

    expect(mocks.queryRawUnsafe.mock.calls[0]?.[2]).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight"
    ]);
  });
});

describe("retrieveLexicalContinuityNotes", () => {
  it("bounds notes to pages before the page being drafted, in the same query as the LIMIT", async () => {
    await retrieveLexicalContinuityNotes({
      projectId: "project-1",
      queryTerms: ["the vault"],
      beforePageIndex: 30,
      topK: 14
    });

    const [sql, ...params] = mocks.queryRawUnsafe.mock.calls[0] ?? [];
    const text = String(sql);
    // Through the `pageId` foreign key, not the `page:<index>` scope: the scope
    // is display text the schema refuses as identity, and an edit writes
    // `page:<index>:edit:<operationId>`, which the scope reader resolves to
    // NULL — bounding on it would drop every edited page's notes rather than
    // place them in time.
    expect(text).toContain('p."id" = note."pageId"');
    expect(text).toContain('p."index" < $3::int');
    expect(text).not.toContain("substring(");
    // The project is named inside the EXISTS as well, so the lookup resolves
    // through `Page_projectId_index_key` rather than every project's pages.
    expect(text).toContain('p."projectId" = $1');
    // A note owned by no page is project-scoped — the ownership predicate has
    // already dropped the ambiguous page-scoped ones — and no page bound
    // applies to it.
    expect(text).toContain('note."pageId" IS NULL OR EXISTS');
    // In the WHERE, ahead of the LIMIT: bounding the returned rows instead
    // would leave a late page with whatever few of its slots held the past.
    expect(text.indexOf("$3::int")).toBeLessThan(text.indexOf("LIMIT"));
    expect(params[2]).toBe(30);
  });

  it("spans the whole book when the caller says null, and says nothing about pages", async () => {
    await retrieveLexicalContinuityNotes({
      projectId: "project-1",
      queryTerms: ["the vault"],
      beforePageIndex: null
    });

    const text = String(mocks.queryRawUnsafe.mock.calls[0]?.[0]);
    expect(text).not.toContain('"Page"');
    expect(mocks.queryRawUnsafe.mock.calls[0]).toHaveLength(3);
  });
});

/**
 * The needle and the haystack have to be scored in one space. They were not:
 * the worker *selected* a Persian plan character mentioned by an Arabic-spelled
 * brief (`foldCharacterName` on both sides of the mention check) and then sent
 * the raw name to `strict_word_similarity`, where Postgres folds nothing. The
 * measurements are in the opt-in integration suite and in `foldLexicalText`'s
 * docblock; a mock can only assert that both sides are folded at all, which is
 * the part that was missing.
 */
describe("lexical script fold", () => {
  /**
   * Spelled out rather than re-derived from the module, so widening the fold
   * has to be a deliberate edit here too. Arabic kaf/yeh/alef maksura and both
   * Arabic-Indic digit ranges; Persian keheh/yeh and ASCII digits.
   */
  const FOLD_FROM =
    "\u0643\u064A\u0649\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
  const FOLD_TO = "\u06A9\u06CC\u06CC01234567890123456789";

  /** "علي" with the Arabic yeh; the plan spells the same name "علی". */
  const ARABIC_ALI = "\u0639\u0644\u064A";
  const PERSIAN_ALI = "\u0639\u0644\u06CC";

  it("maps the Arabic spellings onto the Persian ones and leaves everything else alone", () => {
    expect(foldLexicalText(ARABIC_ALI)).toBe(PERSIAN_ALI);
    expect(foldLexicalText(PERSIAN_ALI)).toBe(PERSIAN_ALI);
    expect(foldLexicalText("\u0643\u0631\u064A\u0645")).toBe("\u06A9\u0631\u06CC\u0645");
    expect(foldLexicalText("R2\u0660\u06F1")).toBe("R201");
    // Latin, punctuation and case are pg_trgm's business, not the fold's.
    expect(foldLexicalText("The Vault of Hours")).toBe("The Vault of Hours");
    expect(foldLexicalText("Jos\u00e9")).toBe("Jos\u00e9");
  });

  /**
   * The one way this fold can corrupt a book's memory rather than just fail to
   * help it: SQL `translate()` *deletes* every `from` character that has no
   * `to` counterpart, so an unpaired addition would start silently removing
   * letters from every haystack it scans.
   */
  it("pairs every folded character, in the needle and in the SQL alike", async () => {
    await retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: [ARABIC_ALI] });

    const sql = String(mocks.queryRawUnsafe.mock.calls[0]?.[0]);
    const [, from, to] = /translate\(e\."text", '([^']*)', '([^']*)'\)/.exec(sql) ?? [];
    expect([...(from ?? "")]).toHaveLength([...(to ?? "")].length);
    expect(from).toBe(FOLD_FROM);
    expect(to).toBe(FOLD_TO);
  });

  it("folds the needle and the summary column into the same space", async () => {
    await retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: [ARABIC_ALI], scopePrefix: "page:" });

    const [sql, , terms] = mocks.queryRawUnsafe.mock.calls[0] ?? [];
    // Both sides, or the fold only moves the mismatch: a needle already spelled
    // the Persian way still faces a summary the model wrote the Arabic way.
    expect(String(sql)).toContain(`strict_word_similarity(t."needle", translate(e."text", '${FOLD_FROM}', '${FOLD_TO}'))`);
    expect(terms).toEqual([PERSIAN_ALI]);
    // The prose comes back unfolded — it is fed to the model as continuity.
    expect(String(sql)).toContain(`SELECT e."id", e."scope", e."sourceId", e."text",`);
  });

  it("folds both sides of the continuity-note search too", async () => {
    await retrieveLexicalContinuityNotes({ projectId: "project-1", queryTerms: [ARABIC_ALI], beforePageIndex: null });

    const [sql, , terms] = mocks.queryRawUnsafe.mock.calls[0] ?? [];
    expect(String(sql)).toContain(
      `strict_word_similarity(t."needle", translate(note."body", '${FOLD_FROM}', '${FOLD_TO}'))`
    );
    expect(terms).toEqual([PERSIAN_ALI]);
  });

  it("spends one needle on two spellings of one name", async () => {
    await retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: [PERSIAN_ALI, ARABIC_ALI, "Tomas"] });

    expect(mocks.queryRawUnsafe.mock.calls[0]?.[2]).toEqual([PERSIAN_ALI, "Tomas"]);
  });

  /**
   * Postgres `translate(string, from, to)`, modelled: a character named in
   * `from` becomes the `to` character at the same position, a character named
   * past the end of `to` is *deleted*, and anything unnamed is left alone. The
   * opt-in integration suite measures those two rules against the engine.
   */
  const sqlTranslate = (value: string, from: string, to: string): string => {
    const fromChars = [...from];
    const toChars = [...to];
    return [...value]
      .map((char) => {
        const index = fromChars.indexOf(char);
        return index < 0 ? char : (toChars[index] ?? "");
      })
      .join("");
  };

  /**
   * The agreement itself, over whatever the module currently folds rather than
   * over a list restated here: the needle goes through `foldLexicalText` and
   * the haystack through the emitted `translate()` arguments, and a table
   * widened on one side only lands the two in different spaces without anyone
   * having to remember this file.
   */
  it("folds a needle into exactly what translate() does to the column", async () => {
    await retrieveLexicalEmbeddings({ projectId: "project-1", queryTerms: [ARABIC_ALI] });

    const sql = String(mocks.queryRawUnsafe.mock.calls[0]?.[0]);
    const [, from = "", to = ""] = /translate\(e\."text", '([^']*)', '([^']*)'\)/.exec(sql) ?? [];
    const folded = [...from];
    expect(folded.length).toBeGreaterThan(0);

    for (const char of folded) {
      expect(foldLexicalText(char)).toBe(sqlTranslate(char, from, to));
    }
    // And over a whole string, where a deletion would also shift the rest.
    const haystack = `${ARABIC_ALI} ${folded.join("")} Jos\u00e9 42`;
    expect(foldLexicalText(haystack)).toBe(sqlTranslate(haystack, from, to));
  });

  /**
   * The three things a `[from, to]` table cannot state about itself, refused
   * where the table is compiled — module load, for the real one. Each would put
   * the needle map and `translate()` back out of step, which is the failure the
   * pair table exists to make unreachable.
   */
  describe("compileLexicalFold", () => {
    it("derives both translate() arguments and the map from one table", () => {
      const { from, to, map } = compileLexicalFold([
        ["a", "b"],
        ["c", "d"]
      ]);

      expect(from).toBe("ac");
      expect(to).toBe("bd");
      expect([...from]).toHaveLength([...to].length);
      expect([...map]).toEqual([
        ["a", "b"],
        ["c", "d"]
      ]);
    });

    it("refuses a pair that is not one character on each side", () => {
      // Codepoints, not UTF-16 units: `translate()` counts characters, so an
      // astral pair is a legal 1:1 entry however long `.length` calls it.
      expect(() => compileLexicalFold([["ab", "c"]])).toThrow(/one character on each side/);
      expect(() => compileLexicalFold([["a", ""]])).toThrow(/one character on each side/);
      expect(() => compileLexicalFold([["\u{1D400}", "A"]])).not.toThrow();
    });

    it("refuses a repeated source character, which translate() and Map disagree about", () => {
      expect(() =>
        compileLexicalFold([
          ["a", "b"],
          ["a", "c"]
        ])
      ).toThrow(/repeats a source character/);
    });

    it("refuses a character the SQL literal cannot carry", () => {
      expect(() => compileLexicalFold([["'", "a"]])).toThrow(/quote or a backslash/);
      expect(() => compileLexicalFold([["a", "\\"]])).toThrow(/quote or a backslash/);
    });
  });
});
