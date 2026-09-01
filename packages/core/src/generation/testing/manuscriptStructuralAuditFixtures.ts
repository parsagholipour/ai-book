import type { ManuscriptIntegrityPage } from "../manuscriptQualityIssue.js";

function page(
  index: number,
  markdown: string,
  chapterIndex = 1
): ManuscriptIntegrityPage {
  return { index, chapterIndex, title: `Page ${index}`, markdown };
}

const INDUS_WEIGHTS_A = [
  "Cubical chert weights recovered at Harappa and Mohenjo-daro around 2600 BCE follow a repeated ratio across the citadel workshop.",
  "The standardized weights therefore show administrative control of Indus trade, because merchants could not bargain past the stone cubes kept beside the granary.",
  "A 13.63 gram unit recurs among the cubical chert stones, and the same balance pans appear in both Harappa and Mohenjo-daro.",
  "Harappa's clerks recorded the stones in the sequence Mohenjo-daro used, which resulted in a shared market language.",
  "The surviving weights prove that Indus officials constrained exchange rather than leaving measure to each household.",
  "Craft debris around the citadel workshop matches the chert cubes, so the administrative system produced the trade standard.",
  "Thus the evidence shows administrative control of Indus trade through cubical chert weights."
].join(" ");

const INDUS_WEIGHTS_B = [
  "At Mohenjo-daro and Harappa, cubical chert stones dated near 2600 BCE keep the same ratio in the citadel workshop hoard.",
  "Those standardized weights therefore show administrative control of Indus trade, because a merchant had to accept the cubes stored by the granary.",
  "The 13.63 gram unit turns up again among cubical chert stones, and matching balance pans sit in Harappa as they do in Mohenjo-daro.",
  "Clerks at Harappa listed the stones in Mohenjo-daro's order, which resulted in one market language along the Indus.",
  "Surviving weights prove Indus officials constrained exchange instead of letting every household invent a measure.",
  "Workshop debris beside the citadel still matches the chert cubes, so the administrative system produced that trade standard.",
  "The evidence therefore shows administrative control of Indus trade by cubical chert weights."
].join(" ");

const INDUS_WEIGHTS_C = [
  "Harappa and Mohenjo-daro both stored cubical chert weights around 2600 BCE, cut to a repeated ratio in the citadel workshop.",
  "Standardized weights therefore show administrative control of Indus trade, because bargaining stopped at the stone cubes kept near the granary.",
  "Cubical chert stones of 13.63 grams recur, and the balance pans from Harappa match those from Mohenjo-daro.",
  "The sequence Harappa's clerks copied from Mohenjo-daro resulted in a shared market language.",
  "Indus officials constrained exchange, as the surviving weights prove, rather than leaving measure to each household.",
  "Chert cubes match craft debris around the citadel workshop, so the administrative system produced the trade standard.",
  "Accordingly the evidence shows administrative control of Indus trade through those cubical chert weights."
].join(" ");

const INDUS_WEIGHTS_D = [
  "Around 2600 BCE the citadel workshop at Harappa and at Mohenjo-daro issued cubical chert weights in a repeated ratio.",
  "The standardized weights therefore show administrative control of Indus trade, because merchants met stone cubes stored by the granary.",
  "Balance pans and cubical chert stones of 13.63 grams appear together in Harappa and in Mohenjo-daro.",
  "Copying Mohenjo-daro's list at Harappa resulted in one market language for the Indus.",
  "Households did not invent the measure: surviving weights prove Indus officials constrained exchange.",
  "The administrative system produced the trade standard, since citadel workshop debris matches the chert cubes.",
  "The evidence thus shows administrative control of Indus trade by cubical chert weights."
].join(" ");

export function fourParaphrasedIndusWeightPages(): ManuscriptIntegrityPage[] {
  return [
    page(1, INDUS_WEIGHTS_A),
    page(2, INDUS_WEIGHTS_B),
    page(3, INDUS_WEIGHTS_C),
    page(4, INDUS_WEIGHTS_D)
  ];
}

export function indusSubjectDistinctEvidencePages(): ManuscriptIntegrityPage[] {
  return [
    page(
      1,
      [
        "Cubical chert weights from Harappa around 2600 BCE sit in the citadel workshop beside balance pans.",
        "The standardized weights therefore show administrative control of Indus trade, because merchants accepted the stone cubes.",
        "A 13.63 gram unit recurs among those cubical chert stones at Harappa.",
        "The closing claim is that cubical chert weights stored near the granary measured Indus trade.",
        uniqueFiller(1)
      ].join(" ")
    ),
    page(
      2,
      [
        "Monsoon floods around Harappa on the Indus deposited silt that barley and wheat fields needed each summer.",
        "Farmers timed sowing after the inundation; delayed planting ruined the harvest on those Indus banks.",
        "Emmer stores in the lower town show how the monsoon, not a later canal, fed the Indus fields at Harappa.",
        "The harvest record is agricultural dependence on monsoon silt rather than on a royal irrigation edict.",
        uniqueFiller(2)
      ].join(" ")
    ),
    page(
      3,
      [
        "Steatite seals from Harappa carry unicorns and short pictographs unlike later Brahmi letters.",
        "Unfinished blanks remain in the house floors, marking a writing workshop on the Indus.",
        "Unicorn iconography at Harappa is local to the steatite corpus and does not copy Mesopotamian combat scenes.",
        "The seal corpus is a script experiment rather than an imported cuneiform office.",
        uniqueFiller(3)
      ].join(" ")
    ),
    page(
      4,
      [
        "Baked brick drains under Harappa's streets carried household waste to covered Indus channels.",
        "Inspection shafts open at regular intervals along those brick courses in the lower town.",
        "Latrines connected to those baked drains keep the lower town drier than an open ditch would have.",
        "The street plan is civic drainage engineering rather than accidental puddles.",
        uniqueFiller(4)
      ].join(" ")
    )
  ];
}

export function isolatedBalancedCaveatPages(): ManuscriptIntegrityPage[] {
  return Array.from({ length: 20 }, (_, offset) => {
    const index = offset + 1;
    const body =
      index === 8
        ? "The treaty was neither a surrender nor an alliance; its third clause created a temporary armistice."
        : "The argument commits to a bounded claim supported by the episode.";
    return page(index, `${body} ${uniqueFiller(index)}`, Math.ceil(index / 4));
  });
}

export function manuscriptWideSymmetricalHedgingPages(): ManuscriptIntegrityPage[] {
  return Array.from({ length: 120 }, (_, offset) => {
    const index = offset + 1;
    const hedge = index % 3 === 0;
    const body = hedge
      ? `The outcome was neither purely institutional nor simply cultural; case ${index} combined both pressures.`
      : "The argument commits to a bounded claim supported by the dated episode.";
    return page(index, `${body} ${uniqueFiller(index)}`, Math.ceil(index / 4));
  });
}

export function interiorRatherThanCadencePages(count: number): ManuscriptIntegrityPage[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const markdown = [
      `Dawn${index} began with a local errand through the lower market.`,
      "Rather than wait for the council, the scouts crossed the ridge before the fog lifted.",
      `Farmers stored millet in stone bins near yard${index} while the river dropped.`
    ].join(" ");
    return page(index, `${markdown} ${uniqueFiller(index)}`, Math.ceil(index / 5));
  });
}

export function nonCountableCadenceDecoyPages(): ManuscriptIntegrityPage[] {
  const decoy = [
    "# Rather than a heading this is a title",
    "",
    "- Rather than a list item remaining here",
    "",
    "> Rather than a quoted aside remaining here",
    "",
    "Dr. Rather waited beside the gate until the cart arrived.",
    '"Rather than quoted speech," she said, and closed the ledger.',
    "Rather.",
    "Local farmers stored millet in stone bins while the river dropped through the afternoon heat."
  ].join("\n");
  return Array.from({ length: 6 }, (_, offset) => {
    const index = offset + 1;
    return page(index, `${decoy}\n\n${uniqueFiller(index)}`, 1);
  });
}

export function singleRatherThanUsePages(): ManuscriptIntegrityPage[] {
  return Array.from({ length: 8 }, (_, offset) => {
    const index = offset + 1;
    const interior =
      index === 3
        ? "Rather than wait for the council, the scouts crossed the ridge before the fog lifted."
        : `Messengers${index} carried a short note toward the harbor before noon.`;
    return page(
      index,
      `Dawn${index} began with a local errand. ${interior} ${uniqueFiller(index)}`,
      1
    );
  });
}

export function bandhaRecapPages(): ManuscriptIntegrityPage[] {
  const establishment = [
    "A bandha is a check dam that stores monsoon water on the Bundelkhand plateau.",
    "Village councils stacked stone across seasonal channels so fields could drink after the rains ended.",
    "The first recorded bandha at Banda therefore established a local irrigation store rather than a royal canal.",
    "Farmers walked the crest after each monsoon to repair gaps before the next sowing."
  ].join(" ");
  const recap = [
    "As we saw, a bandha is a check dam that stores monsoon water on the Bundelkhand plateau.",
    "In other words, village councils stacked stone across seasonal channels so fields could drink after the rains ended.",
    "Recall that the first recorded bandha at Banda therefore established a local irrigation store rather than a royal canal.",
    "Farmers again walked the crest after each monsoon to repair gaps before the next sowing."
  ].join(" ");
  const later = [
    "As already established, a bandha is a check dam that stores monsoon water on the Bundelkhand plateau.",
    "To recap, village councils stacked stone across seasonal channels so fields could drink after the rains ended.",
    "Remember that the first recorded bandha at Banda therefore established a local irrigation store rather than a royal canal.",
    "The same crest walk after each monsoon repaired gaps before the next sowing."
  ].join(" ");
  return [
    page(1, `${establishment} ${establishment}`),
    page(2, `${recap} ${recap}`),
    page(3, `${later} ${later}`)
  ];
}

export function persianWithEnglishHedgeIslands(): ManuscriptIntegrityPage[] {
  return Array.from({ length: 20 }, (_, offset) => {
    const index = offset + 1;
    const hedge = [3, 8, 13, 18].includes(index)
      ? " neither purely institutional nor simply cultural "
      : " ";
    const body = `تاریخ این صفحه با شواهد محلی پیش می‌رود.${hedge}کشاورزان در دره کار می‌کردند و رودخانه مسیر خود را تغییر داد.`;
    return page(index, `${body} ${persianFiller(index)}`, Math.ceil(index / 4));
  });
}

export function performanceManuscript(pageCount: number): ManuscriptIntegrityPage[] {
  return Array.from({ length: pageCount }, (_, offset) => {
    const index = offset + 1;
    return page(
      index,
      `Page ${index} follows a distinct errand through valley${index}. ${uniqueFiller(index, 110)}`,
      Math.ceil(index / 5)
    );
  });
}

export function uniqueFiller(page: number, count = 90): string {
  return Array.from({ length: count }, (_, index) => `p${page}w${index}`).join(" ");
}

function persianFiller(page: number): string {
  return Array.from({ length: 80 }, (_, index) => `واژه${page}ن${index}`).join(" ");
}
