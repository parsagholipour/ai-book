import { authorStancePromptLines } from "./authorStance.js";
import { arcChapterLines } from "./bookArc.js";
import type { ComposeChapterOptions } from "./composedChapter.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * The stance as one chapter's writer and editor see it. Split from
 * `composedChapter.ts` for the 900-line budget; the compose and edit calls
 * import from here.
 */

/**
 * One rotated position per chapter was tried on composed-8/9: the refrains
 * the panel named in composed-7 were the five positions restated, but shown one
 * each the chapters restated the thesis instead and the book lost its argument
 * ("nothing a reader could disagree with"), 6.73 against 7.73 on the same plan.
 */
const ROTATE_STANCE_POSITIONS = false;

/**
 * A chapter with a focus writes from its own question, which reaches the
 * compose and edit calls through the material helpers; the five global
 * positions are not handed to it as demands, only the voice exemplar. Three
 * blind readers found one institutional explanation reenacted by every
 * chapter's cases when the positions rode in every call. Without a focus the
 * legacy lines are unchanged.
 */
export function stanceLinesFor(options: ComposeChapterOptions): string[] {
  const mode = inferWritingMode(options.input, options.plan);
  if (options.material?.focus) {
    return authorStancePromptLines(options.stance, mode, { exemplarOnly: true });
  }
  const chapters = options.plan.chapters;
  const firstOrLast = options.chapter.index === chapters[0]?.index || options.chapter.index === chapters.at(-1)?.index;
  if (options.arc && !firstOrLast) {
    return [...authorStancePromptLines(options.stance, mode, { exemplarOnly: true }), ...arcChapterLines(options.arc, options.chapter.index)];
  }
  return [
    ...authorStancePromptLines(options.stance, mode, ROTATE_STANCE_POSITIONS ? { chapterIndex: options.chapter.index } : {}),
    ...(options.arc ? arcChapterLines(options.arc, options.chapter.index) : [])
  ];
}
