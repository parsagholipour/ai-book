import type { BookCategory } from "../categories.js";
import type { CoverTemplateId } from "../schemas/book.js";

/**
 * The bundled cover catalog: the artwork a book gets when it declines an AI
 * cover, and the artwork that rescues a cover whose image providers all failed.
 *
 * Each entry is data plus a motif; `coverDesignSvg` in `coverDesignArtwork.ts`
 * turns it into the text-free 1800x2400 artwork layer that `renderCoverPng`
 * typesets the real title and author over. `description` is the model's entire
 * basis for choosing, so write it as what the cover looks like followed by what
 * it suits — never as a list of keywords.
 */

export type CoverMotif =
  | "bands"
  | "wash"
  | "grain"
  | "arcs"
  | "rings"
  | "grid"
  | "swirl"
  | "horizon"
  | "silhouette"
  | "scatter"
  | "halftone"
  | "blocks"
  | "mesh"
  | "contours"
  | "thread";

/** Ground, mid and accent. Motifs read them positionally. */
export type CoverPalette = readonly [string, string, string];

export type CoverMotifOptions = {
  /** Motif-specific shape family. Unknown values fall back to the motif default. */
  variant?: string;
  /** Degrees, for motifs with a direction. */
  angle?: number;
  /** 0..1, roughly "how many marks". */
  density?: number;
  /** 0..1, roughly "how big each mark is". */
  scale?: number;
};

export type CoverDesign = {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  /** Typography family. A design cover uses this instead of `resolveCoverTemplate`. */
  template: Exclude<CoverTemplateId, "auto">;
  palette: CoverPalette;
  motif: CoverMotif;
  motifOptions?: CoverMotifOptions;
  /** Overrides the template accent when the palette needs its own. */
  accentColor?: string;
  /**
   * Overrides the template overlay. Light artwork needs a heavier scrim than
   * the templates assume, because every template sets light text.
   */
  overlayCss?: string;
  /**
   * A committed image under the worker's cover-design directory wins over the
   * generated SVG. Nothing ships with one; this is how a single design gets
   * upgraded to real art without touching any wiring.
   */
  artworkFile?: string;
};

const LIGHT_ARTWORK_OVERLAY =
  "linear-gradient(180deg, rgba(28, 24, 18, 0.34) 0%, rgba(28, 24, 18, 0.7) 52%, rgba(28, 24, 18, 0.5) 100%)";

export const COVER_DESIGNS: readonly CoverDesign[] = [
  // General — these carry no genre and should read well on almost any book.
  {
    id: "dusk-gradient",
    name: "Dusk Gradient",
    description:
      "A deep indigo sky melting down into warm amber at the horizon. Calm and open, with atmosphere instead of subject matter — a safe choice for almost any book.",
    tags: ["general", "calm", "warm", "gradient"],
    template: "minimal",
    palette: ["#161a3a", "#3b3f7a", "#f0a868"],
    motif: "wash",
    motifOptions: { variant: "vertical" }
  },
  {
    id: "ink-wash",
    name: "Ink Wash",
    description:
      "Charcoal washes bleeding across a pale ground, like brush-loaded ink on wet paper. Quiet and literary — essays, memoir and reflective nonfiction.",
    tags: ["general", "literary", "monochrome", "quiet"],
    template: "minimal",
    palette: ["#1c1c20", "#4a4a55", "#d9d4c8"],
    motif: "wash",
    motifOptions: { variant: "brush" }
  },
  {
    id: "paper-grain",
    name: "Paper Grain",
    description:
      "A single muted ochre field with visible paper tooth and a faint pressed edge. Understated and bookish; an unshowy default for nonfiction.",
    tags: ["general", "neutral", "texture", "understated"],
    template: "minimal",
    palette: ["#2f2a24", "#5c5145", "#cbb894"],
    motif: "grain"
  },
  {
    id: "linen-minimal",
    name: "Linen",
    description:
      "Off-white woven linen with one thin rule across the upper third. Bright, gallery-quiet and deliberately restrained.",
    tags: ["general", "light", "minimal", "clean"],
    template: "minimal",
    palette: ["#efe9dd", "#d8cebc", "#8a7f6b"],
    motif: "grain",
    motifOptions: { variant: "linen" },
    overlayCss: LIGHT_ARTWORK_OVERLAY
  },
  {
    id: "bold-diagonal",
    name: "Bold Diagonal",
    description:
      "Two saturated fields split by one hard diagonal edge. Graphic and confident — manifestos, guides and anything making an argument.",
    tags: ["general", "bold", "graphic", "modern"],
    template: "business",
    palette: ["#10233a", "#1f6f8b", "#ffd166"],
    motif: "bands",
    motifOptions: { variant: "diagonal", angle: 28 }
  },
  {
    id: "soft-arches",
    name: "Soft Arches",
    description:
      "Overlapping semicircles rising from the lower edge in tonal steps. Gentle and architectural — guides, habit books and warm nonfiction.",
    tags: ["general", "calm", "geometric", "warm"],
    template: "self-help",
    palette: ["#2b1f2e", "#6b4a63", "#e8a598"],
    motif: "arcs"
  },
  {
    id: "concentric-rings",
    name: "Concentric Rings",
    description:
      "Thin rings expanding from one off-centre point over a dark ground. Focused and precise; reads as an idea radiating outward.",
    tags: ["general", "geometric", "precise", "dark"],
    template: "science",
    palette: ["#08131f", "#12496b", "#79e0d8"],
    motif: "rings"
  },
  {
    id: "ruled-grid",
    name: "Ruled Grid",
    description:
      "An even lattice of hairlines over deep slate, brightening toward one corner. Orderly and technical without being cold.",
    tags: ["general", "technical", "orderly", "dark"],
    template: "science",
    palette: ["#0c1418", "#20343d", "#8fd3c1"],
    motif: "grid"
  },
  {
    id: "duotone-fade",
    name: "Duotone Fade",
    description:
      "One colour dissolving into another through a soft dither, with no hard edge anywhere. Modern and neutral; carries long titles well.",
    tags: ["general", "modern", "gradient", "neutral"],
    template: "minimal",
    palette: ["#241b38", "#4f3a73", "#ef8f6d"],
    motif: "wash",
    motifOptions: { variant: "duotone" }
  },
  {
    id: "marble-swirl",
    name: "Marble Swirl",
    description:
      "Slow marbled currents of two inks folding into each other. Rich and tactile — essays, poetry and literary nonfiction.",
    tags: ["general", "literary", "texture", "rich"],
    template: "fiction",
    palette: ["#16202e", "#2f4d63", "#c9a227"],
    motif: "swirl"
  },
  {
    id: "sunrise-bands",
    name: "Sunrise Bands",
    description:
      "Horizontal bands stepping from deep plum up to pale gold. Optimistic and simple — self-help, memoir and books about beginnings.",
    tags: ["general", "warm", "optimistic", "bands"],
    template: "self-help",
    palette: ["#2c1934", "#a4506a", "#f6c177"],
    motif: "bands",
    motifOptions: { variant: "horizontal" }
  },
  {
    id: "night-field",
    name: "Night Field",
    description:
      "A dense field of small dots thinning toward the top of a near-black ground. Quiet, spacious and faintly cosmic.",
    tags: ["general", "dark", "quiet", "texture"],
    template: "minimal",
    palette: ["#07080f", "#1b1f33", "#c8cbe0"],
    motif: "halftone"
  },
  {
    id: "stacked-shapes",
    name: "Stacked Shapes",
    description:
      "Flat rectangles stacked at slight offsets, like a pile of paper seen head-on. Clean and editorial.",
    tags: ["general", "editorial", "geometric", "modern"],
    template: "business",
    palette: ["#151a2b", "#33507d", "#9ec5ff"],
    motif: "blocks"
  },
  {
    id: "wide-horizon",
    name: "Wide Horizon",
    description:
      "A single low horizon under a very large sky with no landmark in it. Open and unhurried — travel, memoir and reflective writing.",
    tags: ["general", "calm", "open", "landscape"],
    template: "fiction",
    palette: ["#131c2b", "#3a5570", "#e2b06a"],
    motif: "horizon",
    motifOptions: { variant: "empty" }
  },
  {
    id: "halftone-dots",
    name: "Halftone",
    description:
      "A printed halftone gradient of large dots shrinking across the page. Retro-print and a little playful.",
    tags: ["general", "retro", "print", "graphic"],
    template: "business",
    palette: ["#1b1233", "#5b3fa8", "#ffcf56"],
    motif: "halftone",
    motifOptions: { variant: "coarse" }
  },
  {
    id: "warm-canvas",
    name: "Warm Canvas",
    description:
      "Bare primed canvas in a warm sand tone with a faint brushed edge. Handmade and quiet — craft, cooking and slow-living books.",
    tags: ["general", "light", "texture", "handmade"],
    template: "self-help",
    palette: ["#e8dcc6", "#cbb392", "#7a6349"],
    motif: "grain",
    motifOptions: { variant: "canvas" },
    overlayCss: LIGHT_ARTWORK_OVERLAY
  },
  {
    id: "midnight-mesh",
    name: "Midnight Mesh",
    description:
      "Blurred colour blobs bleeding into one another across a midnight ground. Contemporary and a little synthetic.",
    tags: ["general", "modern", "dark", "gradient"],
    template: "minimal",
    palette: ["#0a0a1a", "#3d2a7a", "#2fb8c4"],
    motif: "mesh"
  },
  {
    id: "terrazzo",
    name: "Terrazzo",
    description:
      "Small irregular chips scattered evenly over a deep ground, like polished terrazzo. Cheerful and textural.",
    tags: ["general", "playful", "texture", "pattern"],
    template: "minimal",
    palette: ["#1d2a2a", "#3f5c56", "#f0b7a4"],
    motif: "scatter",
    motifOptions: { variant: "chips" }
  },

  // Story and literary.
  {
    id: "moonlit-sea",
    name: "Moonlit Sea",
    description:
      "A pale moon low over dark water, its light broken into a long ripple. Wistful and still — novels, memoir and literary fiction.",
    tags: ["story", "literary", "night", "calm"],
    template: "fiction",
    palette: ["#0a1626", "#1d3b56", "#e8d9a8"],
    motif: "horizon",
    motifOptions: { variant: "orb" }
  },
  {
    id: "lantern-path",
    name: "Lantern Path",
    description:
      "One warm lantern glow at the end of a dark corridor of trees. Journeys, quests and coming-of-age stories.",
    tags: ["story", "journey", "warm", "night"],
    template: "fiction",
    palette: ["#0e1410", "#243528", "#f2b757"],
    motif: "silhouette",
    motifOptions: { variant: "lantern" }
  },
  {
    id: "distant-tower",
    name: "Distant Tower",
    description:
      "A silhouetted tower on a far ridge under a bruised sky. Fantasy, adventure and any story with a destination in it.",
    tags: ["story", "fantasy", "adventure", "dramatic"],
    template: "fiction",
    palette: ["#141026", "#3a2a52", "#e0864f"],
    motif: "silhouette",
    motifOptions: { variant: "tower" }
  },
  {
    id: "open-road",
    name: "Open Road",
    description:
      "An empty road narrowing to a vanishing point under a wide evening sky. Road novels, memoir and books about leaving.",
    tags: ["story", "journey", "open", "warm"],
    template: "fiction",
    palette: ["#1a1522", "#4a3a4f", "#f0a55e"],
    motif: "silhouette",
    motifOptions: { variant: "road" }
  },
  {
    id: "forest-silhouette",
    name: "Forest Edge",
    description:
      "A ragged treeline cut black against a cold glowing sky. Folk tales, outdoor mysteries and quiet horror.",
    tags: ["story", "nature", "moody", "dark"],
    template: "fiction",
    palette: ["#0b1418", "#1c3138", "#9fd0c4"],
    motif: "silhouette",
    motifOptions: { variant: "forest" }
  },
  {
    id: "storm-front",
    name: "Storm Front",
    description:
      "Heavy cloud tearing across a narrow band of light at the horizon. Thrillers, survival stories and books with weather in them.",
    tags: ["story", "dramatic", "dark", "weather"],
    template: "fiction",
    palette: ["#101418", "#2b3846", "#d7c9a8"],
    motif: "swirl",
    motifOptions: { variant: "cloud" }
  },
  {
    id: "city-rain",
    name: "City Rain",
    description:
      "Blurred window light in vertical streaks, a city dissolved by rain. Urban fiction, noir and modern love stories.",
    tags: ["story", "urban", "moody", "night"],
    template: "fiction",
    palette: ["#0d1117", "#243447", "#f0c987"],
    motif: "silhouette",
    motifOptions: { variant: "city" }
  },

  // Kids.
  {
    id: "crayon-meadow",
    name: "Crayon Meadow",
    description:
      "Loose waxy strokes of green and yellow with flower dots scattered through them. Picture books and early readers.",
    tags: ["kids", "playful", "bright", "nature"],
    template: "kids",
    palette: ["#1f4d2e", "#4c8c3f", "#ffd95c"],
    motif: "scatter",
    motifOptions: { variant: "petals", density: 0.8 }
  },
  {
    id: "balloon-sky",
    name: "Balloon Sky",
    description:
      "Round balloons drifting up a soft blue gradient on long strings. Cheerful and gentle for young children.",
    tags: ["kids", "cheerful", "bright", "sky"],
    template: "kids",
    palette: ["#17456b", "#3d86bd", "#ff9f68"],
    motif: "scatter",
    motifOptions: { variant: "balloons" }
  },
  {
    id: "friendly-stars",
    name: "Friendly Stars",
    description:
      "Fat rounded stars of different sizes over a deep friendly blue. Bedtime books and gentle adventures.",
    tags: ["kids", "night", "gentle", "stars"],
    template: "kids",
    palette: ["#141b47", "#2c3a86", "#ffd67a"],
    motif: "scatter",
    motifOptions: { variant: "stars" }
  },
  {
    id: "bedtime-moon",
    name: "Bedtime Moon",
    description:
      "A big soft moon low in a violet sky with a sleeping hill beneath it. Made for bedtime stories.",
    tags: ["kids", "night", "calm", "bedtime"],
    template: "kids",
    palette: ["#1a1440", "#3b2f73", "#ffe2a8"],
    motif: "horizon",
    motifOptions: { variant: "moon" }
  },
  {
    id: "playful-blocks",
    name: "Playful Blocks",
    description:
      "Bright rectangles tumbled at odd angles like spilled toy bricks. Counting books, first concepts and anything loud and happy.",
    tags: ["kids", "playful", "bright", "geometric"],
    template: "kids",
    palette: ["#1c2a52", "#e2574c", "#ffc93c"],
    motif: "blocks",
    motifOptions: { variant: "tumbled" }
  },

  // Science fiction and speculative.
  {
    id: "orbit-lines",
    name: "Orbit Lines",
    description:
      "Thin elliptical orbits crossing a black field around one bright point. Science fiction, space writing and systems thinking.",
    tags: ["scifi", "space", "technical", "dark"],
    template: "science",
    palette: ["#03060f", "#123a5c", "#6fe3ff"],
    motif: "rings",
    motifOptions: { variant: "elliptical" }
  },
  {
    id: "deep-space",
    name: "Deep Space",
    description:
      "A dust-lit nebula bleeding across a starfield. Space opera, astronomy and far-future stories.",
    tags: ["scifi", "space", "dramatic", "dark"],
    template: "science",
    palette: ["#050310", "#3a1f6b", "#63d6ff"],
    motif: "mesh",
    motifOptions: { variant: "nebula" }
  },
  {
    id: "circuit-bloom",
    name: "Circuit Bloom",
    description:
      "Fine branching traces spreading from a corner like circuitry growing. Artificial intelligence, technology and near-future fiction.",
    tags: ["scifi", "technology", "technical", "dark"],
    template: "science",
    palette: ["#04120f", "#0f4a3d", "#5ef2b0"],
    motif: "swirl",
    motifOptions: { variant: "circuit" }
  },

  // Mystery and thriller.
  {
    id: "doorway-light",
    name: "Doorway",
    description:
      "One slab of light falling from a half-open door into a dark room. Mysteries, thrillers and secrets.",
    tags: ["mystery", "dark", "tense", "dramatic"],
    template: "fiction",
    palette: ["#0b0b0e", "#20222b", "#e6c88a"],
    motif: "silhouette",
    motifOptions: { variant: "doorway" }
  },
  {
    id: "fog-street",
    name: "Fog Street",
    description:
      "A lamp-post fading into heavy fog with everything else gone. Detective fiction and cold cases.",
    tags: ["mystery", "noir", "moody", "fog"],
    template: "fiction",
    palette: ["#12151a", "#2e3742", "#cfd8e0"],
    motif: "silhouette",
    motifOptions: { variant: "lamp" }
  },
  {
    id: "red-thread",
    name: "Red Thread",
    description:
      "One red line tracing a long crooked path across a near-black ground. Investigations, conspiracies and connected clues.",
    tags: ["mystery", "tense", "graphic", "dark"],
    template: "fiction",
    palette: ["#0d0d10", "#26262d", "#d33f3f"],
    motif: "thread"
  },

  // Romance.
  {
    id: "petal-fall",
    name: "Petal Fall",
    description:
      "Soft petals drifting across a dusk-rose gradient. Romance, love stories and tender memoir.",
    tags: ["romance", "soft", "warm", "floral"],
    template: "romance",
    palette: ["#2a1420", "#7a3450", "#f7b7c2"],
    motif: "scatter",
    motifOptions: { variant: "petals" }
  },
  {
    id: "soft-blush",
    name: "Soft Blush",
    description:
      "A quiet blush-to-plum wash with no hard edge anywhere. Understated romance and essays about love.",
    tags: ["romance", "soft", "gradient", "quiet"],
    template: "romance",
    palette: ["#2b1622", "#8a4560", "#f4c9cf"],
    motif: "wash",
    motifOptions: { variant: "radial" }
  },
  {
    id: "paired-curves",
    name: "Paired Curves",
    description:
      "Two long curves leaning toward each other without quite meeting. Modern romance and books about relationships.",
    tags: ["romance", "modern", "geometric", "warm"],
    template: "romance",
    palette: ["#241627", "#6d3355", "#f0a0ae"],
    motif: "arcs",
    motifOptions: { variant: "paired" }
  },

  // Business.
  {
    id: "ascending-bars",
    name: "Ascending Bars",
    description:
      "A row of flat bars climbing left to right against deep teal. Growth, strategy and business how-to.",
    tags: ["business", "growth", "graphic", "confident"],
    template: "business",
    palette: ["#08222a", "#125560", "#7bdcb5"],
    motif: "blocks",
    motifOptions: { variant: "ascending" }
  },
  {
    id: "boardroom-navy",
    name: "Boardroom Navy",
    description:
      "Sober navy panels with a single brass rule across them. Leadership, finance and anything that should look expensive.",
    tags: ["business", "formal", "dark", "premium"],
    template: "business",
    palette: ["#0b1626", "#1b2d4a", "#c9a227"],
    motif: "blocks",
    motifOptions: { variant: "panels" }
  },
  {
    id: "arrow-north",
    name: "Arrow North",
    description:
      "One clean arrow driving up out of a dark field. Playbooks, lead magnets and direct business advice.",
    tags: ["business", "direct", "graphic", "bold"],
    template: "business",
    palette: ["#0d1f1c", "#155e4b", "#ffd166"],
    motif: "silhouette",
    motifOptions: { variant: "arrow" }
  },

  // Self-help and mindfulness.
  {
    id: "open-window",
    name: "Open Window",
    description:
      "Light falling through an open window frame onto a plain wall. Change, recovery and books about starting again.",
    tags: ["selfhelp", "hopeful", "calm", "light"],
    template: "self-help",
    palette: ["#241d1a", "#5d4a3c", "#f3d3a0"],
    motif: "silhouette",
    motifOptions: { variant: "window" }
  },
  {
    id: "stepping-stones",
    name: "Stepping Stones",
    description:
      "Flat stones set in still water, spaced out across the page. Habit books, method books and step-by-step guides.",
    tags: ["selfhelp", "method", "calm", "water"],
    template: "self-help",
    palette: ["#1b2a2e", "#3f6560", "#e6c9a0"],
    motif: "blocks",
    motifOptions: { variant: "stones" }
  },
  {
    id: "calm-tide",
    name: "Calm Tide",
    description:
      "Long shallow curves of tide sliding over pale sand. Mindfulness, anxiety and slow-living books.",
    tags: ["selfhelp", "calm", "soft", "water"],
    template: "self-help",
    palette: ["#1e2f38", "#4b7d84", "#f0dcc0"],
    motif: "arcs",
    motifOptions: { variant: "tide" }
  },
  {
    id: "quiet-sunrise",
    name: "Quiet Sunrise",
    description:
      "A low sun just clearing the horizon in soft banded light. Morning habits, recovery and gentle encouragement.",
    tags: ["selfhelp", "hopeful", "warm", "sunrise"],
    template: "self-help",
    palette: ["#2a1c2c", "#7c4a52", "#f4b860"],
    motif: "horizon",
    motifOptions: { variant: "sun" }
  },

  // Science and how-to.
  {
    id: "molecule-field",
    name: "Molecule Field",
    description:
      "Linked nodes drifting across a dark ground like a molecular diagram. Science writing, biology and explainers.",
    tags: ["science", "technical", "dark", "diagram"],
    template: "science",
    palette: ["#061219", "#0f4257", "#68d9e0"],
    motif: "scatter",
    motifOptions: { variant: "nodes" }
  },
  {
    id: "measured-grid",
    name: "Measured Grid",
    description:
      "A precise grid with ruled tick marks along two edges, like graph paper. Textbooks, workbooks and technical how-to.",
    tags: ["science", "technical", "orderly", "education"],
    template: "science",
    palette: ["#0a1622", "#1d3b52", "#9fd8e8"],
    motif: "grid",
    motifOptions: { variant: "measured" }
  },

  // Lifestyle, history and travel.
  {
    id: "table-linen",
    name: "Table Linen",
    description:
      "Woven cloth in warm oatmeal with a single folded shadow across it. Cookbooks, hosting and books about home.",
    tags: ["lifestyle", "warm", "texture", "home"],
    template: "self-help",
    palette: ["#3a2f24", "#786347", "#e9d3ae"],
    motif: "grain",
    motifOptions: { variant: "cloth" }
  },
  {
    id: "aged-atlas",
    name: "Aged Atlas",
    description:
      "Contour lines from an old survey map printed in faded sepia. History, travel and books about places.",
    tags: ["history", "travel", "texture", "vintage"],
    template: "minimal",
    palette: ["#231a12", "#5a4229", "#d6b681"],
    motif: "contours"
  }
] as const;

export const COVER_DESIGN_IDS: readonly string[] = COVER_DESIGNS.map((design) => design.id);

const COVER_DESIGNS_BY_ID = new Map(COVER_DESIGNS.map((design) => [design.id, design]));

/** The design every lookup falls back to. Deliberately the most neutral entry. */
export const DEFAULT_COVER_DESIGN_ID = "dusk-gradient";

/**
 * Purpose tag for the selection call. It lives here rather than beside the call
 * so the mock text adapter can answer it without importing the selector.
 */
export const COVER_DESIGN_SELECTION_PURPOSE = "select-cover-design";

export function coverDesign(id: string): CoverDesign | undefined {
  return COVER_DESIGNS_BY_ID.get(id);
}

export function defaultCoverDesign(): CoverDesign {
  const design = COVER_DESIGNS_BY_ID.get(DEFAULT_COVER_DESIGN_ID);
  if (!design) {
    throw new Error(`Missing default cover design: ${DEFAULT_COVER_DESIGN_ID}`);
  }
  return design;
}

/** `id — Name — description (tags)` lines, which is how the catalog is shown to the model. */
export function coverDesignCatalogLines(): string {
  return COVER_DESIGNS.map(
    (design) => `${design.id} — ${design.name} — ${design.description} (${design.tags.join(", ")})`
  ).join("\n");
}

const CATEGORY_TAGS: Record<BookCategory, readonly string[]> = {
  KIDS: ["kids"],
  SCIENCE: ["science"],
  STORY: ["story"],
  EDUCATION: ["science", "education"],
  BUSINESS: ["business"],
  SELF_HELP: ["selfhelp"],
  HEALTH: ["selfhelp", "science"],
  BIOGRAPHY: ["story", "literary"],
  HISTORY: ["history"],
  SOCIETY: ["general", "editorial"],
  ARTS: ["general", "literary"],
  CUSTOM: ["general"]
};

/**
 * Subcategory words that pull toward a genre the category alone cannot express —
 * STORY covers romance, mystery and science fiction alike.
 */
const SUBCATEGORY_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/romance|love|relationship/, "romance"],
  [/mystery|thriller|crime|detective|suspense|noir/, "mystery"],
  [/sci-?fi|science fiction|space|futur|dystop|cyber/, "scifi"],
  [/fantasy|myth|magic|fairy/, "fantasy"],
  [/business|market|startup|entrepreneur|finance|leader/, "business"],
  [/self-?help|habit|mindful|wellbeing|productivity|motivat/, "selfhelp"],
  [/child|kid|toddler|picture book|bedtime/, "kids"],
  [/history|historical|ancient|war/, "history"],
  [/travel|journey|road|atlas|place/, "travel"],
  [/cook|recipe|food|kitchen|home/, "lifestyle"],
  [/tech|comput|software|ai|robot|engineer/, "technology"],
  [/nature|outdoor|wild|garden/, "nature"],
  [/poem|poetry|essay|literary|memoir/, "literary"]
];

export type CoverDesignContext = {
  category: BookCategory;
  subcategory?: string | null | undefined;
  /** Free text — title, premise, audience. Only used to break ties. */
  hints?: string | null | undefined;
};

/** The tags a book should be matched against, most specific first. */
export function coverDesignTagsForContext(context: CoverDesignContext): string[] {
  const haystack = `${context.subcategory ?? ""} ${context.hints ?? ""}`.toLowerCase();
  const subcategoryTags = SUBCATEGORY_TAGS.filter(([pattern]) => pattern.test(haystack)).map(([, tag]) => tag);
  return [...new Set([...subcategoryTags, ...CATEGORY_TAGS[context.category]])];
}

/**
 * The model-free pick. It answers whenever the selection call fails or returns
 * an id that is not in the catalog, and this path runs at the very end of a
 * paid book, so it must always return something.
 *
 * Scoring is deliberately blunt — genre tags first, then general as a floor —
 * and the seed breaks ties, so two books in the same genre do not share a cover.
 */
export function fallbackCoverDesign(context: CoverDesignContext & { seed: string }): CoverDesign {
  const wanted = coverDesignTagsForContext(context);
  const scored = COVER_DESIGNS.map((design) => {
    let score = 0;
    for (const [index, tag] of wanted.entries()) {
      if (design.tags.includes(tag)) {
        // Weighted so any genre hit outranks the general floor below, and an
        // earlier (more specific) tag outranks a later one.
        score += (wanted.length - index) * 10;
      }
    }
    if (score === 0 && design.tags.includes("general")) {
      score = 1;
    }
    return { design, score };
  }).filter((entry) => entry.score > 0);

  const best = scored.reduce((highest, entry) => Math.max(highest, entry.score), 0);
  const candidates = scored.filter((entry) => entry.score === best).map((entry) => entry.design);
  return candidates[hashSeed(context.seed) % candidates.length] ?? defaultCoverDesign();
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}
