import {
  figureFreeProse,
  hasFigureFence,
  mentionsFigure,
  pageFigureSpecs,
  reinsertFigureFences,
  stripFigureFences,
  validateFigureFences,
  type AnchoredFigureFence,
  type FigureKind
} from "@book-maker/core";
import type { RunLogger } from "../providers/runLogging.js";
import type { IndexedPageDraft } from "../runtime/jobTypes.js";

/**
 * The composed pass's side of figures: what the writer returned is checked
 * against the plan once per candidate, after compose and before best-of
 * judging, and every later step — the line edit, the couplet rewrite, the
 * quote guard, the finalize checks and the story delta — reads prose with
 * the blocks taken out. The blocks go back deterministically
 * (`figureBlocks.ts` in core) before the pages are cut and before a page is
 * staged. Nothing here makes a model call.
 */

export const FIGURE_DROPPED_EVENT = "generation.composed_chapters.figure_dropped";

type ComposedChapterFigureOptions = {
  planned: number;
  kind?: FigureKind;
  projectId: string;
  chapterIndex: number;
  runLog?: Pick<RunLogger, "append">;
};

/**
 * The writer's figure blocks against the plan: unreadable, unterminated and
 * unplanned ones dropped, kept ones canonical. A drop is written to the project's JSONL run
 * log — the artifact a rerun is measured from — and echoed to stdout; a pass
 * with no run logger (tests, scripts) gets the echo alone.
 */
export async function validateComposedChapterFigures(
  options: ComposedChapterFigureOptions & { markdown: string }
): Promise<string> {
  const result = validateFigureFences(options.markdown, {
    max: options.planned,
    ...(options.kind ? { kind: options.kind } : {})
  });
  for (const drop of result.dropped) {
    const detail = {
      projectId: options.projectId,
      chapterIndex: options.chapterIndex,
      planned: options.planned,
      reason: drop.reason,
      excerpt: drop.excerpt
    };
    console.warn("Figure block dropped from a composed chapter", { event: FIGURE_DROPPED_EVENT, ...detail });
    await options.runLog?.append(FIGURE_DROPPED_EVENT, detail);
  }
  return result.markdown;
}

/**
 * A stored page's prose with its figures held aside for a per-page rewrite
 * that is not about them — the compile's final-QA repair — and the way to put
 * them back. The rewrite, its review loop and the story extract read the
 * prose with `[Figure: title]` stand-ins; `restore` goes on the draft the page
 * is published with, and drops any fence the model invented on the way. Pair it
 * with `revisePageDraft`'s `figures: "hold"` so those revises keep the stand-in
 * (and strip invented fences). Without that, a page revised from its raw
 * markdown came back without its chart and was published that way.
 */
export function holdFiguresAside(markdown: string): {
  prose: string;
  restore: <Draft extends { markdown: string }>(draft: Draft) => Draft;
} {
  const { prose, fences } = stripFigureFences(markdown);
  return {
    prose,
    restore: <Draft extends { markdown: string }>(draft: Draft): Draft => {
      const restored = reinsertFigureFences(draft.markdown, fences);
      return restored === draft.markdown ? draft : { ...draft, markdown: restored };
    }
  };
}

export type PageFigureRewrite = {
  keep: boolean;
  figures?: "keep" | "hold";
  prose: string;
  restore: <Draft extends { markdown: string }>(draft: Draft) => Draft;
};

/**
 * Keep, hold or omit a stored page's figure for a rewrite that may or may not
 * be about it — chat and replan (via `pageFigureRewriteForDraft`), never the
 * compile's final-QA repair, which always holds. A request that names the figure
 * sees the block (`figures: "keep"`) and `restore` keeps at most one fence
 * from what comes back. A request that does not name it sees a stand-in
 * (`figures: "hold"`) and `restore` puts the original block back. A page
 * with no figure omits the key.
 */
export function pageFigureRewrite(markdown: string, instruction: string): PageFigureRewrite {
  if (!hasFigureFence(markdown)) {
    return { keep: false, prose: markdown, restore: (draft) => draft };
  }
  if (!mentionsFigure(instruction, pageFigureSpecs(markdown))) {
    const held = holdFiguresAside(markdown);
    return { keep: false, figures: "hold", prose: held.prose, restore: held.restore };
  }
  return {
    keep: true,
    figures: "keep",
    prose: markdown,
    restore: <Draft extends { markdown: string }>(draft: Draft): Draft => {
      const restored = validateFigureFences(draft.markdown, { max: 1 }).markdown;
      return restored === draft.markdown ? draft : { ...draft, markdown: restored };
    }
  };
}

/**
 * Replan generate is figure-free; when `plantSource` is true a source page's
 * fences are planted onto that new prose (`reinsertFigureFences`) and then
 * keep-or-held for review. A draft that already has a fence is left alone — a
 * keep revise may have rewritten it. After a keep revise, `plantSource` is
 * false: never plant, keep at most one fence from what came back. Restore after
 * the review, not before.
 */
export function pageFigureRewriteForDraft<Draft extends { markdown: string }>(
  draft: Draft,
  sourceMarkdown: string | undefined,
  instruction: string,
  plantSource = true
): { draft: Draft; rewrite: PageFigureRewrite } {
  const planted = plantSource
    ? hasFigureFence(draft.markdown) || !sourceMarkdown
      ? draft
      : holdFiguresAside(sourceMarkdown).restore(draft)
    : draft;
  const rewrite = pageFigureRewrite(planted.markdown, instruction);
  if (rewrite.keep || !sourceMarkdown || !hasFigureFence(planted.markdown)) {
    return { draft: planted, rewrite };
  }
  const sourceRewrite = pageFigureRewrite(sourceMarkdown, instruction);
  if (!sourceRewrite.keep) return { draft: planted, rewrite };
  // A keep revise may return an unreadable fence: skip-attach leaves it, and
  // pageFigureRewrite on that body holds (no specs). Keep restore — validate,
  // max 1 — is what drops it. Review the draft's own prose, not the source.
  return { draft: planted, rewrite: { ...sourceRewrite, prose: planted.markdown } };
}

/** Page drafts with their figures taken out, and where each page's blocks go back. */
export function stripDraftFigures(drafts: readonly IndexedPageDraft[]): {
  drafts: IndexedPageDraft[];
  fencesByIndex: Map<number, AnchoredFigureFence[]>;
} {
  const fencesByIndex = new Map<number, AnchoredFigureFence[]>();
  const stripped = drafts.map((draft) => {
    if (!hasFigureFence(draft.markdown)) return draft;
    fencesByIndex.set(draft.index, stripFigureFences(draft.markdown).fences);
    return { ...draft, markdown: figureFreeProse(draft.markdown) };
  });
  return { drafts: stripped, fencesByIndex };
}

/** A page draft with its figures back, after the finalize checks and any revise have run on the prose. */
export function restoreFigures(draft: IndexedPageDraft, fencesByIndex: ReadonlyMap<number, AnchoredFigureFence[]>): IndexedPageDraft {
  const fences = fencesByIndex.get(draft.index);
  if (!fences || fences.length === 0) return draft;
  return { ...draft, markdown: reinsertFigureFences(draft.markdown, fences) };
}
