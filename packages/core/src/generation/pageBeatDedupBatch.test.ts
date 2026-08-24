import { describe, expect, it } from "vitest";
import { dedupePageBeats, findDuplicatePageBeats } from "./pageBeatDedup.js";
import { mergePageMapCriticPatch } from "./pageMapCritic.js";
import {
  capturingJsonModel,
  findingFor,
  neutralBeat,
  neutralPurpose,
  rationBeat,
  rationPurpose,
  uBoatBeat,
  unrelatedBriefs
} from "./testing/pageBeatDedupFixtures.js";

/**
 * The batch rule's *settle* — what happens to a rewrite this pass already
 * accepted when a later one is dropped and hands its page back to the map.
 *
 * It has a file of its own because `pageBeatDedupRewrite.test.ts`, where the
 * rest of the batch rule lives, sits within fifty lines of the 900-line budget
 * and these cases are the one seam in it that needs a whole batch per case: two
 * or three answers whose keep/drop decisions depend on each other, read back
 * through `mergePageMapCriticPatch` because what is being asserted is the map
 * the book is drafted from. The maps are the shared fixtures, so this cannot
 * drift onto a different book than the other two halves.
 *
 * Every fixture here collides with nothing of its own — `unrelatedBriefs` is
 * asserted clean below — so every collision in these cases is one the pass
 * introduced, which is the only kind the settle exists to catch.
 */

/** The findings the cases below hand the call; the map itself flags nothing. */
function findingsForPages(pageIndexes: number[]): ReturnType<typeof findingFor>[] {
  return pageIndexes.map((pageIndex) => findingFor(pageIndex, pageIndex - 3, `Earlier beat of page ${pageIndex - 3}.`));
}

describe("the batch rule's settle", () => {
  it("re-scores a rewrite it already accepted against a page handed back after it", async () => {
    const briefs = unrelatedBriefs();
    expect(await findDuplicatePageBeats(briefs)).toEqual([]);
    const capture = capturingJsonModel({
      beatPatches: [
        {
          // Page 6's own assignment. Nothing standing holds it while this is
          // decided — page 6 is flagged and answered for, so its original is
          // out of the set — and page 4 is the lower index, so it is accepted.
          pageIndex: 4,
          purpose: rationPurpose,
          beat: rationBeat,
          endingPressure: "Leave the ration book half empty.",
          requiredContinuity: []
        },
        {
          // ...and then page 6's own answer restates unflagged page 5 and is
          // dropped, which puts page 6 back on the beat page 4 was just given.
          pageIndex: 6,
          purpose: neutralPurpose,
          beat: neutralBeat,
          endingPressure: "Leave the steamers in port.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings: findingsForPages([4, 6]),
      promises: [],
      lastPageIndex: 8
    });

    // A forward pass puts a retained original only to the rewrites behind it, so
    // page 4's angle was never asked about page 6 again and both pages shipped
    // the same beat — a near-duplicate on a pair nothing measures again, put
    // there by the pass that exists to remove them.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(uBoatBeat);
    expect(pages.find((page) => page.pageIndex === 6)!.beat).toBe(rationBeat);
    expect(pages.find((page) => page.pageIndex === 5)!.beat).toBe(neutralBeat);
    // Dropping is the whole penalty, so both pages still get the note this pass
    // guarantees whether or not a rewrite arrived.
    expect(pages.find((page) => page.pageIndex === 4)!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 1/)
    ]);
    expect(pages.find((page) => page.pageIndex === 6)!.requiredContinuity).toEqual([
      expect.stringMatching(/^Stay distinct from page 3/)
    ]);
  });

  it("keeps an accepted rewrite the page handed back does not collide with", async () => {
    const briefs = unrelatedBriefs();
    const capture = capturingJsonModel({
      beatPatches: [
        {
          pageIndex: 4,
          purpose: "Weigh what one requisitioned trawler is worth to its skipper",
          beat: "A Lowestoft skipper signs his boat over to the Admiralty and reckons the winter without it.",
          endingPressure: "Leave the trawler under naval orders.",
          requiredContinuity: []
        },
        {
          pageIndex: 6,
          purpose: neutralPurpose,
          beat: neutralBeat,
          endingPressure: "Leave the steamers in port.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings: findingsForPages([4, 6]),
      promises: [],
      lastPageIndex: 8
    });

    // The settle drops what collides with a retained original and nothing else:
    // over-dropping costs a page a fresh angle it had honestly earned, and this
    // pass may only ever leave a page where it found it.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toMatch(/Lowestoft skipper/);
    expect(pages.find((page) => page.pageIndex === 6)!.beat).toBe(rationBeat);
  });

  it("hands back the original of a rewrite the settle itself drops", async () => {
    const briefs = unrelatedBriefs();
    const capture = capturingJsonModel({
      beatPatches: [
        // Page 5's own assignment, accepted because page 5 is flagged and
        // answered for.
        {
          pageIndex: 4,
          purpose: neutralPurpose,
          beat: neutralBeat,
          endingPressure: "Leave the steamers in port.",
          requiredContinuity: []
        },
        // Page 6's own assignment, accepted for the same reason.
        {
          pageIndex: 5,
          purpose: rationPurpose,
          beat: rationBeat,
          endingPressure: "Leave the ration book half empty.",
          requiredContinuity: []
        },
        // Unflagged page 3's assignment, dropped by the forward pass — which
        // hands page 6 back its ration beat, which drops page 5's answer, which
        // hands page 5 back its neutral beat, which drops page 4's.
        {
          pageIndex: 6,
          purpose: "Show the turnip winter",
          beat: "Rationing collapses into the turnip winter of 1916-17 in German cities.",
          endingPressure: "Leave the pot on the stove.",
          requiredContinuity: []
        }
      ]
    });

    const patch = await dedupePageBeats({
      textModel: capture.model,
      briefs,
      findings: findingsForPages([4, 5, 6]),
      promises: [],
      lastPageIndex: 8
    });

    // The queue is walked as it grows, so a drop the settle makes is put to the
    // rewrites still kept exactly as a drop the forward pass made is. It cannot
    // run away: every entry it adds is a page leaving the kept set for good.
    const pages = mergePageMapCriticPatch(briefs, patch, 8)[0]!.pages;
    expect(pages.find((page) => page.pageIndex === 4)!.beat).toBe(uBoatBeat);
    expect(pages.find((page) => page.pageIndex === 5)!.beat).toBe(neutralBeat);
    expect(pages.find((page) => page.pageIndex === 6)!.beat).toBe(rationBeat);
    expect(patch.beatPatches.map((entry) => entry.beat)).toEqual([undefined, undefined, undefined]);
  });
});
