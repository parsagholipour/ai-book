/**
 * The designs a text-only story sheet can be printed in.
 *
 * A picture book with no pictures prints one scene a sheet, and a design is
 * what fills the rest of that sheet: a card, its colours, a few drawn shapes,
 * a face and an ornament. The catalog is data — `pdfStoryPages.ts` generates
 * the stylesheet from it and sizes every scene against the same card — so a
 * design is one entry here and nothing else.
 *
 * Which design a book wears is the reader's to say. An explicit choice is a
 * row-owned preference (`storyPageDesign` on `Project.mediaSettings`, written
 * by the chat's free `page_design` edit), read at every compile like the
 * chapter-heading style. Without one, a children's book is matched to its own
 * words (`chooseStoryPageDesign`): a request that names a design gets it, and
 * otherwise the subject decides — a bedtime story the night sky, a pirate
 * story the sea — with the pastel storybook as the fallback. Any other book
 * prints `classic`, the plain sheet it always had.
 */

export const STORY_PAGE_DESIGN_IDS = [
  "storybook",
  "night",
  "ocean",
  "meadow",
  "rainbow",
  "space",
  "fairytale",
  "classic"
] as const;
export type StoryPageDesignId = (typeof STORY_PAGE_DESIGN_IDS)[number];

/** The face a design sets its prose in: Nunito, or the book's own serif. */
export type StoryPageDesignFace = "rounded" | "serif";

export type StoryPageDesign = {
  id: StoryPageDesignId;
  /** What the reader calls it: "Night sky". */
  label: string;
  /** One line the chat can say about it. */
  summary: string;
  /** Words that name the design itself in a request ("the night sky design"). */
  names: RegExp;
  /** Words that put a book's subject in this design's world (bedtime, moon…). */
  topics: RegExp;
  face: StoryPageDesignFace;
  /** Set when the chapter title takes Playfair Display. */
  displayHeadings?: true;
  /** Absent: no card, the plain sheet. `borderMm` is a border inside the card's height. */
  card?: { paddingMm: number; radiusMm: number; borderMm?: number; extra?: string };
  /** The prose colour, and the chapter title's. */
  ink: string;
  headingInk: string;
  /** One entry per sheet, cycled: the card's fill and the accent its shapes use. */
  sheets: ReadonlyArray<{ fill: string; accent: string }>;
  /** Background layers over the fill, drawn with `var(--story-accent)`. */
  shapes: readonly string[];
  /** The `::after` ornament under the prose. */
  ornament: string;
};

const mix = (share: number, colour = "var(--story-accent)") => `color-mix(in srgb, ${colour} ${share}%, transparent)`;
/** A filled circle. */
const dot = (x: number, y: number, radiusMm: number, colour: string) =>
  `radial-gradient(circle at ${x}% ${y}%, ${colour} 0 ${radiusMm}mm, transparent ${radiusMm + 0.3}mm)`;
/** A bubble: a thin ring. */
const ring = (x: number, y: number, radiusMm: number, colour: string) =>
  `radial-gradient(circle at ${x}% ${y}%, transparent 0 ${radiusMm - 0.6}mm, ${colour} ${radiusMm - 0.5}mm ${radiusMm}mm, transparent ${radiusMm + 0.3}mm)`;
/** A rolling hill or wave: the top of a wide ellipse rising from below the card. */
const hill = (x: number, widthMm: number, heightMm: number, colour: string) =>
  `radial-gradient(ellipse ${widthMm}mm ${heightMm}mm at ${x}% 100%, ${colour} 0 99%, transparent 100%)`;
/** A soft glow, for a sun or a moon. */
const glow = (x: number, y: number, radiusMm: number, colour: string) =>
  `radial-gradient(circle at ${x}% ${y}%, ${colour} 0 ${radiusMm}mm, ${mix(35, colour)} ${radiusMm + 1.5}mm, transparent ${radiusMm + 5}mm)`;
const dots = (colour: string) =>
  `radial-gradient(circle, ${colour} 0 1.3mm, transparent 1.5mm) 0 50% / 5.33mm 3.2mm repeat-x`;
const stars = (colour: string): string[] =>
  [
    [12, 9, 0.8], [26, 15, 0.5], [41, 6, 0.6], [63, 12, 0.5], [17, 30, 0.4], [91, 34, 0.6],
    [8, 58, 0.5], [93, 63, 0.4], [14, 84, 0.6], [57, 92, 0.5], [86, 88, 0.7], [72, 23, 0.4]
  ].map(([x, y, r]) => dot(x!, y!, r!, colour));

const DESIGNS: Record<StoryPageDesignId, StoryPageDesign> = {
  storybook: {
    id: "storybook",
    label: "Storybook pastels",
    summary: "soft pastel cards that change colour every page, with bubbles in the corners",
    names: /\b(?:pastels?|storybook|soft colou?rs?|light colou?rs?|default)\b/i,
    topics: /(?!)/,
    face: "rounded",
    card: { paddingMm: 14, radiusMm: 9 },
    ink: "#2b2440",
    headingInk: "color-mix(in srgb, var(--story-accent) 72%, #2b2440)",
    sheets: [
      { fill: "#fff3c4", accent: "#e39b0b" },
      { fill: "#dcf3e4", accent: "#2f9e64" },
      { fill: "#dcebff", accent: "#3a7bd5" },
      { fill: "#ffe2d6", accent: "#e8673a" },
      { fill: "#ece3ff", accent: "#7c5cc9" },
      { fill: "#ffe1ec", accent: "#d64b84" }
    ],
    shapes: [
      dot(88, 8, 15, mix(22)),
      dot(8, 93, 22, mix(16)),
      dot(14, 10, 2.2, mix(40)),
      dot(22, 5, 1.4, mix(32)),
      dot(82, 94, 1.9, mix(36))
    ],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("var(--story-accent)")};`
  },
  night: {
    id: "night",
    label: "Night sky",
    summary: "deep blue pages with a glowing moon and scattered stars, made for bedtime",
    names: /\b(?:night[- ]?sky|starry|stars? and (?:a |the )?moon|midnight|night|dark(?:er)?|moon(?:lit|light)?)\b/i,
    topics: /\b(?:bed ?time|sleep(?:y|ing)?|good ?night|night(?:time|s)?|moon(?:light|lit)?|dream(?:s|ing|y)?|owls?|lullab(?:y|ies)|dark)\b|شب|خواب|لالایی|رویا|مهتاب/i,
    face: "rounded",
    card: { paddingMm: 14, radiusMm: 9 },
    ink: "#f4f1ff",
    headingInk: "var(--story-accent)",
    sheets: [
      { fill: "linear-gradient(180deg, #1c2757, #2c2463)", accent: "#ffd86b" },
      { fill: "linear-gradient(180deg, #172a4f, #1e3d63)", accent: "#ffe69a" },
      { fill: "linear-gradient(180deg, #24215a, #3a2560)", accent: "#ffc97a" }
    ],
    shapes: [glow(84, 11, 9, "#fff2c2"), ...stars("rgba(255, 244, 214, 0.85)")],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("var(--story-accent)")};`
  },
  ocean: {
    id: "ocean",
    label: "Under the sea",
    summary: "sea-blue pages with rolling waves and rising bubbles",
    names: /\b(?:ocean|under ?(?:the )?sea|sea|underwater|beach|waves?)\b/i,
    topics: /\b(?:ocean|seas?|fish(?:es)?|whales?|dolphins?|beach(?:es)?|shells?|mermaids?|pirates?|boats?|ships?|islands?|sharks?|octopus|waves?|coral|sailors?|harbou?r)\b|دریا|اقیانوس|ماهی|ساحل|نهنگ|دلفین/i,
    face: "rounded",
    card: { paddingMm: 14, radiusMm: 9 },
    ink: "#13324a",
    headingInk: "color-mix(in srgb, var(--story-accent) 75%, #13324a)",
    sheets: [
      { fill: "#dff4f8", accent: "#1f8fb5" },
      { fill: "#dfecff", accent: "#2f6fd1" },
      { fill: "#dcf6ef", accent: "#1e9a87" }
    ],
    shapes: [
      hill(25, 120, 24, mix(26)),
      hill(80, 110, 30, mix(18)),
      ring(86, 12, 3.2, mix(55)),
      ring(80, 21, 2, mix(45)),
      ring(90, 27, 1.4, mix(40)),
      ring(12, 15, 2.4, mix(40))
    ],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("var(--story-accent)")};`
  },
  meadow: {
    id: "meadow",
    label: "Garden meadow",
    summary: "fresh green and sunny pages with soft hills, flowers and a warm sun",
    names: /\b(?:garden|meadow|forest|nature|flowers?|flowery|spring(?:time)?)\b/i,
    topics: /\b(?:gardens?|forests?|woods|flowers?|farms?|bunn(?:y|ies)|rabbits?|trees?|bees?|butterfl(?:y|ies)|meadows?|hedgehogs?|fox(?:es)?|squirrels?|frogs?|picnics?|ducks?|ladybugs?|caterpillars?)\b|باغ|جنگل|گل|مزرعه|خرگوش|درخت|پروانه|زنبور/i,
    face: "rounded",
    card: { paddingMm: 14, radiusMm: 9 },
    ink: "#253318",
    headingInk: "color-mix(in srgb, var(--story-accent) 80%, #253318)",
    sheets: [
      { fill: "#eef8e0", accent: "#4f9a2f" },
      { fill: "#fdf5d6", accent: "#6f9a1f" },
      { fill: "#e3f4e8", accent: "#2f8f5b" }
    ],
    shapes: [
      glow(85, 10, 8, "#ffd75e"),
      dot(22, 85, 1.6, "#f27ba6"),
      dot(31, 88, 1.3, "#ffd75e"),
      dot(74, 84, 1.6, "#f6a04d"),
      dot(83, 87, 1.3, "#f27ba6"),
      hill(20, 130, 26, mix(30)),
      hill(78, 120, 20, mix(22))
    ],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("var(--story-accent)")};`
  },
  rainbow: {
    id: "rainbow",
    label: "Rainbow",
    summary: "bright, cheerful pages with a rainbow in the corner and a new colour every page",
    names: /\b(?:rainbows?|colou?rful|bright(?:er)?|sunny|sunshine|cheerful|vivid|happy|fun)\b/i,
    topics: /\b(?:rainbows?|birthdays?|part(?:y|ies)|paint(?:s|ing)?|circus|carnival|celebrat\w*|colou?rs?|crayons?)\b|رنگین‌کمان|رنگین کمان|تولد|جشن/i,
    face: "rounded",
    card: { paddingMm: 14, radiusMm: 9 },
    ink: "#2a2236",
    headingInk: "var(--story-accent)",
    sheets: [
      { fill: "#fffaf0", accent: "#e8483f" },
      { fill: "#f6fbff", accent: "#2e7fe0" },
      { fill: "#fffaf0", accent: "#16a06a" },
      { fill: "#fbf7ff", accent: "#8a4fd8" },
      { fill: "#fffaf0", accent: "#ef8a1c" }
    ],
    shapes: [
      `radial-gradient(circle at 100% 0%, transparent 0 22mm, #ff6b6b 22mm 25mm, #ffaa4d 25mm 28mm, #ffd94d 28mm 31mm, #6fd18f 31mm 34mm, #5ab0ff 34mm 37mm, #a37bff 37mm 40mm, transparent 40mm)`,
      dot(9, 92, 2.4, mix(45)),
      dot(15, 95, 1.4, mix(35)),
      dot(6, 86, 1.1, mix(30))
    ],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("var(--story-accent)")};`
  },
  space: {
    id: "space",
    label: "Outer space",
    summary: "starry purple pages with a ringed planet, for adventures beyond the sky",
    names: /\b(?:outer ?space|space|galax(?:y|ies)|planets?|cosmic|cosmos|astronaut)\b/i,
    topics: /\b(?:space|planets?|rockets?|astronauts?|aliens?|galax(?:y|ies)|comets?|spaceships?|orbits?|stars?|mars|saturn|moons?)\b|فضا|سیاره|موشک|فضانورد|کهکشان|ستاره/i,
    face: "rounded",
    card: { paddingMm: 14, radiusMm: 9 },
    ink: "#f3f0ff",
    headingInk: "var(--story-accent)",
    sheets: [
      { fill: "linear-gradient(160deg, #15153a, #2a1650)", accent: "#ffb36b" },
      { fill: "linear-gradient(160deg, #101b3d, #23245a)", accent: "#7ee0ff" },
      { fill: "linear-gradient(160deg, #1d1238, #3a1a55)", accent: "#ff8fc7" }
    ],
    shapes: [
      `radial-gradient(ellipse 17mm 3.6mm at 84% 13%, transparent 0 62%, ${mix(85)} 64% 74%, transparent 76%)`,
      dot(84, 13, 7, "var(--story-accent)"),
      dot(12, 88, 4.5, mix(55, "#a7b8ff")),
      ...stars("rgba(255, 255, 255, 0.8)")
    ],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("var(--story-accent)")};`
  },
  fairytale: {
    id: "fairytale",
    label: "Fairy tale",
    summary: "parchment pages in a gold frame with storybook lettering, once upon a time",
    names: /\b(?:fairy[- ]?tales?|once upon a time|parchment|royal|enchanted|old[- ]fashioned|vintage|classic storybook|golden)\b/i,
    topics: /\b(?:princess(?:es)?|princes?|castles?|dragons?|fair(?:y|ies)|kings?|queens?|knights?|wizards?|witch(?:es)?|unicorns?|kingdoms?|magic(?:al)?|spells?|enchanted|giants?|trolls?)\b|شاهزاده|قصر|قلعه|اژدها|پری|پادشاه|ملکه|جادو/i,
    face: "serif",
    displayHeadings: true,
    card: {
      paddingMm: 16,
      radiusMm: 4,
      borderMm: 1.4,
      extra: "border: 1.4mm double #b48a4a; box-shadow: inset 0 0 0 2.6mm var(--story-fill), inset 0 0 0 2.9mm #cfb07a;"
    },
    ink: "#2f2418",
    headingInk: "#7a2335",
    sheets: [
      { fill: "#fbf3e2", accent: "#b48a4a" },
      { fill: "#f8eedb", accent: "#a87b3a" }
    ],
    shapes: [dot(7, 5, 1.2, mix(70)), dot(93, 5, 1.2, mix(70)), dot(7, 95, 1.2, mix(70)), dot(93, 95, 1.2, mix(70))],
    ornament: `inline-size: 16mm; block-size: 3.2mm; background: ${dots("#7a2335")};`
  },
  classic: {
    id: "classic",
    label: "Classic",
    summary: "plain white pages in the book's own serif, with nothing but the words",
    names: /\b(?:classic|plain|simple|minimal(?:ist)?|clean|no colou?rs?|without colou?rs?|black and white|normal|ordinary)\b/i,
    topics: /(?!)/,
    face: "serif",
    ink: "#1a1a1a",
    headingInk: "#1a1a1a",
    sheets: [{ fill: "transparent", accent: "#8b6f4e" }],
    shapes: [],
    ornament:
      "inline-size: 28mm; block-size: 1px; background: linear-gradient(90deg, transparent, #c9b79f 18%, #8b6f4e 50%, #c9b79f 82%, transparent);"
  }
};

export function storyPageDesign(id: StoryPageDesignId): StoryPageDesign {
  return DESIGNS[id];
}

export function allStoryPageDesigns(): readonly StoryPageDesign[] {
  return STORY_PAGE_DESIGN_IDS.map((id) => DESIGNS[id]);
}

export function isStoryPageDesignId(value: unknown): value is StoryPageDesignId {
  return typeof value === "string" && (STORY_PAGE_DESIGN_IDS as readonly string[]).includes(value);
}

/**
 * The reader's explicit choice, read from the project row — never from a plan
 * version's frozen snapshot, or changing the design would need a replan.
 */
export function storyPageDesignPreference(mediaSettings: unknown): StoryPageDesignId | undefined {
  const candidate =
    mediaSettings && typeof mediaSettings === "object" && !Array.isArray(mediaSettings)
      ? (mediaSettings as Record<string, unknown>).storyPageDesign
      : undefined;
  return isStoryPageDesignId(candidate) ? candidate : undefined;
}

/** Words that make a request about how the pages *look*, not what they say. */
// Not a bare colour word: "change the colour of Mira's dress to blue" is the
// story's text, and read as a look-word it chose the sea.
const LOOK_CUE =
  "designs?|layouts?|looks?|looking|style[sd]?|themes?|themed|backgrounds?|colou?r ?schemes?|decorations?|decorated";
const WORD = "[\\p{L}\\p{N}'’-]+";
const GAP = "[^\\p{L}\\p{N}]+";

/** A design's name within a few words of a look-word, in either order. */
function namedNearLook(design: StoryPageDesign): RegExp {
  const names = design.names.source;
  return new RegExp(
    `\\b(?:${LOOK_CUE})\\b(?:${GAP}${WORD}){0,4}?${GAP}(?:${names})|(?:${names})(?:${GAP}${WORD}){0,2}?${GAP}(?:${LOOK_CUE})\\b`,
    "giu"
  );
}

/**
 * The design a request names: a design word next to a word about how the pages
 * look — "the night sky design", "a plain layout", "make the pages look like
 * the sea". A design word on its own is a subject ("a story about the sea"),
 * and "simple" or "dark" two clauses away from "pages" is not a choice of
 * anything, which is why the two have to sit within a few words.
 */
export function requestedStoryPageDesign(text: string): StoryPageDesignId | undefined {
  let best: { id: StoryPageDesignId; at: number } | undefined;
  for (const design of allStoryPageDesigns()) {
    // The design named last wins — "not the night one, the ocean design", or a
    // creation chat that settled on one design after trying another — so each
    // design is placed by its last mention, not its first.
    const last = [...text.matchAll(namedNearLook(design))].at(-1);
    if (last && (!best || last.index > best.at)) {
      best = { id: design.id, at: last.index };
    }
  }
  return best?.id;
}

/**
 * A children's book's design when nobody chose one: a design the request
 * names, else the one whose world the book's words are in (each topic word
 * counts, three at most per design, so one long word list cannot drown the
 * rest), else the pastel storybook. Deterministic, so both compiles — the
 * worker's and the API's inline rebuild — print the same book.
 */
export function chooseStoryPageDesign(text: string): StoryPageDesignId {
  const requested = requestedStoryPageDesign(text);
  if (requested) {
    return requested;
  }
  let best: { id: StoryPageDesignId; score: number } = { id: "storybook", score: 0 };
  for (const design of allStoryPageDesigns()) {
    const flags = design.topics.flags.includes("g") ? design.topics.flags : `${design.topics.flags}g`;
    const score = Math.min(3, [...text.matchAll(new RegExp(design.topics.source, flags))].length);
    if (score > best.score) {
      best = { id: design.id, score };
    }
  }
  return best.id;
}

/**
 * The design a book's story sheets are printed in: the reader's choice when
 * they made one, a children's book's own match when they did not, and nothing
 * — the plain sheet — for any other book. Both compiles call this with the
 * project row's settings and the book's own words, so they cannot disagree.
 */
export function storyPageDesignFor(book: {
  mediaSettings: unknown;
  category?: string | undefined;
  prompt?: string | undefined;
  plan?: {
    title?: string | null | undefined;
    subtitle?: string | null | undefined;
    premise?: string | null | undefined;
    audience?: string | null | undefined;
  } | undefined;
}): StoryPageDesignId | undefined {
  const chosen = storyPageDesignPreference(book.mediaSettings);
  if (chosen) {
    return chosen;
  }
  if (book.category !== "KIDS") {
    return undefined;
  }
  const plan = book.plan ?? {};
  return chooseStoryPageDesign(
    [book.prompt, plan.title, plan.subtitle, plan.premise, plan.audience].filter((part) => typeof part === "string" && part).join("\n")
  );
}

/**
 * What a compile records for a separate story layout: the design its caller
 * resolved, else a children's book's pastel storybook — the one a caller that
 * resolves nothing (a test, an old path) still gets.
 */
export function storyPageDesignField(input: {
  category?: string | undefined;
  storyPageDesign?: StoryPageDesignId | undefined;
}): { storyPageDesign?: StoryPageDesignId } {
  const design = input.storyPageDesign ?? (input.category === "KIDS" ? "storybook" : undefined);
  return design ? { storyPageDesign: design } : {};
}
