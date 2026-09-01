import { describe, expect, it } from "vitest";
import type { ChapterBrief } from "../schemas/book.js";
import {
  BEAT_SWEEP_PAIRS_PER_SLICE,
  MAX_BEAT_DEDUP_FINDINGS,
  beatDedupPatch,
  findDuplicatePageBeats
} from "./pageBeatDedup.js";
import {
  beat,
  blockadeBeat,
  blockadePurpose,
  chainedBriefs,
  collidingBriefs,
  distinctBriefs,
  rationBeat,
  rationPurpose,
  refusedMatchBriefs,
  saturatedBriefs,
  sweepPressureBriefs,
  withCopiedBeat
} from "./testing/pageBeatDedupFixtures.js";

/**
 * The plan-time half of the repetition rule: a beat collision caught here is
 * one the drafting loop and the final-QA repair never spend their budgets
 * re-executing (the 2026-08-22 197/200 incident). Detection is deterministic;
 * the model only ever rewrites what detection flagged.
 *
 * This file is the deterministic half — the sweep and the patch it composes,
 * neither of which makes a model call. What the one bounded call does with the
 * findings is `pageBeatDedupRewrite.test.ts`; both read their maps from
 * `testing/pageBeatDedupFixtures.ts`.
 */

describe("findDuplicatePageBeats", () => {
  it("flags the later page of a colliding pair, naming the earlier one", async () => {
    const findings = await findDuplicatePageBeats(collidingBriefs());

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ pageIndex: 4, duplicateOfPageIndex: 2 });
    expect(findings[0]!.earlierText).toContain("distant patrols");
    expect(findings[0]!.reason).toMatch(/page 2/);
  });

  it("finds nothing in a map of distinct beats — same book, same vocabulary", async () => {
    expect(await findDuplicatePageBeats(distinctBriefs())).toEqual([]);
  });

  it("reports each later page once and sweeps past the rewrite cap", async () => {
    const copies: ChapterBrief[] = [
      {
        chapterIndex: 1,
        title: "One",
        summary: "S",
        continuityFocus: [],
        pages: Array.from({ length: MAX_BEAT_DEDUP_FINDINGS + 5 }, (_, index) =>
          beat(index + 1, 1, blockadePurpose, blockadeBeat)
        )
      }
    ];

    const findings = await findDuplicatePageBeats(copies);

    // Every colliding page but the first, not the first twelve of them: the cap
    // is what the rewrite call may carry, and a page the sweep stopped short of
    // lost the distinctness note as well as the rewrite.
    expect(findings).toHaveLength(MAX_BEAT_DEDUP_FINDINGS + 4);
    const flagged = findings.map((finding) => finding.pageIndex);
    expect(new Set(flagged).size).toBe(findings.length);
    // Page 1 is only ever the earlier page and is never rewritten.
    expect(flagged).not.toContain(1);
    // Every copy therefore has exactly one legitimate target left.
    expect(findings.map((finding) => finding.duplicateOfPageIndex)).toEqual(flagged.map(() => 1));
  });

  it("sweeps past the rewrite cap and names a flagged page nothing is rewriting", async () => {
    const findings = await findDuplicatePageBeats(saturatedBriefs());

    // Twelve collisions take every rewrite slot; the pair behind them is
    // detected anyway, which is what the cap sitting in the sweep's own loop
    // condition used to prevent — and those pages then spent their whole
    // page-QA budget failing the reviewer on the repetition nobody had noted.
    expect(findings).toHaveLength(MAX_BEAT_DEDUP_FINDINGS + 2);
    expect(findings.slice(0, MAX_BEAT_DEDUP_FINDINGS).map((finding) => finding.pageIndex)).toEqual(
      Array.from({ length: MAX_BEAT_DEDUP_FINDINGS }, (_, index) => index + 3)
    );
    expect(findings[MAX_BEAT_DEDUP_FINDINGS]).toMatchObject({ pageIndex: 15, duplicateOfPageIndex: 2 });
    // Page 16's strongest match is page 15 (1.00 phrasing against 0.72), and
    // page 15 keeps that beat because its finding lost the capped draw. A page
    // about to be rewritten is the only thing the sweep refuses to name.
    expect(findings[MAX_BEAT_DEDUP_FINDINGS + 1]).toMatchObject({ pageIndex: 16, duplicateOfPageIndex: 15 });
    expect(findings[MAX_BEAT_DEDUP_FINDINGS + 1]!.earlierText).toContain("short of ore");
  });

  it("does not hide later collisions when rewrite slots are disabled for full-map audit", async () => {
    const findings = await findDuplicatePageBeats(saturatedBriefs(), { rewriteSlotLimit: 0 });
    expect(findings.length).toBeGreaterThan(MAX_BEAT_DEDUP_FINDINGS);
    expect(findings[MAX_BEAT_DEDUP_FINDINGS]).toMatchObject({
      pageIndex: 15,
      duplicateOfPageIndex: 2
    });
  });

  it("never names a page this same sweep is about to rewrite", async () => {
    const findings = await findDuplicatePageBeats(chainedBriefs());

    // Page 4's strongest match is page 3, but page 3's own beat is being
    // rewritten by the same model call, so page 4 is pinned to page 2 — the
    // strongest match among the pages that will still say what they say.
    expect(findings.map((finding) => [finding.pageIndex, finding.duplicateOfPageIndex])).toEqual([
      [3, 2],
      [4, 2]
    ]);
    const rewritten = new Set(findings.map((finding) => finding.pageIndex));
    expect(findings.some((finding) => rewritten.has(finding.duplicateOfPageIndex))).toBe(false);
    // And the quoted assignment is page 2's, which is the one that survives.
    expect(findings[1]!.earlierText).toContain("starving its industry");
    expect(findings[1]!.earlierText).not.toContain("short of ore");
    expect(findings[1]!.reason).toMatch(/page 2/);
  });

  it("holds the match it refused against the page whose rewrite it deferred to", async () => {
    const findings = await findDuplicatePageBeats(refusedMatchBriefs());

    // Page 5's only match is page 4, which is winning a rewrite slot, so it gets
    // no finding of its own — a note naming page 4 would quote an assignment
    // that is about to be replaced.
    expect(findings.map((finding) => finding.pageIndex)).toEqual([4]);
    // But the match is not forgotten, because the rewrite is attempted rather
    // than guaranteed. It rides the finding whose rewrite is the reason it was
    // refused, so the one thing that knows whether that rewrite happened can
    // decide whether to write the note.
    expect(findings[0]!.suppressedMatches).toEqual([
      expect.objectContaining({ pageIndex: 5, duplicateOfPageIndex: 4 })
    ]);
    expect(findings[0]!.suppressedMatches?.[0]!.earlierText).toContain("short of ore");
  });
});

describe("beatDedupPatch", () => {
  it("writes a distinctness note for every finding even with no rewrites", async () => {
    const findings = await findDuplicatePageBeats(collidingBriefs());

    const patch = beatDedupPatch(findings);

    expect(patch.beatPatches).toHaveLength(1);
    expect(patch.beatPatches[0]!.pageIndex).toBe(4);
    expect(patch.beatPatches[0]!.purpose).toBeUndefined();
    expect(patch.beatPatches[0]!.requiredContinuity?.[0]).toMatch(/Stay distinct from page 2/);
  });

  it("composes a rewrite onto its finding and drops one for a page nothing flagged", async () => {
    const findings = await findDuplicatePageBeats(collidingBriefs());

    const patch = beatDedupPatch(findings, [
      {
        pageIndex: 4,
        purpose: "Trace one family's ration book",
        beat: "A Hamburg family's week measured in ration coupons.",
        endingPressure: "Carry the family's hunger into the next page."
      },
      {
        pageIndex: 3,
        purpose: "Should not appear",
        beat: "Nothing flagged page 3.",
        endingPressure: "Should not appear either."
      }
    ]);

    expect(patch.beatPatches).toHaveLength(1);
    // A rewrite lands whole — a fresh beat under the handoff written for the
    // beat it replaced promises the next page something that no longer happens.
    expect(patch.beatPatches[0]).toMatchObject({
      pageIndex: 4,
      purpose: "Trace one family's ration book",
      beat: "A Hamburg family's week measured in ration coupons.",
      endingPressure: "Carry the family's hunger into the next page."
    });
    expect(patch.beatPatches[0]!.requiredContinuity?.[0]).toMatch(/Stay distinct from page 2/);
  });

  it("revives a refused match when no rewrite arrived for the page that refused it", async () => {
    const findings = await findDuplicatePageBeats(refusedMatchBriefs());

    // The whole-call note patch: every finding still gets a distinctness line
    // when a rewrite never arrives. Phase 02 no longer ships that patch as a
    // clean map; the integrity pass regenerates or throws instead.
    const patch = beatDedupPatch(findings);

    expect(patch.beatPatches.map((entry) => entry.pageIndex)).toEqual([4, 5]);
    expect(patch.beatPatches[0]!.requiredContinuity?.[0]).toMatch(/^Stay distinct from page 3/);
    // And the revived note quotes page 4's own assignment, which the same
    // condition has just confirmed page 4 keeps.
    expect(patch.beatPatches[1]!.requiredContinuity?.[0]).toMatch(
      /^Stay distinct from page 4, which already covers: Explain how the naval blockade squeezed/
    );
  });

  it("leaves a refused match alone when the rewrite it deferred to landed", async () => {
    const findings = await findDuplicatePageBeats(refusedMatchBriefs());

    const patch = beatDedupPatch(findings, [
      {
        pageIndex: 4,
        purpose: rationPurpose,
        beat: rationBeat,
        endingPressure: "Leave the ration book half empty."
      }
    ]);

    // Page 4's beat is gone, so there is nothing left for page 5 to be pinned
    // to — and the rewrite that replaced it was scored against page 5 before it
    // was accepted, page 5 being an unflagged page like any other. A note here
    // would name an assignment the same patch is removing, which is the rule
    // the refusal exists for.
    expect(patch.beatPatches.map((entry) => entry.pageIndex)).toEqual([4]);
    expect(patch.beatPatches[0]!.beat).toBe(rationBeat);
  });
});

describe("a refusal scored beside a standing match", () => {
  /**
   * Page 4 of `chainedBriefs` is a verbatim copy of page 3 (1.00 phrasing) and a
   * 0.72 match for page 2. Page 3 wins a rewrite slot, so the *stronger* of page
   * 4's two collisions is the one the sweep may not write down — and the weaker
   * one is a finding it writes anyway. Draining the refusals only where nothing
   * standing had matched therefore discarded the pair that mattered, at the one
   * point in the pass where it had been measured.
   */
  it("holds a refusal that outranks the standing match it was scored beside", async () => {
    const findings = await findDuplicatePageBeats(chainedBriefs());

    expect(findings.map((finding) => [finding.pageIndex, finding.duplicateOfPageIndex])).toEqual([
      [3, 2],
      [4, 2]
    ]);
    expect(findings[0]!.suppressedMatches).toEqual([
      expect.objectContaining({ pageIndex: 4, duplicateOfPageIndex: 3 })
    ]);
    expect(findings[0]!.suppressedMatches?.[0]!.earlierText).toContain("short of ore");
  });

  it("holds no refusal weaker than the match already standing", async () => {
    const findings = await findDuplicatePageBeats(saturatedBriefs());

    // Page 16's strongest match is page 15, which lost the capped draw and so
    // keeps its beat whatever the call answers; the twelve pages it also
    // collides with score lower and are all being rewritten. A `duplicateOf` is
    // never a page this pass rewrites, so nothing under it can ever be the
    // strongest collision page 16 still has — holding one would only offer the
    // patch a note it must not take over the certain one.
    expect(findings.every((finding) => finding.suppressedMatches === undefined)).toBe(true);
    expect(beatDedupPatch(findings).beatPatches.find((entry) => entry.pageIndex === 16)!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 15/)
    ]);
  });

  it("names the stronger collision once the rewrite it deferred to is dropped", async () => {
    const findings = await findDuplicatePageBeats(chainedBriefs());

    // The whole-call fallback. Page 3 keeps exactly the beat page 4 copies, so
    // a note naming page 2 describes the weaker of page 4's two collisions and
    // sends the verbatim one into drafting on a map nothing measures again.
    const patch = beatDedupPatch(findings);

    expect(patch.beatPatches.map((entry) => entry.pageIndex)).toEqual([3, 4]);
    expect(patch.beatPatches[1]!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 3, which already covers: Explain how the naval blockade squeezed/)
    ]);
  });

  it("falls back to the standing match when that rewrite lands", async () => {
    const findings = await findDuplicatePageBeats(chainedBriefs());

    const patch = beatDedupPatch(findings, [
      {
        pageIndex: 3,
        purpose: rationPurpose,
        beat: rationBeat,
        endingPressure: "Leave the ration book half empty."
      }
    ]);

    // Page 3's beat is gone, so the refusal is dissolved and page 4's note is
    // its own finding's again. One note per page either way: the sweep reports
    // each later page once, against its strongest earlier match, and this is
    // that rule asked again with the answer detection could not have.
    expect(patch.beatPatches.map((entry) => entry.pageIndex)).toEqual([3, 4]);
    expect(patch.beatPatches[1]!.requiredContinuity).toEqual([expect.stringMatching(/^Stay distinct from page 2/)]);
  });
});

describe("short beats", () => {
  /**
   * Both metrics divide by the shorter side, so a terse assignment shares most
   * of its handful of tokens with any longer beat that touches the same noun.
   * "the" is one of those tokens: the shared tokenizer keeps everything over
   * two characters and its stop list is about summaries.
   */
  it("does not flag a terse beat against an unrelated longer one", async () => {
    const briefs: ChapterBrief[] = [
      {
        chapterIndex: 1,
        title: "One",
        summary: "S",
        continuityFocus: [],
        pages: [
          beat(
            1,
            1,
            "Weigh the bargain",
            "Mia counts what the bargain will cost her family and decides the cost is real enough to matter."
          ),
          beat(2, 1, "Name the cost", "The cost is real.")
        ]
      }
    ];

    expect(await findDuplicatePageBeats(briefs)).toEqual([]);
  });

  it("still flags two full beats that assign the same work", async () => {
    expect(await findDuplicatePageBeats(collidingBriefs())).toHaveLength(1);
  });
});

/**
 * The sweep's other bound: how long it may hold the worker's thread. It runs
 * inside GENERATE_BOOK beside every other page job in the process, and a
 * quadratic pass that never yields is one those jobs' I/O callbacks, provider
 * stream chunks and BullMQ lock renewals wait behind — 227 ms of it at the
 * 600-page ceiling, in one block.
 *
 * Every page count here is derived from `BEAT_SWEEP_PAIRS_PER_SLICE` rather
 * than written down, because the budget is in *pairs* and a case that named a
 * page count would stop being about the budget the moment it moved.
 */
describe("the sweep's pause budget", () => {
  /** The smallest page count whose sweep scores at least `pairs` pairs. */
  function pagesForPairs(pairs: number): number {
    return Math.ceil((1 + Math.sqrt(1 + 8 * pairs)) / 2);
  }

  /**
   * Turns of the event loop the sweep let through, counted by a self-rescheduling
   * `setImmediate` probe — the sibling job's callback the whole bound is about.
   * A sweep that never pauses answers 0 however long it runs, because the probe
   * cannot fire until the call stack it is queued behind is empty.
   */
  async function turnsDuring<T>(run: () => Promise<T>): Promise<{ result: T; turns: number }> {
    let turns = 0;
    let probing = true;
    const tick = (): void => {
      if (!probing) {
        return;
      }
      turns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);
    const result = await run();
    probing = false;
    return { result, turns };
  }

  it("hands the event loop back several times over a map worth several slices", async () => {
    const pages = pagesForPairs(BEAT_SWEEP_PAIRS_PER_SLICE * 5);
    const briefs = withCopiedBeat(sweepPressureBriefs(pages), { from: 2, to: pages });

    const { result, turns } = await turnsDuring(() => findDuplicatePageBeats(briefs));

    // Several, not one: a sweep that yielded once at the end would be as
    // uninterruptible as no sweep at all for everything queued behind it.
    expect(turns).toBeGreaterThanOrEqual(3);
    // And the pauses cost the sweep nothing: the planted pair sits on either
    // side of every one of them, and is still the only thing found.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pageIndex: pages, duplicateOfPageIndex: 2 });
  });

  it("never pauses on a book too small to fill one slice", async () => {
    const briefs = sweepPressureBriefs(pagesForPairs(BEAT_SWEEP_PAIRS_PER_SLICE) - 1);

    const { turns } = await turnsDuring(() => findDuplicatePageBeats(briefs));

    // The budget is a ceiling on a slice, not a pause per page: a book this
    // size — which is most books — scores its whole map in one go and pays
    // exactly what it paid when the sweep was synchronous.
    expect(turns).toBe(0);
  });
});
