import { unsupportedGenerateWithTools } from "../../adapters/fake.js";
import type { TextModelAdapter } from "../../adapters/types.js";
import type { ChapterBrief, PageProductionBeat } from "../../schemas/book.js";
import { MAX_BEAT_DEDUP_FINDINGS, type DuplicateBeatFinding } from "../pageBeatDedup.js";

/**
 * The page maps both halves of the beat-dedup suite are measured against, and
 * the capturing model the rewrite half puts in front of the real pass.
 *
 * They live here because the split in that suite is between *detection* and the
 * *rewrite call* — two passes over one map — and every map is evidence for both:
 * `collidingBriefs` is what detection flags and what the rewrite call is then
 * asked to repair, and `saturatedBriefs` is the same map read once for what the
 * sweep finds past the cap and once for what is put to the model. Copying them
 * into two files would let the two halves drift onto different books and quietly
 * stop being about the same thing.
 */

export function beat(
  pageIndex: number,
  chapterIndex: number,
  purpose: string,
  beatLine: string
): PageProductionBeat {
  return {
    pageIndex,
    chapterIndex,
    purpose,
    beat: beatLine,
    requiredContinuity: [],
    endingPressure: "Carry a concrete consequence into the next page."
  };
}

export const blockadePurpose = "Explain how the naval blockade strangled the German war economy";
export const blockadeBeat =
  "Show the distant patrols of the North Sea blockade cutting Germany's supply lines and starving its industry of imports.";

/** Two chapters briefed apart, assigning the same blockade beat twice. */
export function collidingBriefs(): ChapterBrief[] {
  return [
    {
      chapterIndex: 1,
      title: "The war at sea",
      summary: "The naval war.",
      continuityFocus: [],
      pages: [
        beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
        beat(2, 1, blockadePurpose, blockadeBeat)
      ]
    },
    {
      chapterIndex: 2,
      title: "The home fronts",
      summary: "Civilians under pressure.",
      continuityFocus: [],
      pages: [
        beat(3, 2, "Show the turnip winter", "Rationing collapses into the turnip winter of 1916-17 in German cities."),
        beat(4, 2, blockadePurpose, blockadeBeat)
      ]
    }
  ];
}

export const squeezedPurpose = "Explain how the naval blockade squeezed the German war economy";
export const squeezedBeat =
  "Show the distant patrols of the North Sea blockade cutting Germany's supply lines and leaving its factories short of ore.";

/**
 * A collision chain inside one chapter: page 3 near-duplicates page 2, and page
 * 4 is a verbatim copy of page 3 — so page 3 is both a flagged page and page
 * 4's *strongest* earlier match (1.00 phrasing against 0.72), which is what
 * makes it the pair the sweep has to refuse.
 */
export function chainedBriefs(): ChapterBrief[] {
  return [
    {
      chapterIndex: 1,
      title: "The war at sea",
      summary: "The naval war.",
      continuityFocus: [],
      pages: [
        beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
        beat(2, 1, blockadePurpose, blockadeBeat),
        beat(3, 1, squeezedPurpose, squeezedBeat),
        beat(4, 1, squeezedPurpose, squeezedBeat)
      ]
    }
  ];
}

export const orePurpose = "Explain how the shortage of ore squeezed the German war economy";
export const oreBeat =
  "Show the factories of the Ruhr cutting their output as supply lines leave them short of ore and coke.";

/**
 * The chain the overlap rule is **not transitive** over, which is the only shape
 * that can strand a page: page 4 near-duplicates page 3 (0.72 phrasing, 0.83
 * keywords) and page 5 near-duplicates page 4 (0.75 keywords), while page 5
 * against page 3 clears neither bar (0.21 / 0.55). So page 4 is flagged against
 * page 3 and wins the first rewrite slot, and page 5's *only* match is a page
 * about to be rewritten — which is the sweep's one refusal, and therefore the
 * page that used to come out of detection with nothing at all.
 *
 * Pages 1 and 2 collide with nothing here and with nothing the rewrite cases
 * answer with, so they are the map every fresh angle in this fixture's tests has
 * to be measured against rather than more of the collision.
 */
export function refusedMatchBriefs(): ChapterBrief[] {
  return [
    {
      chapterIndex: 1,
      title: "The war at sea",
      summary: "The naval war.",
      continuityFocus: [],
      pages: [
        beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
        beat(2, 1, "Show the turnip winter", "Rationing collapses into the turnip winter of 1916-17 in German cities."),
        beat(3, 1, blockadePurpose, blockadeBeat),
        beat(4, 1, squeezedPurpose, squeezedBeat),
        beat(5, 1, orePurpose, oreBeat)
      ]
    }
  ];
}

/**
 * A map that fills the rewrite call's slots and keeps going: page 1 opens, pages
 * 2-14 assign the blockade beat verbatim — exactly `MAX_BEAT_DEDUP_FINDINGS`
 * findings — and pages 15-16 are one more collision behind them. That is the
 * 2026-08-22 book's own shape, where the dense pairs sat in the opening chapters
 * and eight more sat in chapters 9-12. Page 16 near-duplicates page 15 more
 * strongly than anything in front of it, which is what tells the two bounds
 * apart: page 15 is flagged and is *not* being rewritten, so it is a page the
 * sweep may name.
 */
export function saturatedBriefs(): ChapterBrief[] {
  return [
    {
      chapterIndex: 1,
      title: "The war at sea",
      summary: "The naval war.",
      continuityFocus: [],
      pages: [
        beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
        ...Array.from({ length: MAX_BEAT_DEDUP_FINDINGS + 1 }, (_, index) =>
          beat(index + 2, 1, blockadePurpose, blockadeBeat)
        )
      ]
    },
    {
      chapterIndex: 2,
      title: "The home fronts",
      summary: "Civilians under pressure.",
      continuityFocus: [],
      pages: [beat(15, 2, squeezedPurpose, squeezedBeat), beat(16, 2, squeezedPurpose, squeezedBeat)]
    }
  ];
}

/**
 * A map of `pageCount` pages that collide with nothing, for the cases about the
 * *shape* of the sweep rather than its judgement: how long it holds the event
 * loop, and whether a collision is still found across the pauses it takes. Sized
 * in pages by the caller because what the pause budget counts is pairs, and a
 * page count derived from `BEAT_SWEEP_PAIRS_PER_SLICE` is a case that keeps
 * meaning what it says when that budget moves.
 *
 * The filler is vocabulary rather than prose, and every content word carries its
 * own page's number, so no two pages share a trigram and a pair shares two
 * keywords out of fifteen. That is the point: these cases assert an exact
 * finding list, and one filler page colliding with another by accident would
 * move it. The maps above are the prose this pass is actually measured on.
 */
export function sweepPressureBriefs(pageCount: number): ChapterBrief[] {
  const perChapter = 10;
  const briefs: ChapterBrief[] = [];
  for (let start = 1; start <= pageCount; start += perChapter) {
    const chapterIndex = Math.floor((start - 1) / perChapter) + 1;
    briefs.push({
      chapterIndex,
      title: `Chapter ${chapterIndex}`,
      summary: "A chapter of the pressure map.",
      continuityFocus: [],
      pages: Array.from({ length: Math.min(perChapter, pageCount - start + 1) }, (_, offset) => {
        const pageIndex = start + offset;
        return beat(
          pageIndex,
          chapterIndex,
          `Assign kiln${pageIndex} ledger${pageIndex} quay${pageIndex}`,
          `Show wharf${pageIndex} crate${pageIndex} tariff${pageIndex} clerk${pageIndex} barrel${pageIndex} ` +
            `skipper${pageIndex} tide${pageIndex} signal${pageIndex} lantern${pageIndex} rope${pageIndex}.`
        );
      })
    });
  }
  return briefs;
}

/** The same map with one page assigned another page's beat verbatim. */
export function withCopiedBeat(briefs: ChapterBrief[], options: { from: number; to: number }): ChapterBrief[] {
  const source = briefs.flatMap((brief) => brief.pages).find((page) => page.pageIndex === options.from)!;
  return briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) =>
      page.pageIndex === options.to ? { ...page, purpose: source.purpose, beat: source.beat } : page
    )
  }));
}

export function distinctBriefs(): ChapterBrief[] {
  return [
    {
      chapterIndex: 1,
      title: "The war at sea",
      summary: "The naval war.",
      continuityFocus: [],
      pages: [
        beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
        beat(2, 1, blockadePurpose, blockadeBeat),
        beat(3, 1, "Follow one U-boat patrol", "A single submarine crew hunts a convoy through fog off the Irish coast."),
        beat(4, 1, "Show the turnip winter", "Rationing collapses into the turnip winter of 1916-17 in German cities.")
      ]
    }
  ];
}

export const uBoatPurpose = "Follow one U-boat patrol";
export const uBoatBeat = "A single submarine crew hunts a convoy through fog off the Irish coast.";
export const neutralPurpose = "Count what the neutral shipping lines lost";
export const neutralBeat = "Norwegian and Dutch masters weigh the risk of sailing at all and lay their steamers up in port.";
export const rationPurpose = "Trace one family's ration book through a single week";
export const rationBeat =
  "A Hamburg widow queues before dawn for turnips and counts the coupons her three children will not have by Friday.";

/**
 * Six pages that collide with nothing, for the cases about what the *rewrite*
 * pass does with the findings it is handed rather than about detection. Those
 * findings are written by hand here for the reason `fake.test.ts` writes its
 * own: a beat close enough for detection to flag page 6 is by construction close
 * enough to collide with the unflagged page that flagged it, which is the older
 * rule these cases exist to be told apart from.
 */
export function unrelatedBriefs(): ChapterBrief[] {
  return [
    {
      chapterIndex: 1,
      title: "The war at sea",
      summary: "The naval war.",
      continuityFocus: [],
      pages: [
        beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
        beat(2, 1, blockadePurpose, blockadeBeat),
        beat(3, 1, "Show the turnip winter", "Rationing collapses into the turnip winter of 1916-17 in German cities."),
        beat(4, 1, uBoatPurpose, uBoatBeat),
        beat(5, 1, neutralPurpose, neutralBeat),
        beat(6, 1, rationPurpose, rationBeat)
      ]
    }
  ];
}

export function findingFor(pageIndex: number, duplicateOfPageIndex: number, earlierText: string): DuplicateBeatFinding {
  return {
    pageIndex,
    duplicateOfPageIndex,
    earlierText,
    reason: `phrasing overlaps page ${duplicateOfPageIndex}'s beat (99%)`
  };
}

/** The same map with one page carrying continuity written for the beat it has. */
export function withPageContinuity(briefs: ChapterBrief[], pageIndex: number, lines: string[]): ChapterBrief[] {
  return briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) => (page.pageIndex === pageIndex ? { ...page, requiredContinuity: lines } : page))
  }));
}

/**
 * The same map with one page illustrated. `beat` writes no `imageMoment` — the
 * field is optional on `PageProductionBeat` and plenty of maps assign none — so
 * every fixture here is an unillustrated book until a case says otherwise, which
 * is the half of the rule that says a page must not *gain* a picture.
 */
export function withPageImageMoment(briefs: ChapterBrief[], pageIndex: number, imageMoment: string): ChapterBrief[] {
  return briefs.map((brief) => ({
    ...brief,
    pages: brief.pages.map((page) => (page.pageIndex === pageIndex ? { ...page, imageMoment } : page))
  }));
}

export function capturingJsonModel(rawData: unknown): {
  model: TextModelAdapter;
  system?: string;
  payload?: Record<string, any>;
  purpose?: string | undefined;
} {
  const capture: {
    model: TextModelAdapter;
    system?: string;
    payload?: Record<string, any>;
    purpose?: string | undefined;
  } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.purpose = options.purpose;
        capture.system = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, any>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}
