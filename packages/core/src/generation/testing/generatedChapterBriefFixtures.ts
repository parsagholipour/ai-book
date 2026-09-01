import type { GeneratedChapterBriefContract } from "../generatedChapterBriefAcceptance.js";

/**
 * Distilled from the malformed mechanics-book response that motivated the
 * strict generated-response seam. These fixtures are deliberately independent
 * of storage/ so every later anti-slop phase can reuse them.
 */
export const mechanicsChapterBriefContract: GeneratedChapterBriefContract = {
  chapterIndex: 2,
  pageRange: { start: 4, end: 6 },
  allowCompleteLocalPageNumbering: true
};

export const numericPageArrayResponse = {
  chapterIndex: 2,
  title: "Forces in Contact",
  summary: "Friction turns contact into a measurable change in motion.",
  pages: [4, 5, 6],
  continuityFocus: []
};

const MECHANICS_CHAPTER_PAGE_DETAILS: Array<{ purpose: string; beat: string; endingPressure: string }> = [
  {
    purpose: "Introduce friction as the force resisting relative motion between two surfaces.",
    beat: "A crate remains still until the applied pull exceeds the measured static-friction threshold.",
    endingPressure: "The threshold measurement raises the question of what changes once the crate starts sliding."
  },
  {
    purpose: "Distinguish kinetic friction from the larger force needed to start motion.",
    beat: "The same spring scale settles at a lower reading while the crate moves at constant speed.",
    endingPressure: "The lower reading makes surface material the next variable that must be isolated."
  },
  {
    purpose: "Connect friction coefficients to the materials pressed together.",
    beat: "Rubber, wood, and felt produce different force ratios under the same normal load.",
    endingPressure: "Those ratios complete the chapter's explanation of how contact changes motion."
  }
];

export function mechanicsPage(pageIndex: number, chapterIndex = 2) {
  const detail: { purpose: string; beat: string; endingPressure: string } = (pageIndex >= 1 && pageIndex <= 6
    ? MECHANICS_CHAPTER_PAGE_DETAILS[(pageIndex - 1) % 3]
    : undefined) ?? {
    purpose: `Test how an additional surface changes the friction measurement on page ${pageIndex}.`,
    beat: `A fresh material produces a distinct spring-scale reading during trial ${pageIndex}.`,
    endingPressure: `The additional trial exposes why page ${pageIndex} lies outside the assigned chapter range.`
  };
  return {
    pageIndex,
    chapterIndex,
    ...detail,
    requiredContinuity: ["Keep the crate's normal load constant across measurements."]
  };
}

export function validGlobalChapterBriefResponse() {
  return {
    chapterIndex: 2,
    title: "Forces in Contact",
    summary: "Friction turns contact into a measurable change in motion.",
    pages: [mechanicsPage(4), mechanicsPage(5), mechanicsPage(6)],
    continuityFocus: ["Keep the crate's normal load constant across measurements."]
  };
}

function responseWithPages(pages: unknown[]) {
  return { ...validGlobalChapterBriefResponse(), pages };
}

const metadataOnlyPurposeAlias = "function";

export const malformedGeneratedChapterBriefFixtures: Array<{
  name: string;
  raw: unknown;
  expectedCode: string;
  expectedIndexes: number[];
}> = [
  {
    name: "descriptive string pages",
    raw: responseWithPages([
      "Measure when the crate begins moving.",
      "Compare the force while it slides.",
      "Change the material under the crate."
    ]),
    expectedCode: "PAGE_NOT_OBJECT",
    expectedIndexes: [4, 5, 6]
  },
  {
    name: "pageIndex global strings",
    raw: responseWithPages(["pageIndex global 4", "pageIndex global 5", "pageIndex global 6"]),
    expectedCode: "PAGE_NOT_OBJECT",
    expectedIndexes: [4, 5, 6]
  },
  {
    name: "non-integer page index",
    raw: responseWithPages([{ ...mechanicsPage(4), pageIndex: 4.5 }, mechanicsPage(5), mechanicsPage(6)]),
    expectedCode: "PAGE_INDEX_INVALID",
    expectedIndexes: [4]
  },
  {
    name: "object missing pageIndex",
    raw: responseWithPages([
      Object.fromEntries(Object.entries(mechanicsPage(4)).filter(([key]) => key !== "pageIndex")),
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "PAGE_INDEX_INVALID",
    expectedIndexes: [4]
  },
  {
    name: "missing purpose",
    raw: responseWithPages([{ ...mechanicsPage(4), purpose: undefined }, mechanicsPage(5), mechanicsPage(6)]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "missing beat",
    raw: responseWithPages([{ ...mechanicsPage(4), beat: undefined }, mechanicsPage(5), mechanicsPage(6)]),
    expectedCode: "BEAT_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "missing ending pressure",
    raw: responseWithPages([
      { ...mechanicsPage(4), endingPressure: undefined },
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "ENDING_PRESSURE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "blank purpose",
    raw: responseWithPages([{ ...mechanicsPage(4), purpose: "  \n " }, mechanicsPage(5), mechanicsPage(6)]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "metadata-only fields",
    raw: responseWithPages([
      {
        ...mechanicsPage(4),
        purpose: "page 4",
        beat: "pageIndex global 4",
        endingPressure: "endingPressure page 4"
      },
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "metadata-only alias fields",
    raw: responseWithPages([
      {
        ...mechanicsPage(4),
        purpose: metadataOnlyPurposeAlias,
        beat: "action",
        endingPressure: "pageTurn"
      },
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "generic one-word placeholders",
    raw: responseWithPages([
      {
        ...mechanicsPage(4),
        purpose: "Introduction",
        beat: "Continue",
        endingPressure: "Tension"
      },
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "generic normalized assignment",
    raw: responseWithPages([
      {
        ...mechanicsPage(4),
        purpose: "Advance_the chapter — on PAGE 4!",
        beat: "Advance the chapter with a concrete, non-repetitive beat on page 4.",
        endingPressure: "Leave a concrete reason for the next page to continue."
      },
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "generic book-level assignment",
    raw: responseWithPages([
      {
        ...mechanicsPage(4),
        purpose: "Advance the book on page 4.",
        beat: "A concrete turn for page 4.",
        endingPressure: "A reason page 4 must continue."
      },
      mechanicsPage(5),
      mechanicsPage(6)
    ]),
    expectedCode: "PURPOSE_NOT_SUBSTANTIVE",
    expectedIndexes: [4]
  },
  {
    name: "duplicate page index",
    raw: responseWithPages([mechanicsPage(4), mechanicsPage(4), mechanicsPage(6)]),
    expectedCode: "DUPLICATE_PAGE_INDEX",
    expectedIndexes: [4]
  },
  {
    name: "missing page index",
    raw: responseWithPages([mechanicsPage(4), mechanicsPage(6)]),
    expectedCode: "MISSING_PAGE_INDEX",
    expectedIndexes: [5]
  },
  {
    name: "extra page index",
    raw: responseWithPages([mechanicsPage(4), mechanicsPage(5), mechanicsPage(6), mechanicsPage(7)]),
    expectedCode: "EXTRA_PAGE_INDEX",
    expectedIndexes: [7]
  },
  {
    name: "mixed local and global page indexes",
    raw: responseWithPages([mechanicsPage(1), mechanicsPage(5), mechanicsPage(3)]),
    expectedCode: "MIXED_PAGE_NUMBERING",
    expectedIndexes: [1, 5, 3]
  },
  {
    name: "duplicate local page index",
    raw: responseWithPages([mechanicsPage(1), mechanicsPage(1), mechanicsPage(3)]),
    expectedCode: "DUPLICATE_PAGE_INDEX",
    expectedIndexes: [1]
  }
];

export function validLocalChapterBriefResponse() {
  return {
    ...validGlobalChapterBriefResponse(),
    pages: [mechanicsPage(1), mechanicsPage(2), mechanicsPage(3)]
  };
}

export function validAliasedChapterBriefResponse() {
  return {
    productionBrief: {
      chapterNumber: "2",
      chapterTitle: "Forces in Contact",
      chapterSummary: "Friction turns contact into a measurable change in motion.",
      pagePlans: {
        first: {
          globalPageIndex: "4",
          chapterNumber: "2",
          objective: mechanicsPage(4).purpose,
          action: mechanicsPage(4).beat,
          continuityNotes: mechanicsPage(4).requiredContinuity,
          nextPagePressure: mechanicsPage(4).endingPressure
        },
        second: {
          globalPageIndex: "5",
          chapterNumber: "2",
          objective: mechanicsPage(5).purpose,
          action: mechanicsPage(5).beat,
          continuityNotes: mechanicsPage(5).requiredContinuity,
          nextPagePressure: mechanicsPage(5).endingPressure
        },
        third: {
          globalPageIndex: "6",
          chapterNumber: "2",
          objective: mechanicsPage(6).purpose,
          action: mechanicsPage(6).beat,
          continuityNotes: mechanicsPage(6).requiredContinuity,
          nextPagePressure: mechanicsPage(6).endingPressure
        }
      },
      continuityNotes: ["Keep the crate's normal load constant across measurements."]
    }
  };
}
