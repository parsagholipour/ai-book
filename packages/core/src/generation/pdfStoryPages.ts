import { chapterAnchorMarkup, type CompiledBookMarkdown, type PageAnchorPlan } from "./markdown.js";
import { isImportedManuscript, type CreateProjectInput } from "../schemas/book.js";

export type StoryPagePlan = Pick<CompiledBookMarkdown, "pageAnchors" | "sourcesOffset" | "storyPageLayout">;

/** Scene pagination is independent of image frequency and model-review switches. */
export function shortKidsStoryPageLayout(input: Pick<CreateProjectInput, "category" | "targetPages"> & { mediaSettings: unknown },
  pages: readonly { index: number; markdown: string }[]): "separate" | undefined {
  return input.category === "KIDS" && input.targetPages >= 5 && input.targetPages <= 40 &&
    !isImportedManuscript(input.mediaSettings) && pages.length === input.targetPages &&
    pages.every((page, index) => page.index === index + 1 && page.markdown.trim().length > 0)
    ? "separate" : undefined;
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
// figures count too. A cover is not a scene illustration. Rich/illustrated
// books keep their existing layout, including their unillustrated scenes.
const TEXT_STORY = "body:has(.pdf-story-scene):not(:has(.pdf-story-scene :is(img, svg, figure, table, pre)))";

/** Only the explicit story layout changes flow; ordinary books retain the house stylesheet. */
export const STORY_PAGE_PDF_CSS = `
  .pdf-story-page { display: flow-root; break-before: page; page-break-before: always; }
  .pdf-story-page > :first-child { margin-top: 0; }
  ${TEXT_STORY} .pdf-story-scene {
    max-inline-size: 132mm;
    margin-inline: auto;
    padding-block-start: 48mm;
    font-size: 20pt;
    line-height: 1.6;
  }
  ${TEXT_STORY} .pdf-story-scene h2 {
    font-size: 18pt;
    line-height: 1.3;
    margin: 0 0 9mm;
  }
  ${TEXT_STORY} .pdf-story-scene p { margin: 0 0 0.75em; }
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
`;

/**
 * Wrap authoritative scene blocks in the renderer's private Markdown copy.
 * Rebase its anchor offsets before normal marker injection: joining plain
 * paragraphs or guessing boundaries from titles would lose text-only scenes.
 * No fixed heights or overflow clipping: an oversized scene may spill, and
 * the measured map must honestly retain that range.
 */
export function separateStoryPagesForPdf<T extends StoryPagePlan>(markdown: string, plan: T): { markdown: string; plan: T } {
  const source = splitStoryPageMarkdown(markdown, plan);
  if (!source) return { markdown, plan };
  let result = source.frontmatter;
  const anchors: PageAnchorPlan[] = [];
  for (const [position, { anchor, markdown: scene }] of source.scenes.entries()) {
    result += `${position ? "\n\n</div>" : ""}\n\n<div class="pdf-story-page pdf-story-scene">\n\n`;
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
