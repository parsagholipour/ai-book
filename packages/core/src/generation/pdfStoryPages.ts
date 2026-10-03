import { chapterAnchorMarkup, type CompiledBookMarkdown, type PageAnchorPlan } from "./markdown.js";
import { isAuthorManuscript, studioLayoutFromMediaSettings, type CreateProjectInput } from "../schemas/book.js";
import { requestedGenerationPages } from "./pageCountAllowance.js";
import { allStoryPageDesigns, storyPageDesign, type StoryPageDesign, type StoryPageDesignId } from "./storyPageDesigns.js";

export type StoryPagePlan = Pick<CompiledBookMarkdown, "pageAnchors" | "sourcesOffset" | "storyPageLayout" | "storyPageDesign">;

type StoryLayoutInput = Pick<CreateProjectInput, "category" | "targetPages"> & { mediaSettings: unknown };
type StoryLayoutPage = { index: number; markdown: string };

/**
 * The story layout a book is typeset in — the one both compiles (the worker's
 * and the API's inline rebuild) must ask, so the two cannot disagree.
 *
 * An author's book never takes the generated rule: its page count and its
 * category are the author's, not a picture-book plan's. It gets separate story
 * pages only when it was written in the Studio's picture layout, where a page
 * is a unit the author made on purpose — picture on top, text below — and one
 * printed sheet per page is what they composed. A flow book's pages are where
 * the typesetter cut, and printing each on its own sheet would scatter prose.
 */
export function storyPageLayoutFor(input: StoryLayoutInput, pages: readonly StoryLayoutPage[]): "separate" | undefined {
  return isAuthorManuscript(input.mediaSettings)
    ? studioPictureStoryPageLayout(input.mediaSettings, pages)
    : shortKidsStoryPageLayout(input, pages);
}

/**
 * A Studio picture book: one sheet per page, at any length — a one-page book
 * is a cover and a sheet — and in any category, because the author chose the
 * layout, not the planner. Only the shape `splitStoryPageMarkdown` can cut is
 * required: pages 1..n, contiguous, none empty. Anything else (a chat edit that
 * left a gap, a page emptied by hand) falls back to flowing prose rather than
 * failing the render.
 */
export function studioPictureStoryPageLayout(mediaSettings: unknown, pages: readonly StoryLayoutPage[]): "separate" | undefined {
  return studioLayoutFromMediaSettings(mediaSettings) === "picture" && contiguousStoryPages(pages) ? "separate" : undefined;
}

/** Scene pagination is independent of image frequency and model-review switches. */
export function shortKidsStoryPageLayout(input: StoryLayoutInput, pages: readonly StoryLayoutPage[]): "separate" | undefined {
  return input.category === "KIDS" && requestedGenerationPages(input) >= 5 && requestedGenerationPages(input) <= 40 &&
    !isAuthorManuscript(input.mediaSettings) && pages.length === input.targetPages && contiguousStoryPages(pages)
    ? "separate" : undefined;
}

function contiguousStoryPages(pages: readonly StoryLayoutPage[]): boolean {
  return pages.length > 0 && pages.every((page, index) => page.index === index + 1 && page.markdown.trim().length > 0);
}

/** Exact source slices shared by PDF, Word and EPUB; no title/paragraph guessing. */
export function splitStoryPageMarkdown(markdown: string, plan: StoryPagePlan): {
  frontmatter: string;
  scenes: Array<{ index: number; markdown: string; offset: number; anchor: PageAnchorPlan }>;
  backmatter?: string;
} | undefined {
  if (plan.storyPageLayout !== "separate") return undefined;
  const pages = plan.pageAnchors.map((anchor) => ({ anchor, offset: anchor.existingIdOffset ?? anchor.markdownOffset }));
  if (!pages.length || pages.some(({ anchor, offset }, i) => offset === undefined || !Number.isSafeInteger(offset) ||
    offset < 0 || offset >= markdown.length || (offset > 0 && markdown[offset - 1] !== "\n") ||
    (i > 0 && offset <= (pages[i - 1]!.offset ?? Infinity)) ||
    (anchor.existingIdOffset !== undefined && !markdown.startsWith(chapterAnchorMarkup(anchor.destName), offset)))) {
    throw new Error("Separate story pages require current, ordered compiled page boundaries");
  }
  const end = plan.sourcesOffset ?? markdown.length;
  if (!Number.isSafeInteger(end) || end <= pages.at(-1)!.offset! || end > markdown.length) {
    throw new Error("Separate story pages require a valid back matter boundary");
  }
  return { frontmatter: markdown.slice(0, pages[0]!.offset!),
    scenes: pages.map(({ anchor, offset }, index) => ({ index: anchor.pageIndex, anchor, offset: offset!,
      markdown: markdown.slice(offset!, pages[index + 1]?.offset ?? end) })),
    ...(plan.sourcesOffset !== undefined ? { backmatter: markdown.slice(end) } : {}) };
}

// Inspect rendered content so reference-style Markdown images and generated
// figures count too. A cover is not a scene illustration. A book whose scenes
// carry figures, tables or code keeps the house layout throughout.
const TEXT_STORY = "body:has(.pdf-story-scene):not(:has(.pdf-story-scene :is(img, svg, figure, table, pre)))";
/**
 * A picture book: some scenes carry an illustration and none anything richer.
 * It used to keep the house layout too, so its text-only sheets printed two
 * lines of 11pt at the top of a blank page and the words under each picture
 * were set for an adult reader, in a 4-year-old's bedtime book (2026-10-02).
 * Its text-only scenes are now sized and centred like a text-only book's, and
 * a picture scene sets its words under a capped picture at the size the space
 * left allows. The designs stay a text-only book's: a coloured card on two
 * sheets of six beside full-colour pictures reads as a mistake.
 */
const PICTURE_STORY =
  "body:has(.pdf-story-scene img):not(:has(.pdf-story-scene :is(svg, figure, table, pre)))";
/** The tallest a scene's picture prints, and the gap under it. */
const PICTURE_MAX_MM = 125;
const PICTURE_GAP_MM = 6;
/** A scene's own picture in its Markdown: inline image syntax or an `<img>`. */
const SCENE_PICTURE = /!\[[^\]]*\][([]|<img\b/i;

type StorySceneTier = { name: StorySceneLength; fontPt: number; lineHeight: number; measureMm: number };
export type StorySceneLength = "brief" | "short" | "medium" | "long" | "full";

/**
 * The sizes a text-only scene can be set at, largest first. The stylesheet is
 * generated from this table and `storySceneLength` measures against it, so the
 * size a scene is given and the size it is checked at cannot drift apart.
 */
const STORY_SCENE_TIERS: readonly StorySceneTier[] = [
  { name: "brief", fontPt: 26, lineHeight: 1.5, measureMm: 132 },
  { name: "short", fontPt: 22, lineHeight: 1.5, measureMm: 132 },
  { name: "medium", fontPt: 18, lineHeight: 1.55, measureMm: 140 },
  { name: "long", fontPt: 15, lineHeight: 1.55, measureMm: 150 },
  { name: "full", fontPt: 12.5, lineHeight: 1.55, measureMm: 150 }
];
const PARAGRAPH_GAP_EM = 0.6;
const HEADING_GAP_EM = 0.9;
const ORNAMENT_GAP_EM = 0.6;
/** A4's 297mm less the 20mm and 22mm `@page` margins (`pdfCss.ts`). */
const SHEET_WRITING_HEIGHT_PT = ((297 - 20 - 22) / 25.4) * 72;
/** What an estimate may claim of the sheet: wrapping is guessed, so the rest is slack. */
const SHEET_FILL_LIMIT = 0.86;
const PT_PER_MM = 72 / 25.4;
/** How much wider than the serif the table was measured on a face sets a line. */
const FACE_WIDTH = { rounded: 1.07, serif: 1 } as const;
/** Playfair Display's chapter titles, against the same serif. */
const DISPLAY_HEADING_WIDTH = 1.15;

/** What a design's card takes off the top and bottom of the writing area. */
function cardBlockMm(design: StoryPageDesign | undefined): number {
  return design?.card ? design.card.paddingMm + (design.card.borderMm ?? 0) : 0;
}

/**
 * Width of `text` in ems at the body face: a whole em for a CJK ideograph,
 * kana, Hangul or full-width form, a quarter for a space, half for anything else.
 */
function textEms(text: string): number {
  let ems = 0;
  for (const character of text) {
    ems += /\s/u.test(character)
      ? 0.28
      : /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(character) ? 1 : 0.5;
  }
  return ems;
}

/** Height in points of `blocks` at `tier`, each block wrapped on its own lines. */
function blocksHeightPt(blocks: readonly string[], fontPt: number, lineHeight: number, measureMm: number, widthFactor = 1): number {
  const emsPerLine = ((measureMm * PT_PER_MM) / fontPt) * 0.92;
  return blocks.reduce((height, block) => {
    const lines = Math.max(1, Math.ceil((textEms(block) * widthFactor) / emsPerLine));
    return height + lines * fontPt * lineHeight;
  }, 0);
}

/**
 * The size a text-only scene is set at: the largest whose estimated height
 * fits one sheet — a picture book's 40 words at 26pt, a fuller page smaller —
 * so only a scene too long for every size spills onto a second sheet.
 *
 * The estimate is per paragraph because a page of short dialogue lines costs
 * far more height than its characters: every line of it ends early and every
 * break adds a gap. Counting characters alone sent a six-line exchange to two
 * sheets. Headings, anchors and markup are read the way they print — the
 * heading on lines of its own, the rest not at all.
 */
export function storySceneLength(
  markdown: string,
  designId?: StoryPageDesignId,
  options: { picture?: boolean } = {}
): StorySceneLength {
  const design = designId ? storyPageDesign(designId) : undefined;
  const face = FACE_WIDTH[design?.face ?? "serif"];
  const headingFace = design?.displayHeadings ? DISPLAY_HEADING_WIDTH : face;
  const writingHeightPt =
    SHEET_WRITING_HEIGHT_PT -
    2 * cardBlockMm(design) * PT_PER_MM -
    (options.picture ? (PICTURE_MAX_MM + PICTURE_GAP_MM) * PT_PER_MM : 0);
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.replace(/<[^>]+>/g, " ").replace(/!\[[^\]]*]\([^)]*\)/g, " ").trim())
    .filter((block) => block.replace(/[*_`>#|\s-]/g, "").length > 0);
  const headings = blocks.filter((block) => /^#{1,6}\s/.test(block)).map((block) => block.replace(/^#{1,6}\s+/, ""));
  const paragraphs = blocks.filter((block) => !/^#{1,6}\s/.test(block)).map((block) => block.replace(/[*_`]+/g, ""));
  for (const tier of STORY_SCENE_TIERS) {
    const headingPt = Math.max(tier.fontPt, 15);
    const height =
      blocksHeightPt(headings, headingPt, 1.3, tier.measureMm, 1.1 * headingFace) +
      headings.length * HEADING_GAP_EM * headingPt +
      blocksHeightPt(paragraphs, tier.fontPt, tier.lineHeight, tier.measureMm, face) +
      Math.max(0, paragraphs.length - 1) * PARAGRAPH_GAP_EM * tier.fontPt +
      ORNAMENT_GAP_EM * tier.fontPt;
    if (height <= writingHeightPt * SHEET_FILL_LIMIT) {
      return tier.name;
    }
  }
  return "full";
}

const STORY_SCENE_TIER_CSS = STORY_SCENE_TIERS.map(
  (tier) =>
    `.pdf-story-scene--${tier.name} { font-size: ${tier.fontPt}pt; line-height: ${tier.lineHeight}; --story-measure: ${tier.measureMm}mm; }`
);

const FACE_FAMILY = {
  rounded: `"StoryRoundBook", "InterBook", "Segoe UI", system-ui, sans-serif`,
  serif: `"SourceSerifBook", Georgia, "Times New Roman", serif`
} as const;
const DISPLAY_FAMILY = `"StoryDisplayBook", "SourceSerifBook", Georgia, serif`;

/**
 * One design's rules, scoped to its class so every design can ship in one
 * stylesheet. A design with a card fills the writing area with it — the card's
 * `min-block-size` is its border box — which is why `storySceneLength` takes
 * the card's padding off the sheet before it chooses a size. The sheet colours
 * cycle by `pdf-story-scene--sheet-N`, set from the scene's position.
 */
function designCss(design: StoryPageDesign): string {
  const scope = `${TEXT_STORY} .pdf-story-scene--design-${design.id}`;
  const card = design.card;
  const rules = [
    ...design.sheets.map(
      (sheet, index) => `${scope}.pdf-story-scene--sheet-${index} { --story-fill: ${sheet.fill}; --story-accent: ${sheet.accent}; }`
    ),
    `${scope} {
    font-family: ${FACE_FAMILY[design.face]};
    color: ${design.ink};${card ? `
    box-sizing: border-box;
    max-inline-size: none;
    padding: ${card.paddingMm}mm max(12mm, calc((100% - var(--story-measure)) / 2));
    border-radius: ${card.radiusMm}mm;
    background: ${[...design.shapes, "var(--story-fill)"].join(", ")};${card.extra ? `
    ${card.extra}` : ""}` : ""}
  }`,
    `${scope} :is(h2, h3, p, li, blockquote) { font-family: inherit; }`,
    `${scope} h2 { font-weight: ${design.face === "rounded" ? 800 : 700}; color: ${design.headingInk};${design.displayHeadings ? ` font-family: ${DISPLAY_FAMILY};` : ""} }`,
    `${scope}::after { ${design.ornament} }`
  ];
  return rules.map((rule) => `  ${rule}`).join("\n");
}

/**
 * Every design's rules, and the rounded face carried onto the Contents and the
 * title page of a book whose sheets use it, so the front matter speaks the
 * same type as the story.
 */
const STORY_DESIGN_CSS = `
${allStoryPageDesigns().map(designCss).join("\n")}
  ${TEXT_STORY}:has(.pdf-story-scene--face-rounded) .book-contents :is(h2, .book-contents__name, .book-contents__page),
  ${TEXT_STORY}:has(.pdf-story-scene--face-rounded) .book-title-page :is(h1, h2, p) {
    font-family: ${FACE_FAMILY.rounded};
  }
`;

/**
 * Only the explicit story layout changes flow; ordinary books retain the house stylesheet.
 *
 * A text-only story sheet used to set every scene at 20pt from 48mm down, so a
 * 40-word page of a picture book with no pictures filled the top quarter of an
 * A4 sheet and left the rest blank — and a 120-word one spilled two lines onto
 * a sheet of its own. The scene is now a column as tall as the sheet's writing
 * area (255mm, less a margin for rounding) with its prose centred in it, set at
 * the size its length allows (`storySceneLength`), and closed by the Contents
 * page's hairline ornament. The centring margins are auto margins, which resolve
 * to zero when a scene outgrows its sheet, so an overlong scene starts at the
 * top and spills downward rather than overflowing upward.
 */
export const STORY_PAGE_PDF_CSS = `
  .pdf-story-page { display: flow-root; break-before: page; page-break-before: always; }
  .pdf-story-page > :first-child { margin-top: 0; }
  ${TEXT_STORY} .pdf-story-scene, ${PICTURE_STORY} .pdf-story-scene {
    display: flex;
    flex-direction: column;
    min-block-size: 238mm;
    max-inline-size: var(--story-measure);
    margin-inline: auto;
  }
  ${TEXT_STORY} .pdf-story-scene::before, ${PICTURE_STORY} .pdf-story-scene::before {
    content: "";
    margin-block-start: auto;
  }
  ${PICTURE_STORY} .pdf-story-scene:has(img) { max-inline-size: none; }
  ${PICTURE_STORY} .pdf-story-scene:has(img) > :not(:has(img)) {
    inline-size: 100%;
    max-inline-size: var(--story-measure);
    margin-inline: auto;
  }
  ${PICTURE_STORY} .pdf-story-scene p:has(> img) { margin: 0 0 ${PICTURE_GAP_MM}mm; }
  ${PICTURE_STORY} .pdf-story-scene img {
    inline-size: auto;
    block-size: auto;
    max-inline-size: 100%;
    max-block-size: ${PICTURE_MAX_MM}mm;
    margin: 0 auto;
    object-fit: contain;
  }
  ${PICTURE_STORY} .pdf-story-scene:has(img)::after {
    content: "";
    margin-block-end: auto;
  }
  ${PICTURE_STORY} .pdf-story-scene:not(:has(img))::after,
  ${TEXT_STORY} .pdf-story-scene::after {
    content: "";
    flex: none;
    inline-size: 28mm;
    block-size: 1px;
    margin: ${ORNAMENT_GAP_EM}em auto 0;
    margin-block-end: auto;
    background: linear-gradient(90deg, transparent, #c9b79f 18%, #8b6f4e 50%, #c9b79f 82%, transparent);
  }
  ${STORY_SCENE_TIER_CSS.map((rule) => rule.replace(/^([^{]+)\{/, (_, selector: string) => `${TEXT_STORY} ${selector.trim()}, ${PICTURE_STORY} ${selector.trim()} {`)).join("\n  ")}
  ${TEXT_STORY} .pdf-story-scene h2, ${PICTURE_STORY} .pdf-story-scene h2 {
    font-size: max(1em, 15pt);
    line-height: 1.3;
    margin: 0 0 ${HEADING_GAP_EM}em;
  }
  /* A picture scene's text column is centred by its side margins, which the two rules above reset. */
  ${PICTURE_STORY} .pdf-story-scene:has(img) > :is(h2, p):not(:has(img)) { margin-inline: auto; }
  ${TEXT_STORY} .pdf-story-scene p { margin: 0 0 ${PARAGRAPH_GAP_EM}em; }
  ${PICTURE_STORY} .pdf-story-scene p:not(:has(> img)) { margin-block: 0 ${PARAGRAPH_GAP_EM}em; }
  ${TEXT_STORY} .pdf-story-scene > p:last-of-type, ${PICTURE_STORY} .pdf-story-scene > p:last-of-type { margin-block-end: 0; }
  ${TEXT_STORY} .book-contents { padding: 16mm 8mm 14mm; }
  ${TEXT_STORY} .book-contents__item { margin-bottom: 5mm; }
  ${TEXT_STORY} .book-contents__link {
    grid-template-columns: 25mm minmax(0, 1fr) 12mm max-content;
    align-items: baseline;
  }
  ${TEXT_STORY} .book-contents__chapter {
    grid-column: 1; grid-row: 1;
    margin: 0;
    font-size: 8pt;
    letter-spacing: normal;
  }
  ${TEXT_STORY} .book-contents__name { grid-column: 2; grid-row: 1; font-size: 13pt; }
  ${TEXT_STORY} .book-contents__link:not(:has(.book-contents__chapter)) .book-contents__name { grid-column: 1 / 3; }
  ${TEXT_STORY} .book-contents__leader { grid-column: 3; grid-row: 1; transform: none; }
  ${TEXT_STORY} .book-contents__page { grid-column: 4; grid-row: 1; }
${STORY_DESIGN_CSS}`;

/**
 * Wrap authoritative scene blocks in the renderer's private Markdown copy.
 * Rebase its anchor offsets before normal marker injection: joining plain
 * paragraphs or guessing boundaries from titles would lose text-only scenes.
 * No fixed heights or overflow clipping — the sheet-tall column is a minimum —
 * so an oversized scene may spill, and the measured map must honestly retain
 * that range.
 */
export function separateStoryPagesForPdf<T extends StoryPagePlan>(markdown: string, plan: T): { markdown: string; plan: T } {
  const source = splitStoryPageMarkdown(markdown, plan);
  if (!source) return { markdown, plan };
  let result = source.frontmatter;
  const anchors: PageAnchorPlan[] = [];
  // A design's card and face print only in a book with no pictures (`TEXT_STORY`),
  // so a picture book's scenes are measured on plain sheets.
  const pictureBook = source.scenes.some((entry) => SCENE_PICTURE.test(entry.markdown));
  for (const [position, { anchor, markdown: scene }] of source.scenes.entries()) {
    const designId = plan.storyPageDesign;
    const design = designId ? storyPageDesign(designId) : undefined;
    const length = storySceneLength(scene, pictureBook ? undefined : designId, { picture: SCENE_PICTURE.test(scene) });
    const classes = [
      "pdf-story-page",
      "pdf-story-scene",
      `pdf-story-scene--${length}`,
      ...(design
        ? [
            `pdf-story-scene--design-${design.id}`,
            `pdf-story-scene--sheet-${position % design.sheets.length}`,
            `pdf-story-scene--face-${design.face}`
          ]
        : [])
    ];
    result += `${position ? "\n\n</div>" : ""}\n\n<div class="${classes.join(" ")}">\n\n`;
    anchors.push(anchor.existingIdOffset !== undefined
      ? { ...anchor, existingIdOffset: result.length }
      : { ...anchor, markdownOffset: result.length });
    result += scene;
  }
  result += "\n\n</div>\n\n";
  let sourcesOffset: number | undefined;
  if (source.backmatter !== undefined) {
    result += '<div class="pdf-story-page">\n\n';
    sourcesOffset = result.length;
    result += source.backmatter + "\n\n</div>\n";
  }
  return { markdown: result, plan: { ...plan, pageAnchors: anchors,
    ...(sourcesOffset !== undefined ? { sourcesOffset } : {}) } };
}
