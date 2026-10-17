/**
 * H8 arm PR's reconciliation call: chapter N+1's key conflicts with chapter N go to one call that returns
 * find/replace patches, applied by core's `applyPagePatches` (all or none) in the container. Pure prompt and
 * evidence builders; pre-registered in `.scratch/eval-data/h8/preregistration.md`.
 */
import type { ChatMessage } from "../../lib/fixtures.ts";
import { foldForMatch, sentences, words } from "../../lib/text.ts";
import type { H8Pair, KeyConflict } from "./types.ts";

export const RECONCILE_PURPOSE_ROUTE = "edit-chapter";

/** The sentence of chapter N that states a fact: its subject's name and the most of the value's words. */
export function evidenceSentence(text: string, subject: string, value: string): string | undefined {
  const nameWords = words(foldForMatch(subject)).filter((word) => word.length >= 3);
  const valueWords = [...new Set(words(foldForMatch(value)).filter((word) => word.length >= 3 || /\d/.test(word)))];
  let best: { sentence: string; score: number } | undefined;
  for (const sentence of sentences(text)) {
    const folded = ` ${words(foldForMatch(sentence)).join(" ")} `;
    const named = nameWords.length === 0 || nameWords.some((word) => folded.includes(` ${word} `));
    if (!named) continue;
    const score = valueWords.filter((word) => folded.includes(` ${word} `)).length;
    if (score > 0 && (!best || score > best.score)) best = { sentence, score };
  }
  return best && best.sentence.length <= 600 ? best.sentence : best?.sentence.slice(0, 600);
}

export function reconcileMessages(pair: H8Pair, chapterText: string, conflicts: readonly KeyConflict[], ledgerLinesThroughN: readonly string[]): ChatMessage[] {
  const system = [
    `You make continuity corrections to chapter ${pair.n1}, "${pair.n1Title}", of "${pair.bookTitle}".`,
    `The previous chapter, ${pair.n}, "${pair.nTitle}", was written at the same time as this one and is already printed; where the two give a different value for the same fact, the previous chapter's value stands.`,
    "Each conflict names a person, place or thing, the fact as the previous chapter fixed it with the sentence that states it, and the value this chapter gives instead.",
    "A conflict is a contradiction only when both describe the same person or thing at the same moment and cannot both be true: a different name, role, relation, pronoun, age, date, place, mark or figure. It is not one when this chapter narrates a change, when the two values say the same thing in other words, or when they are about different people or things; skip those.",
    "For each contradiction, return the smallest replacements that make this chapter agree with the previous chapter, wherever this chapter states the differing value, and any figure this chapter computes from it.",
    "Change nothing else: add no sentence, restate nothing from the previous chapter, keep every other word.",
    "Each find is text copied exactly from the chapter, occurring once in it, at most two sentences long.",
    'Return JSON only: {"patches":[{"find":"…","replace":"…"}],"skipped":[{"conflict":0,"reason":"…"}]}.'
  ].join(" ");
  const user = {
    chapter: { index: pair.n1, title: pair.n1Title, markdown: chapterText },
    conflicts: conflicts.map((conflict, id) => ({
      id,
      subject: conflict.earlierSubject,
      attribute: conflict.attribute,
      previousChapter: { value: conflict.earlierValue, ...(evidenceSentence(pair.nText, conflict.earlierSubject, conflict.earlierValue) ? { sentence: evidenceSentence(pair.nText, conflict.earlierSubject, conflict.earlierValue) } : {}) },
      thisChapter: { value: conflict.laterValue }
    })),
    establishedFacts: ledgerLinesThroughN
  };
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(user, null, 2) }
  ];
}

export type ReconcileReply = { patches: Array<{ find: string; replace: string }>; skipped: Array<{ conflict?: number; reason?: string }> };

export function parseReconcileReply(data: unknown): ReconcileReply {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const patches = Array.isArray(record.patches)
    ? record.patches.filter((patch): patch is { find: string; replace: string } =>
      Boolean(patch) && typeof (patch as { find?: unknown }).find === "string" && typeof (patch as { replace?: unknown }).replace === "string" && Boolean((patch as { find: string }).find.trim()))
    : [];
  const skipped = Array.isArray(record.skipped) ? (record.skipped as ReconcileReply["skipped"]) : [];
  return { patches, skipped };
}
