import { createHash } from "node:crypto";
import { DIALOGUE_WITNESS_GUIDANCE } from "./dialogueWitness.js";
import { z } from "zod";
import type { PriorPageContext } from "./pagesShared.js";

/** Ordered witnesses, one per requirement. IDs bind the page and exact prose;
 * changing even one character invalidates all old references on that page. */
export const pictureBookChecklistReferencesSchema = z.array(z.string().min(1).max(40).nullable()).max(64);

export function pictureBookChecklistSpans(page: Pick<PriorPageContext, "index" | "markdown">) {
  const version = createHash("sha256").update(`${page.index}\n${page.markdown}`).digest("hex").slice(0, 12);
  const spans: Record<string, string> = {};
  let index = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(page.markdown)) {
    // Long sentences are losslessly split to the stored evidence bound. No prose
    // is truncated, paraphrased, duplicated or borrowed from a neighboring page.
    let remaining = segment;
    while (remaining.length) {
      let end = Math.min(300, remaining.length);
      if (end < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[end - 1]!)) end -= 1;
      spans[`${version}:${index++}`] = remaining.slice(0, end);
      remaining = remaining.slice(end);
    }
  }
  return spans;
}

export function pictureBookChecklistPage(page: PriorPageContext) {
  return { index: page.index, title: page.title, spans: pictureBookChecklistSpans(page) };
}

/** Canonical storage still contains copied source text. Legacy excerpts remain
 * accepted and independently validated, so partial checkpoints keep their data. */
export function resolvePictureBookChecklist(value: unknown, pages: ReadonlyMap<number, PriorPageContext>): unknown {
  if (!value || typeof value !== "object" || !("pageIndex" in value) || typeof value.pageIndex !== "number" || !("requirementChecks" in value)) return value;
  const refs = pictureBookChecklistReferencesSchema.safeParse(value.requirementChecks);
  const page = pages.get(value.pageIndex);
  if (!refs.success || !page) return value;
  const spans = pictureBookChecklistSpans(page);
  // Leave bad references invalid; never substitute a nearby or prior-page span.
  if (refs.data.some(id => id !== null && !Object.hasOwn(spans, id))) return value;
  return { ...value, requirementChecks: refs.data.map((id, requirementIndex) => ({
    requirementIndex, evidence: id === null ? null : spans[id]!.trim()
  })) };
}

export const PICTURE_BOOK_CHECKLIST_GUIDANCE = "Pages with spans contain the complete prose in reading order; concatenate span values without adding spaces. For requirementChecks return an array in pageRequirements order, selecting one current-page span ID per satisfied obligation, or null for a missing obligation. Do not retype evidence or requirement indexes. A span only locates evidence: assess the complete requirement in context. For null, report a grounded missing_requirement finding with the exact requirementQuote. A parent lists failedByRequirementIndexes only for its explicit conjunctive children: one grounded child failure also explains the parent null; do not duplicate that finding under the parent quote. Keep checks for every index. A parent cannot pass while a child fails; a failed parent never proves which child failed, and a child pass never proves the whole parent. Distinguish absence of speech from inadequate or unnatural speech, and explain the actual deficiency after considering all spoken lines. " + DIALOGUE_WITNESS_GUIDANCE;
