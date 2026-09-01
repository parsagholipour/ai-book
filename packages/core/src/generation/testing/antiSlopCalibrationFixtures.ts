import type { ManuscriptIntegrityPage } from "../manuscriptQualityIssue.js";

function page(
  index: number,
  markdown: string,
  chapterIndex = 1
): ManuscriptIntegrityPage {
  return { index, chapterIndex, title: `Page ${index}`, markdown };
}

function filler(pageIndex: number, count = 40): string {
  return Array.from({ length: count }, (_, index) => `p${pageIndex}w${index}`).join(" ");
}

/** Clean: a fiction motif returns with a new consequence. */
export function fictionMotifPages(): ManuscriptIntegrityPage[] {
  return [
    page(
      1,
      `Ada hid the cracked lantern under the ferry bench before the storm closed the river. ${filler(1)}`
    ),
    page(
      2,
      `At the far bank Ada opened the same lantern and used its last oil to signal the mill, which had never seen that light. ${filler(2)}`
    )
  ];
}

/** Clean: instructional terminology repeats because it is the defined term. */
export function instructionalTerminologyPages(): ManuscriptIntegrityPage[] {
  return [
    page(
      1,
      `A bandha is a check dam that stores monsoon water. The first bandha at Banda is stacked stone across a seasonal channel. ${filler(1)}`
    ),
    page(
      2,
      `Repairing a bandha after a flood means walking the crest and packing the same stone. The method, not a new definition, is the lesson. ${filler(2)}`
    )
  ];
}

/** Boundary: short imported-like manuscript, two pages, distinct evidence. */
export function importedShortPages(): ManuscriptIntegrityPage[] {
  return [
    page(1, `The ledger from 1912 lists three pumps on Canal Street and the hours they ran. ${filler(1, 20)}`),
    page(2, `The 1914 repair invoice names a different foundry and a cracked impeller, not the Canal Street pumps. ${filler(2, 20)}`)
  ];
}

/** Boundary: deliberate parallel chapter structure with distinct evidence. */
export function deliberateParallelChapterPages(): ManuscriptIntegrityPage[] {
  return [
    page(
      1,
      `Chapter one asks what the Nile flood measured, who recorded cubits, and what those cubits bought in grain. The Palermo Stone lists cubit heights for several reigns. ${filler(1)}`,
      1
    ),
    page(
      2,
      `Chapter two asks what the Yellow River flood measured, who recorded the silt line, and what that silt line bought in millet. Han canal memorials name silt, not cubits. ${filler(2)}`,
      2
    )
  ];
}
