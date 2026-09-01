import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeTextModelAdapter } from "./fake.js";
import { dedupePageBeats, findDuplicatePageBeats, type DuplicateBeatFinding } from "../generation/pageBeatDedup.js";
import { chapterBriefSchema, pageDraftSchema, pageProductionBeatSchema, type ChapterBrief } from "../schemas/book.js";
import { auditProductionMap, productionMapContractFromRanges } from "../generation/productionMapAudit.js";

const pageMapSchema = z.object({ pages: z.array(pageProductionBeatSchema).min(1) });

const textModel = new FakeTextModelAdapter();

/** The whole-book map: one call for the book, as `generateWholeBookPageMap` makes it. */
async function dryRunPageMap(targetPages: number, pagesPerChapter: number): Promise<ChapterBrief[]> {
  const result = await textModel.generateJson({
    purpose: "generate-page-map",
    schema: pageMapSchema,
    messages: [
      { role: "system", content: "page map" },
      { role: "user", content: JSON.stringify({ book: { targetPages } }) }
    ]
  });
  // The real path re-derives every chapterIndex from the plan's ranges
  // (`parsePageMapFromModel`), so the pages are grouped the same way here.
  return groupIntoChapters(
    result.data.pages.map((page) => ({ ...page, chapterIndex: chapterOf(page.pageIndex, pagesPerChapter) }))
  );
}

/** The chunked map: one call per chapter, which is what a dry run over 24 pages takes. */
async function dryRunChapterBriefs(targetPages: number, pagesPerChapter: number): Promise<ChapterBrief[]> {
  const briefs: ChapterBrief[] = [];
  for (let start = 1; start <= targetPages; start += pagesPerChapter) {
    const result = await textModel.generateJson({
      purpose: "generate-chapter-brief",
      schema: chapterBriefSchema,
      messages: [
        { role: "system", content: "chapter brief" },
        {
          role: "user",
          content: JSON.stringify({
            chapter: { index: chapterOf(start, pagesPerChapter) },
            pageRange: { start, end: Math.min(targetPages, start + pagesPerChapter - 1) }
          })
        }
      ]
    });
    briefs.push(result.data);
  }
  return briefs;
}

function chapterOf(pageIndex: number, pagesPerChapter: number): number {
  return Math.floor((pageIndex - 1) / pagesPerChapter) + 1;
}

function groupIntoChapters(pages: z.infer<typeof pageProductionBeatSchema>[]): ChapterBrief[] {
  return [...new Set(pages.map((page) => page.chapterIndex))].map((chapterIndex) =>
    chapterBriefSchema.parse({
      chapterIndex,
      title: `Dry Run Chapter ${chapterIndex}`,
      summary: "A deterministic chapter brief for local dry runs.",
      pages: pages.filter((page) => page.chapterIndex === chapterIndex),
      continuityFocus: []
    })
  );
}

function beatTexts(briefs: ChapterBrief[]): string[] {
  return briefs.flatMap((brief) => brief.pages.map((page) => `${page.purpose} ${page.beat}`));
}

describe("dry-run page beats", () => {
  // `beatDedup` is on for every effort tier, so a templated map made every
  // MOCK_AI book — the documented default way to work — pay for a rewrite call
  // and draft every page against a bogus "stay distinct from page 1" note.
  it("gives the whole-book map no near-duplicate beats to find", async () => {
    const briefs = await dryRunPageMap(24, 6);

    expect(briefs).toHaveLength(4);
    expect(beatTexts(briefs)).toHaveLength(24);
    expect(new Set(beatTexts(briefs)).size).toBe(24);
    expect(await findDuplicatePageBeats(briefs)).toEqual([]);
  });

  it("gives the per-chapter briefs none either", async () => {
    // Over `CHUNKED_PAGE_MAP_THRESHOLD` pages the map is written one chapter at
    // a time, so this is the producer a long dry run actually uses.
    const briefs = await dryRunChapterBriefs(40, 8);

    expect(briefs).toHaveLength(5);
    expect(new Set(beatTexts(briefs)).size).toBe(40);
    expect(await findDuplicatePageBeats(briefs)).toEqual([]);
  });
});

describe("dry-run evidence ledger", () => {
  // The offline twin of an analytical MOCK_AI run: every dry-run page carries a
  // claim and two anchors, and the mandatory map audit that gates drafting
  // finds nothing to repair — no shared anchor, no missing ledger, nothing
  // blocking — on both brief producers' shapes.
  it("carries a ledger on every page and audits clean under an analytical contract", async () => {
    for (const briefs of [await dryRunChapterBriefs(40, 8), await dryRunPageMap(24, 6)]) {
      const pages = briefs.flatMap((brief) => brief.pages);
      expect(pages.every((page) => page.claim && page.evidenceAnchors?.length === 2)).toBe(true);

      const audit = await auditProductionMap(
        briefs,
        productionMapContractFromRanges(
          pages.length,
          briefs.map((brief) => ({
            chapterIndex: brief.chapterIndex,
            startPage: Math.min(...brief.pages.map((page) => page.pageIndex)),
            endPage: Math.max(...brief.pages.map((page) => page.pageIndex))
          })),
          "analytical-history"
        )
      );
      expect(audit.blocking).toBe(false);
      expect(audit.findings).toEqual([]);
    }
  });
});

describe("dedupe-page-beats", () => {
  it("answers every flagged page with a complete, distinct rewrite", async () => {
    const briefs = await dryRunChapterBriefs(16, 4);
    // Detection finds nothing in a dry-run map by construction, so the findings
    // this pass is asked to repair are written by hand. None of them is the
    // book's last page, whose ending `withContractedEnding` substitutes.
    const findings: DuplicateBeatFinding[] = [6, 9, 12, 15].map((pageIndex) => ({
      pageIndex,
      duplicateOfPageIndex: pageIndex - 5,
      earlierText: beatTexts(briefs)[pageIndex - 6]!,
      reason: `phrasing overlaps page ${pageIndex - 5}'s beat (99%)`
    }));

    // Through the real pass, so the fake's answer is parsed by the real patch
    // schema and filtered by the real same-batch collision guard: a rewrite
    // that lost a required field, or arrived as copies of itself, is dropped
    // here rather than in an assertion of this test's own devising.
    const patch = await dedupePageBeats({ textModel, briefs, findings, promises: [], lastPageIndex: 16 });

    expect(patch.beatPatches.map((entry) => entry.pageIndex)).toEqual([6, 9, 12, 15]);
    expect(patch.beatPatches.every((entry) => (entry.endingPressure ?? "").length > 0)).toBe(true);
    const rewritten = patch.beatPatches.map((entry) => `${entry.purpose} ${entry.beat}`);
    expect(new Set(rewritten).size).toBe(4);
    // A rewrite that restated the assignment it replaces would leave the
    // collision exactly where the pass found it.
    expect(rewritten.some((text) => beatTexts(briefs).includes(text))).toBe(false);

    // The continuity a rewrite keeps is answered for, not composed by the pass —
    // the fake keeps all of it, which is what makes the payload key and the
    // response key one round trip rather than two independent strings. Renaming
    // either end alone empties this. The distinctness note is ours and is
    // appended after the answer.
    const continuityOf = (pageIndex: number): string[] =>
      briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === pageIndex)!.requiredContinuity;
    expect(continuityOf(6).length).toBeGreaterThan(0);
    expect(patch.beatPatches.map((entry) => entry.requiredContinuity)).toEqual(
      [6, 9, 12, 15].map((pageIndex) => [...continuityOf(pageIndex), expect.stringMatching(/^Stay distinct from page \d/)])
    );
    expect(patch.beatPatches.every((entry) => entry.replaceRequiredContinuity === true)).toBe(true);

    // The visual moment is the same round trip, and the one whose stale value
    // nothing downstream can notice: it reaches the drafting prompt and the
    // interior-illustration prompt straight off the brief, so a rewrite that
    // moved everything else illustrated the page with the beat it had just been
    // reassigned off. The fake answers with its *rewrite's* moment, so a patch
    // repeating the page's own would fail here.
    const imageMomentOf = (pageIndex: number): string | undefined =>
      briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === pageIndex)!.imageMoment;
    expect(imageMomentOf(6)).toBeTruthy();
    expect(patch.beatPatches.map((entry) => entry.imageMoment)).toEqual(
      [6, 9, 12, 15].map(() => expect.stringMatching(/\S/))
    );
    expect(patch.beatPatches.map((entry) => entry.imageMoment)).not.toContain(imageMomentOf(6));
  });

  it("leaves a flagged page the map never illustrated without a picture", async () => {
    const drafted = await dryRunChapterBriefs(16, 4);
    // Every dry-run beat carries an `imageMoment`, so the unillustrated page is
    // made by hand — which is the map this rule is about: the field is optional
    // on `PageProductionBeat` and plenty of real maps assign none.
    const briefs = drafted.map((brief) => ({
      ...brief,
      pages: brief.pages.map((page) => {
        if (page.pageIndex !== 6) {
          return page;
        }
        const { imageMoment: _unillustrated, ...rest } = page;
        return rest;
      })
    }));
    const findings: DuplicateBeatFinding[] = [6, 9].map((pageIndex) => ({
      pageIndex,
      duplicateOfPageIndex: pageIndex - 5,
      earlierText: beatTexts(briefs)[pageIndex - 6]!,
      reason: `phrasing overlaps page ${pageIndex - 5}'s beat (99%)`
    }));

    const patch = await dedupePageBeats({ textModel, briefs, findings, promises: [], lastPageIndex: 16 });

    // The payload omits the key for page 6, the fake answers with no moment for
    // it, and the pass writes none — so a page nobody asked to illustrate does
    // not acquire a picture from a pass whose subject is a duplicated beat.
    // Page 9 still gets its fresh one, which is what keeps this from passing for
    // the trivial reason.
    expect(patch.beatPatches.find((entry) => entry.pageIndex === 6)?.imageMoment).toBeUndefined();
    expect(patch.beatPatches.find((entry) => entry.pageIndex === 6)?.beat).toBeTruthy();
    expect(patch.beatPatches.find((entry) => entry.pageIndex === 9)?.imageMoment).toBeTruthy();
  });

  it("answers each flagged page's own payload rather than the request's shape", async () => {
    // The real pass strips a moment written for an unillustrated page, so the
    // case above cannot tell a fake that answers honestly from one that answers
    // every page and is corrected downstream. This reads the fake's own answer:
    // the presence of the response key is decided by the payload key, page by
    // page, which is the whole of what makes the round trip measurable.
    const result = await textModel.generateJson({
      purpose: "dedupe-page-beats",
      schema: z.object({
        beatPatches: z
          .array(z.object({ pageIndex: z.number(), imageMoment: z.string().optional() }))
          .default([])
      }),
      messages: [
        { role: "system", content: "dedupe" },
        {
          role: "user",
          content: JSON.stringify({
            promises: [],
            chapters: [
              {
                chapterIndex: 1,
                flaggedPages: [
                  { pageIndex: 3, requiredContinuity: [], imageMoment: "A lantern on a packed trunk." },
                  { pageIndex: 4, requiredContinuity: [] }
                ]
              }
            ]
          })
        }
      ]
    });

    expect(result.data.beatPatches.map((entry) => entry.pageIndex)).toEqual([3, 4]);
    expect(result.data.beatPatches[0]?.imageMoment).toBeTruthy();
    expect(result.data.beatPatches[0]?.imageMoment).not.toBe("A lantern on a packed trunk.");
    expect(result.data.beatPatches[1]?.imageMoment).toBeUndefined();
  });

  it("rewrites nothing when the request names no pages", async () => {
    const result = await textModel.generateJson({
      purpose: "dedupe-page-beats",
      schema: z.object({ beatPatches: z.array(z.object({ pageIndex: z.number() })).default([]) }),
      messages: [
        { role: "system", content: "dedupe" },
        { role: "user", content: JSON.stringify({ promises: [], chapters: [] }) }
      ]
    });

    expect(result.data.beatPatches).toEqual([]);
  });
});

describe("dry-run rotation tables", () => {
  /**
   * `%` keeps the sign of its left operand, so `pageIndex - 1` indexed off the
   * *front* of the table for anything that was not 1-based, and the non-null
   * assertion over that lookup made `undefined` a value rather than an error:
   * the fake shipped the literal string "undefined" into a page's summary, its
   * markdown, and — through `dryRunPageBeat` — a beat's purpose.
   */
  it("answers a page index of 0 with a real table entry, not the string undefined", async () => {
    const draft = await textModel.generateJson({
      purpose: "generate-page",
      schema: pageDraftSchema,
      messages: [
        { role: "system", content: "draft" },
        { role: "user", content: JSON.stringify({ pageIndex: 0 }) }
      ]
    });

    expect(JSON.stringify(draft.data)).not.toContain("undefined");
    // Wrapping backwards lands on the table's last entry, which is the answer a
    // rotation has for every integer.
    expect(draft.data.summary).toContain("a silver thread");
  });

  it("wraps the page-beat tables the same way", async () => {
    // Deliberately not `chapterBriefSchema`: its `pageIndex` is
    // `z.number().int().positive()`, so the strict schema refuses page 0 before
    // anything can look at what the fake wrote for it — which is why nothing
    // ever saw "undefined a brass key." A loose schema puts the fake's own
    // answer in front of the assertion.
    const brief = await textModel.generateJson({
      purpose: "generate-chapter-brief",
      schema: z.object({ pages: z.array(z.object({ pageIndex: z.number(), purpose: z.string(), beat: z.string() })) }),
      messages: [
        { role: "system", content: "chapter brief" },
        {
          role: "user",
          content: JSON.stringify({ chapter: { index: 1 }, pageRange: { start: 0, end: 1 } })
        }
      ]
    });

    expect(JSON.stringify(brief.data)).not.toContain("undefined");
    // `dryRunPageBeat` offsets its argument by `5 * variant` from three call
    // sites and nothing in its signature says the result has to be 1-based, so
    // every integer names an entry: page 0 takes the last move and the last
    // detail of their tables.
    expect(brief.data.pages[0]).toMatchObject({
      pageIndex: 0,
      purpose: "Repair what was broken by a silver thread."
    });
  });
});

describe("manuscript structural review dry-run", () => {
  it("returns an empty keep result so MOCK_AI books are not blocked", async () => {
    const { MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE, structuralReviewResultSchema } = await import(
      "../generation/manuscriptStructuralReview.js"
    );
    const result = await textModel.generateJson({
      purpose: MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE,
      schema: structuralReviewResultSchema,
      messages: [
        { role: "system", content: "structural review" },
        { role: "user", content: "{}" }
      ]
    });
    expect(result.data).toEqual({ clusters: [] });
  });
});
