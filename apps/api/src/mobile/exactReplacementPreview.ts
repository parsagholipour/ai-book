import {
  applyExactReplacement,
  countExactMatches,
  exactReplacementLineDiff,
  exactReplacementSearchTerms,
  hasExactMatch,
  type ExactReplacement
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { type BookEditIntent } from "../bookEditIntent.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { createAssistantChatMessage } from "./projectChat.js";

/**
 * Works out, before anything is charged, exactly what a literal find/replace
 * would do.
 *
 * The worker has always had a model-free path for these edits
 * (`locallyPatchedPage`), but the decision to take it was made per page at
 * apply time and never fed back into pricing: a `local_patch` was billed per
 * page whether it ran the free string replacement or fell through to two model
 * calls per page. Computing the result here instead makes the cheap path
 * something we can *promise* — a real diff to approve, and no charge, because
 * no provider call will happen.
 *
 * A page that does not contain the literal text is dropped rather than left in
 * scope. Candidates come from a case-insensitive database match, so a page can
 * match the search and still not contain the string the replacement needs.
 * Leaving it in is what used to send it silently down the expensive path.
 */

/** Enough to see the shape of the change without turning the card into the book. */
const MAX_SAMPLES = 5;
/** Long enough for a sentence; a full paragraph line would swamp the card. */
const MAX_SAMPLE_LENGTH = 160;

export type ExactReplacementPlan = {
  replacement: ExactReplacement;
  /** Pages that really contain `from`, in order. Always non-empty. */
  pageIndexes: number[];
  matchCount: number;
  samples: Array<{ pageIndex: number; before: string; after: string }>;
};

export async function planExactReplacement(
  projectId: string,
  requested: ExactReplacement | null,
  candidatePageIndexes: number[]
): Promise<ExactReplacementPlan | null> {
  if (!requested?.from || candidatePageIndexes.length === 0) {
    return null;
  }
  // Bounded twice: by the pages already in scope, and by a case-insensitive
  // database match on the text itself. Without the second bound a whole-book
  // scope ("replace X with Y everywhere") loaded every page's markdown into
  // the API — twice, once at proposal and once at apply. The insensitive
  // match is a strict superset of both matchers below (literal and
  // case-preserving), so no page they could match is filtered out here.
  // A word swap also rewrites the word's regular plural, which need not
  // contain the singular ("cities"), so every spelling it touches is searched.
  const pages = await prisma.page.findMany({
    where: {
      projectId,
      index: { in: candidatePageIndexes },
      OR: exactReplacementSearchTerms(requested).flatMap((term) => [
        { markdown: { contains: term, mode: "insensitive" as const } },
        { title: { contains: term, mode: "insensitive" as const } }
      ])
    },
    orderBy: { index: "asc" },
    select: { index: true, title: true, markdown: true }
  });

  // Prefer the literal swap; fall back to case-preserving only when the exact
  // text appears nowhere. Someone who types "replace rabbit with fly" about a
  // book that writes "Rabbit" means that book — and the alternative is not a
  // literal edit, it is a per-page regeneration they did not ask for.
  const replacement = pages.some(
    (page) => hasExactMatch(page.markdown, requested) || hasExactMatch(page.title, requested)
  )
    ? requested
    : { ...requested, preserveCase: true };

  const pageIndexes: number[] = [];
  const samples: ExactReplacementPlan["samples"] = [];
  let matchCount = 0;

  for (const page of pages) {
    const matches = countExactMatches(page.markdown, replacement) + countExactMatches(page.title, replacement);
    if (matches === 0) {
      continue;
    }
    pageIndexes.push(page.index);
    matchCount += matches;
    for (const line of exactReplacementLineDiff(page.markdown, replacement, MAX_SAMPLES - samples.length)) {
      samples.push({ pageIndex: page.index, ...sampleWindow(line.before, line.after, replacement) });
    }
    // A title-only change still has to be visible, or a rename that touches
    // just the heading would show an empty preview.
    if (samples.length < MAX_SAMPLES && hasExactMatch(page.title, replacement)) {
      samples.push({
        pageIndex: page.index,
        before: truncate(page.title),
        after: truncate(applyExactReplacement(page.title, replacement))
      });
    }
  }

  if (pageIndexes.length === 0) {
    return null;
  }
  return { replacement, pageIndexes, matchCount, samples };
}

/**
 * The answer to a swap whose term is on none of the pages it covers: there is
 * nothing to swap. Falling through priced it as a model edit of those pages —
 * every page, for the book-wide fast path — to replace a word the book does
 * not use. Settled rather than asked about, so no pending edit resurfaces.
 */
export async function replyReplacementNotFound(
  projectId: string,
  userMessageId: string,
  intent: BookEditIntent,
  from: string
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId: userMessageId,
    content: `I couldn’t find “${from}” in ${intent.scope === "all_pages" ? "the book" : "those pages"}, so there’s nothing to replace. No edit was applied.`,
    metadata: {
      intent: { ...intent, kind: "clarify", affectedPageIndexes: [], clarification: "none" },
      pendingEditCancelled: true,
      charged: false
    }
  });
}

/** The card payload the app renders. Kept flat so `sanitizePublicChatMetadata` can pass it through. */
export function exactReplacementPreviewCard(plan: ExactReplacementPlan): Record<string, unknown> {
  return {
    kind: "exact_replace",
    from: plan.replacement.from,
    to: plan.replacement.to,
    matchCount: plan.matchCount,
    samples: plan.samples
  };
}

/** Words of context kept before the first change, so the excerpt reads as a sentence. */
const SAMPLE_LEAD_CHARS = 48;

/**
 * One excerpt of a changed line, cut from the same place on both sides.
 *
 * Each side used to be cut at 160 characters on its own, so a longer
 * replacement ("tray" → "saucer") shifted the after side's cut and the card
 * highlighted the cut tails as a change ("blocks t…" against "blocks…"), and a
 * change past character 160 showed two identical excerpts. The window is taken
 * from the original line around its first change and the after excerpt is that
 * same window replaced; when that does not read back out of the full after line
 * (a word form decided by context outside the window), both sides fall back to
 * the old independent cut.
 */
function sampleWindow(before: string, after: string, replacement: ExactReplacement): { before: string; after: string } {
  const original = before.trim();
  const changed = after.trim();
  if (original.length <= MAX_SAMPLE_LENGTH && changed.length <= MAX_SAMPLE_LENGTH) {
    return { before: original, after: changed };
  }
  let firstChange = 0;
  while (firstChange < original.length && original[firstChange] === changed[firstChange]) firstChange += 1;
  let start = Math.max(0, firstChange - SAMPLE_LEAD_CHARS);
  if (start > 0) {
    const space = original.lastIndexOf(" ", start);
    start = space < 0 ? 0 : space + 1;
  }
  let end = Math.min(original.length, start + MAX_SAMPLE_LENGTH - 2);
  if (end < original.length) {
    const space = original.lastIndexOf(" ", end);
    if (space > firstChange) end = space;
  }
  const window = original.slice(start, end);
  const replaced = applyExactReplacement(window, replacement);
  if (window === replaced || !changed.includes(replaced)) {
    return { before: truncate(original), after: truncate(changed) };
  }
  const lead = start > 0 ? "…" : "";
  const tail = end < original.length ? "…" : "";
  return { before: `${lead}${window}${tail}`, after: `${lead}${replaced}${tail}` };
}

function truncate(line: string): string {
  const clean = line.trim();
  return clean.length > MAX_SAMPLE_LENGTH ? `${clean.slice(0, MAX_SAMPLE_LENGTH - 1)}…` : clean;
}
