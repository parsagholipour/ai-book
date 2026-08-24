import { describe, expect, it } from "vitest";
import type { ChapterBrief } from "../schemas/book.js";
import {
  MAX_BEAT_DEDUP_FINDINGS,
  beatDedupPatch,
  dedupePageBeats,
  findDuplicatePageBeats
} from "./pageBeatDedup.js";
import { LAST_PAGE_ENDING_PRESSURE } from "./pageBriefContract.js";
import { mergePageMapCriticPatch } from "./pageMapCritic.js";
import {
  blockadeBeat,
  blockadePurpose,
  capturingJsonModel,
  chainedBriefs,
  collidingBriefs,
  findingFor,
  neutralBeat,
  neutralPurpose,
  oreBeat,
  rationBeat,
  rationPurpose,
  refusedMatchBriefs,
  saturatedBriefs,
  squeezedBeat,
  uBoatBeat,
  uBoatPurpose,
  unrelatedBriefs,
  withPageContinuity,
  withPageImageMoment
} from "./testing/pageBeatDedupFixtures.js";

/**
 * The paid half of the pass: one bounded model call over what detection flagged,
 * and everything that decides what of its answer may reach the page map — the
 * capped slots, the batch's own collision rule, the continuity a rewrite has to
 * answer for, and the ending contract. Detection and the deterministic patch are
 * `pageBeatDedup.test.ts`; the maps are shared, so the two halves cannot drift
 * onto different books.
 */

/**
 * The same map with a read counter on the pages this call has no other reason to
 * touch. Only two things here read a page's `purpose` and `beat`: the prompt
 * payload, which reads the flagged page's, its duplicate-of and its immediate
 * neighbours, and `fingerprint`, which reads every unflagged page in the book.
 * A counter on the pages in between is therefore a direct measure of whether the
 * standing set was built at all — a probe rather than an assertion about how,
 * because "behind the guard" and "lazily" are the same fact from here.
 */
/** Page 1's beat in every fixture map here, quoted where a finding names it. */
const julyCrisisBeat = "A telegram reaches Berlin while the fleet is already coaling.";

function countedPageReads(
  briefs: ChapterBrief[],
  pageIndexes: number[]
): { briefs: ChapterBrief[]; reads: () => number } {
  let reads = 0;
  const counted = briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) =>
      pageIndexes.includes(page.pageIndex)
        ? {
            ...page,
            get purpose() {
              reads += 1;
              return page.purpose;
            },
            get beat() {
              reads += 1;
              return page.beat;
            }
          }
        : page
    )
  }));
  return { briefs: counted, reads: () => reads };
}

describe("dedupePageBeats", () => {
  it("hands the model both halves of each collision and merges only flagged rewrites", async () => {
    const briefs = collidingBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page."
        },
        {
          pageIndex: 1,
          purpose: "Must be dropped",
          beat: "The model may not widen its own scope.",
          endingPressure: "Nor its endings."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: ["Explain the blockade's role in the armistice."],
      lastPageIndex: 4
    });

    expect(capture.purpose).toBe("dedupe-page-beats");
    expect(capture.payload?.chapters).toHaveLength(1);
    expect(capture.payload?.chapters?.[0]).toMatchObject({
      chapterIndex: 2,
      chapterTitle: "The home fronts",
      chapterSummary: "Civilians under pressure."
    });
    expect(capture.payload?.chapters?.[0]?.flaggedPages).toHaveLength(1);
    expect(capture.payload?.chapters?.[0]?.flaggedPages?.[0]).toMatchObject({
      pageIndex: 4,
      duplicateOf: expect.objectContaining({ pageIndex: 2 })
    });
    expect(capture.payload?.promises).toEqual(["Explain the blockade's role in the armistice."]);

    const merged = mergePageMapCriticPatch(briefs, patch, 4);
    const rewritten = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    const untouched = merged[0]!.pages.find((page) => page.pageIndex === 2)!;
    expect(rewritten.beat).toBe("A Hamburg family's week measured in ration coupons.");
    expect(rewritten.requiredContinuity[0]).toMatch(/Stay distinct from page 2/);
    expect(untouched.beat).toBe(blockadeBeat);
    // The unflagged patch the model volunteered never reached page 1.
    expect(merged[0]!.pages.find((page) => page.pageIndex === 1)!.purpose).toBe("Open inside the July crisis");
  });

  it("holds the book's last page to the ending contract the prompt states", async () => {
    const briefs = collidingBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 4
    });

    expect(capture.system).toContain(LAST_PAGE_ENDING_PRESSURE);
    expect(capture.payload?.chapters?.[0]?.flaggedPages?.[0]?.isLastPageOfBook).toBe(true);
    // Page 4 is the later half of its pair *and* the book's last page, which is
    // the likeliest finding this pass makes. A model handed no ending contract
    // briefs it to end the book on a page turn.
    const merged = mergePageMapCriticPatch(briefs, patch, 4);
    expect(merged[1]!.pages.find((page) => page.pageIndex === 4)!.endingPressure).toBe(LAST_PAGE_ENDING_PRESSURE);
  });

  it("refuses a rewrite that ships a fresh beat with no handoff of its own", async () => {
    const briefs = collidingBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons."
        }
      ]
    });

    // `mergePageMapCriticPatch` falls back to the page's stored endingPressure
    // when a patch omits it, so an optional field here published a replaced
    // beat under the handoff written for the beat it replaced. The schema
    // refuses the partial patch instead; the caller degrades to the
    // deterministic notes, which is the outcome this pass guarantees anyway.
    await expect(
      dedupePageBeats({
        textModel: capture.model,
        briefs,
        findings,
        promises: [],
        lastPageIndex: 6
      })
    ).rejects.toThrow();
  });

  it("carries a mid-book rewrite's own handoff onto the page", async () => {
    const briefs = collidingBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page."
        }
      ]
    });

    // Page 4 is not the book's end here, so `withContractedEnding` stands
    // aside and the model's own handoff is what lands.
    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const rewritten = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(rewritten.beat).toBe("A Hamburg family's week measured in ration coupons.");
    expect(rewritten.endingPressure).toBe("Carry the family's hunger into the next page.");
  });

  it("drops a rewrite that duplicates another rewrite in the same batch", async () => {
    const briefs = chainedBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        { pageIndex: 3, purpose: rationPurpose, beat: rationBeat, endingPressure: "Leave the ration book half empty." },
        { pageIndex: 4, purpose: rationPurpose, beat: rationBeat, endingPressure: "Leave the ration book half empty." }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    expect(capture.system).toMatch(/distinct from one another/);

    // Both findings name page 2, so both flagged pages were handed the same
    // instruction and the same note — and one call swapped two collisions for
    // a fresh one. The lower page index survives; page 4 keeps the beat it
    // came in with, and its distinctness note, which is what this pass
    // guarantees whether or not a rewrite arrived.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const pages = merged[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 3)!.beat).toBe(rationBeat);
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(squeezedBeat);
    expect(pages.find((page) => page.pageIndex === 4)!.requiredContinuity[0]).toMatch(/^Stay distinct from page \d/);
  });

  it("drops a rewrite that lands on a page nothing flagged", async () => {
    const briefs = collidingBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          // Page 3's assignment, near enough to clear the phrasing bar. The
          // model was never shown page 3 — it sees its duplicate-of and its two
          // neighbours — so this is what an honest answer to this prompt can
          // collide with without knowing.
          purpose: "Follow the turnip winter into one kitchen",
          beat: "Rationing collapses into the turnip winter of 1916-17 in German cities.",
          endingPressure: "Leave the pot on the stove."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // The batch rule alone measures the rewrites against each other, and there
    // is only one here — so this used to ship, and `findDuplicatePageBeats`
    // never runs again to find what it left. Page 4 keeps the beat it came in
    // with and the note it was owed either way, which is where it stood before
    // the call.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const pages = merged[1]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(blockadeBeat);
    expect(pages.find((page) => page.pageIndex === 4)!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 2/)
    ]);
    expect(pages.find((page) => page.pageIndex === 3)!.beat).toMatch(/turnip winter/);
  });

  it("drops a copied rewrite too terse for either overlap bar to measure", async () => {
    const briefs = chainedBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        { pageIndex: 3, purpose: "Name the cost", beat: "The cost lands.", endingPressure: "Leave the cost unpaid." },
        { pageIndex: 4, purpose: "Name the cost.", beat: "The cost lands!", endingPressure: "Leave the cost unpaid." }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // Both fingerprints sit under `MIN_BEAT_SHINGLES` and `MIN_BEAT_KEYWORDS`,
    // so `scorePair` answers `undefined` for the pair and the batch rule kept
    // both copies — a model asked for twelve patches against a 3200-token cap
    // answers exactly this tersely, which is when the rule is needed most.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const pages = merged[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 3)!.beat).toBe("The cost lands.");
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(squeezedBeat);
    expect(pages.find((page) => page.pageIndex === 4)!.requiredContinuity[0]).toMatch(/^Stay distinct from page 2/);
  });

  it("replaces the continuity written for the assignment it rewrote", async () => {
    const briefs = withPageContinuity(collidingBriefs(), 4, ["Preserve mapped detail the North Sea blockade"]);
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page.",
          // Nothing the page required survives the reassignment, which is the
          // whole of what the blockade line was.
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // `mergePageMapCriticPatch` appends continuity, so the blockade
    // requirement stood beside the fresh assignment: a page briefed onto a new
    // angle and told in the same brief to preserve the material that angle
    // existed to leave.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const rewritten = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(rewritten.beat).toBe("A Hamburg family's week measured in ration coupons.");
    expect(rewritten.requiredContinuity).toEqual([expect.stringMatching(/^Stay distinct from page 2/)]);
    expect(rewritten.requiredContinuity).not.toContain("Preserve mapped detail the North Sea blockade");
  });

  it("keeps the mapped continuity its rewrite says still holds", async () => {
    const scheerLine = "Keep Admiral Scheer's name and rank consistent after page 2";
    const briefs = withPageContinuity(collidingBriefs(), 4, [
      "Preserve mapped detail the North Sea blockade",
      scheerLine
    ]);
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page.",
          requiredContinuity: [scheerLine]
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // The model is shown what the page requires today, because sorting the
    // beat-derived entries from the chapter-wide ones is the one thing only the
    // model writing the new assignment can do.
    expect(capture.payload?.chapters?.[0]?.flaggedPages?.[0]?.requiredContinuity).toEqual([
      "Preserve mapped detail the North Sea blockade",
      scheerLine
    ]);

    // Replacing the array with the distinctness note alone was the same
    // mistake as appending to it, pointing the other way: a name the whole
    // chapter depends on went out with the blockade line the rewrite was paid
    // to leave.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const rewritten = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(rewritten.beat).toBe("A Hamburg family's week measured in ration coupons.");
    expect(rewritten.requiredContinuity).toEqual([scheerLine, expect.stringMatching(/^Stay distinct from page 2/)]);
    expect(rewritten.requiredContinuity).not.toContain("Preserve mapped detail the North Sea blockade");
  });

  it("drops a rewrite that says nothing for the continuity it would replace", async () => {
    const scheerLine = "Keep Admiral Scheer's name and rank consistent after page 2";
    const briefs = withPageContinuity(collidingBriefs(), 4, [scheerLine]);
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // An answer silent about a page that carries entries leaves the choice
    // between a stale line and a dropped chapter-wide one to us, and neither is
    // ours to make on a guess — so the rewrite pays a colliding rewrite's
    // penalty and page 4 keeps everything it came in with.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const kept = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(kept.beat).toBe(blockadeBeat);
    expect(kept.requiredContinuity).toEqual([scheerLine, expect.stringMatching(/^Stay distinct from page 2/)]);
  });

  it("redraws the visual moment written for the beat it rewrote", async () => {
    const blockadeMoment = "A readable scene focused on the North Sea blockade";
    const rationMoment = "A widow counting ration coupons at a scrubbed kitchen table.";
    const briefs = withPageImageMoment(collidingBriefs(), 4, blockadeMoment);
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page.",
          imageMoment: rationMoment
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // The model is shown the moment it is replacing, for the same reason it is
    // shown the continuity: it is the only reader that can write a visual moment
    // for an assignment that does not exist yet.
    expect(capture.payload?.chapters?.[0]?.flaggedPages?.[0]?.imageMoment).toBe(blockadeMoment);

    // `mergePageMapCriticPatch` spreads `...page` first, so a rewrite that moved
    // purpose, beat, handoff and continuity and said nothing about this field
    // published page 177's fresh assignment under a picture of the blockade beat
    // it had just been reassigned off — into the drafting prompt and the
    // interior-illustration prompt alike.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const rewritten = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(rewritten.beat).toBe("A Hamburg family's week measured in ration coupons.");
    expect(rewritten.imageMoment).toBe(rationMoment);
  });

  it("drops a rewrite that says nothing for the visual moment it would replace", async () => {
    const blockadeMoment = "A readable scene focused on the North Sea blockade";
    const briefs = withPageImageMoment(collidingBriefs(), 4, blockadeMoment);
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // Keeping the fresh beat and the stale picture is the one outcome nothing
    // downstream can notice, so the rewrite pays a colliding rewrite's penalty
    // and page 4 keeps its whole assignment — picture included — plus the note
    // this pass guarantees either way.
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const kept = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(kept.beat).toBe(blockadeBeat);
    expect(kept.imageMoment).toBe(blockadeMoment);
    expect(kept.requiredContinuity).toEqual([expect.stringMatching(/^Stay distinct from page 2/)]);
  });

  it("gives no picture to a page the map left unillustrated", async () => {
    const briefs = collidingBriefs();
    expect(briefs[1]!.pages.find((page) => page.pageIndex === 4)!.imageMoment).toBeUndefined();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Trace one family's ration book",
          beat: "A Hamburg family's week measured in ration coupons.",
          endingPressure: "Carry the family's hunger into the next page.",
          imageMoment: "A widow counting ration coupons at a scrubbed kitchen table."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    // The payload never named a moment for this page, so a moment in the answer
    // is the model over-answering rather than an assignment being replaced —
    // and an illustration is a real cost on a book that asked for none. The
    // field is dropped, not the rewrite: refusing the whole patch would spend
    // page 4's fresh beat punishing an extra key.
    expect(capture.payload?.chapters?.[0]?.flaggedPages?.[0]).not.toHaveProperty("imageMoment");
    const merged = mergePageMapCriticPatch(briefs, patch, 6);
    const rewritten = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(rewritten.beat).toBe("A Hamburg family's week measured in ration coupons.");
    expect(rewritten.imageMoment).toBeUndefined();
  });

  it("scores a rewrite against a flagged page the model left alone", async () => {
    const briefs = unrelatedBriefs();
    // The fixture collides with nothing of its own, so every collision below is
    // one this call introduced.
    expect(await findDuplicatePageBeats(briefs)).toEqual([]);
    const findings = [
      findingFor(4, 2, `${blockadePurpose} ${blockadeBeat}`),
      findingFor(6, 3, "Show the turnip winter Rationing collapses into the turnip winter of 1916-17 in German cities.")
    ];
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: rationPurpose,
          beat: rationBeat,
          endingPressure: "Leave the ration book half empty.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 8
    });

    // Page 6 was flagged, so it was excluded from everything a rewrite is
    // measured against — and then answered for with nothing, so it keeps the
    // very beat detection flagged. Page 4's fresh angle is a copy of it, and
    // nothing runs after this pass to find that out.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 6)!.beat).toBe(rationBeat);
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(uBoatBeat);
    expect(pages.find((page) => page.pageIndex === 4)!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 2/)
    ]);
  });

  it("hands a dropped rewrite's page back to the standing set", async () => {
    const briefs = unrelatedBriefs();
    const findings = [
      findingFor(4, 2, `${blockadePurpose} ${blockadeBeat}`),
      findingFor(6, 3, "Show the turnip winter Rationing collapses into the turnip winter of 1916-17 in German cities.")
    ];
    const capture = capturingJsonModel({
      beatPatches: [
        {
          // Restates unflagged page 5, so this one is dropped...
          pageIndex: 4,
          purpose: neutralPurpose,
          beat: neutralBeat,
          endingPressure: "Leave the steamers in port.",
          requiredContinuity: []
        },
        {
          // ...which makes page 4 a page keeping its original assignment, and
          // this the same collision one page later.
          pageIndex: 6,
          purpose: uBoatPurpose,
          beat: uBoatBeat,
          endingPressure: "Leave the convoy in the fog.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 8
    });

    // Which pages are retained is only knowable as the decisions are made, so
    // a standing set computed before them cannot hold page 4.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(uBoatBeat);
    expect(pages.find((page) => page.pageIndex === 6)!.beat).toBe(rationBeat);
    expect(pages.find((page) => page.pageIndex === 5)!.beat).toBe(neutralBeat);
  });

  it("fingerprints no unflagged page when nothing survives the filter", async () => {
    // Page 6 carries continuity, so the answer below names none of it and is
    // dropped by `answersForMappedContinuity` — the same empty batch a model
    // that refuses hands back as `beatPatches: []`.
    const carrying = withPageContinuity(unrelatedBriefs(), 6, ["Keep the widow's ration book"]);
    // Pages 2, 3 and 4: not flagged, not the duplicate-of, not a neighbour of
    // the flagged page — so nothing but the standing set has a reason to read
    // them.
    const probe = countedPageReads(carrying, [2, 3, 4]);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 6,
          purpose: uBoatPurpose,
          beat: uBoatBeat,
          endingPressure: "Leave the convoy in the fog."
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs: probe.briefs,
      findings: [findingFor(6, 1, `Open inside the July crisis ${julyCrisisBeat}`)],
      promises: [],
      lastPageIndex: 8
    });

    // The standing set exists to hold rewrites apart from the rest of the book,
    // and there is no rewrite left to hold: tokenizing all of it anyway is the
    // guard's whole cost paid on the path with nothing to guard, which on a
    // 600-page map is 597 beats through `overlapTokens` on the worker's event
    // loop for a call that scores nothing.
    expect(probe.reads()).toBe(0);
    // And the free half is untouched — the note is what this pass guarantees
    // however the paid half went.
    expect(patch.beatPatches).toEqual([
      { pageIndex: 6, requiredContinuity: [expect.stringMatching(/^Stay distinct from page 1/)] }
    ]);
  });

  it("notes the page whose match it refused when the rewrite is dropped", async () => {
    const briefs = refusedMatchBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          // A fresh angle for page 4 that restates unflagged page 2 — so this
          // is dropped, and page 4 keeps the very beat page 5 collided with.
          pageIndex: 4,
          purpose: "Follow the turnip winter into one kitchen",
          beat: "Rationing collapses into the turnip winter of 1916-17 in German cities.",
          endingPressure: "Leave the pot on the stove.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 8
    });

    // Page 5's only match was page 4, which detection refused to name because
    // it was about to be rewritten — and then it was not. Both pages kept the
    // beats detection matched, page 5 with no rewrite and no note, and nothing
    // measures the map again: the collision this pass was paid to remove
    // reached drafting, introduced by nothing and removed by nothing.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(squeezedBeat);
    expect(pages.find((page) => page.pageIndex === 5)!.beat).toBe(oreBeat);
    // The note names page 4 and quotes what page 4 still says, which is the
    // property the refusal exists for — a note may never point at an
    // assignment that was replaced.
    const revived = pages.find((page) => page.pageIndex === 5)!.requiredContinuity;
    expect(revived).toEqual([
      expect.stringMatching(/^Stay distinct from page 4, which already covers: Explain how the naval blockade squeezed/)
    ]);
    // Page 4 keeps its own note too, pointing at the page that outranked it.
    expect(pages.find((page) => page.pageIndex === 4)!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 3/)
    ]);
  });

  it("leaves that page alone when the rewrite it deferred to survives", async () => {
    const briefs = refusedMatchBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: rationPurpose,
          beat: rationBeat,
          endingPressure: "Leave the ration book half empty.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 8
    });

    // The beat page 5 collided with is gone, and the one that replaced it was
    // scored against page 5 before it was accepted — page 5 carries no finding,
    // so it is an unflagged page like any other in the standing set. A note here
    // would pin page 5 to an assignment this same patch removed.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(rationBeat);
    expect(pages.find((page) => page.pageIndex === 5)!.beat).toBe(oreBeat);
    expect(pages.find((page) => page.pageIndex === 5)!.requiredContinuity).toEqual([]);
  });

  it("keeps the continuity of a page it only noted", async () => {
    const briefs = withPageContinuity(collidingBriefs(), 4, ["Preserve mapped detail the North Sea blockade"]);
    const findings = await findDuplicatePageBeats(briefs);

    // No rewrite arrived, so page 4 still has the assignment those entries
    // were written for — the replacement rides the rewrite, not the finding.
    const merged = mergePageMapCriticPatch(briefs, beatDedupPatch(findings), 6);
    const noted = merged[1]!.pages.find((page) => page.pageIndex === 4)!;
    expect(noted.beat).toBe(blockadeBeat);
    expect(noted.requiredContinuity).toEqual([
      "Preserve mapped detail the North Sea blockade",
      expect.stringMatching(/^Stay distinct from page 2/)
    ]);
  });

  it("puts only the capped findings to the model and notes every one of the rest", async () => {
    const briefs = saturatedBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 3,
          purpose: uBoatPurpose,
          beat: uBoatBeat,
          endingPressure: "Hand the next page a sighting nobody has reported yet.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({ textModel: capture.model, briefs, findings, promises: [], lastPageIndex: 16 });

    // The prompt is what `MAX_BEAT_DEDUP_FINDINGS` bounds, and it is the only
    // thing it bounds.
    const asked = (capture.payload?.chapters ?? []).flatMap((chapter: { flaggedPages: { pageIndex: number }[] }) =>
      chapter.flaggedPages.map((page) => page.pageIndex)
    );
    expect(asked).toHaveLength(MAX_BEAT_DEDUP_FINDINGS);
    expect(asked).not.toContain(15);
    expect(asked).not.toContain(16);
    // Every finding reaches the patch: a page past the cap is a page no rewrite
    // arrived for, which is a case this already had.
    expect(patch.beatPatches.map((entry) => entry.pageIndex)).toEqual(findings.map((finding) => finding.pageIndex));
    expect(patch.beatPatches.find((entry) => entry.pageIndex === 3)).toMatchObject({
      beat: uBoatBeat,
      replaceRequiredContinuity: true
    });
    const late = patch.beatPatches.find((entry) => entry.pageIndex === 16)!;
    expect(late.beat).toBeUndefined();
    expect(late.requiredContinuity).toEqual([expect.stringMatching(/^Stay distinct from page 15/)]);
  });

  it("refuses a call with no findings rather than answering one", async () => {
    const capture = capturingJsonModel({ beatPatches: [] });

    // The one caller short-circuits on a clean sweep, so an empty list is a
    // broken contract rather than a supported path — and answering it would be
    // a model call whose every patch the filter below it drops.
    await expect(
      dedupePageBeats({
        textModel: capture.model,
        briefs: collidingBriefs(),
        findings: [],
        promises: [],
        lastPageIndex: 4
      })
    ).rejects.toThrow(/at least one finding/);
    expect(capture.purpose).toBeUndefined();
  });

  it("emits a chapter's title and summary once for all of its flagged pages", async () => {
    const briefs = chainedBriefs();
    const findings = await findDuplicatePageBeats(briefs);
    const capture = capturingJsonModel({ beatPatches: [] });

    await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings,
      promises: [],
      lastPageIndex: 6
    });

    expect(capture.payload?.chapters).toHaveLength(1);
    expect(capture.payload?.chapters?.[0]?.flaggedPages?.map((page: { pageIndex: number }) => page.pageIndex)).toEqual([
      3, 4
    ]);
    // Repeating the chapter's context per finding spent the rewrite call's
    // budget on duplicates in exactly the map dense enough to trip
    // `MAX_BEAT_DEDUP_FINDINGS`.
    const serialized = JSON.stringify(capture.payload);
    expect(serialized.split("The naval war.").length - 1).toBe(1);
    expect(serialized.split("The war at sea").length - 1).toBe(1);
  });
});
