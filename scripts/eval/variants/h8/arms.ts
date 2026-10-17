/**
 * H8 arms as message transforms of chapter N+1's logged compose request (pre-registered in
 * `.scratch/eval-data/h8/preregistration.md`). Pure: the product strings it needs are passed in.
 *
 * - P0: what N+1 could not have when composed beside N is taken away — N's tail and N's facts — and the memory is
 *   what existed when N started (N's own request's continuity notes and story state).
 * - P1: P0 plus N's planned composition and landing in place of its tail.
 */
import type { ChatMessage } from "../../lib/fixtures.ts";
import type { H8Pair } from "./types.ts";

/** The product's sentence (composedChapter.ts), replaced in P1. */
export const TAIL_RULE =
  "previousChapterTail is where the previous chapter stopped, already printed: this chapter opens on its own first section's material and neither resumes, summarises nor answers that paragraph.";
export const PLAN_RULE =
  "previousChapterPlan is the previous chapter, written at the same time as this one: its sections and landing, the paragraph it ends on. It is already printed when this chapter is read: this chapter opens on its own first section's material and neither resumes, summarises nor answers that ending.";

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function plannedDigest(pair: H8Pair): string {
  const joined = pair.nComposition.sections.map((section) => section.subject.trim()).filter(Boolean).join(" ");
  return joined.split(/\s+/).slice(0, 60).join(" ");
}

export function parallelMessages(pair: H8Pair, options: { withPlan: boolean; establishedFactsWriterRule: string }): ChatMessage[] {
  const messages = pair.n1Request.messages;
  const userIndex = messages.map((message) => message.role).lastIndexOf("user");
  const payload = asRecord(JSON.parse(messages[userIndex]!.content));
  const ledger = pair.nRequest.establishedFacts;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "previousChapterTail") {
      if (options.withPlan) {
        next.previousChapterPlan = {
          index: pair.n,
          title: pair.nTitle,
          sections: pair.nComposition.sections.map((section) => ({ form: section.form, subject: section.subject })),
          landing: pair.nComposition.landing
        };
      }
      continue;
    }
    if (key === "establishedFacts") {
      if (ledger.length > 0) next.establishedFacts = ledger;
      continue;
    }
    if (key === "continuityNotes") {
      next.continuityNotes = pair.nRequest.continuityNotes;
      continue;
    }
    if (key === "storyState") {
      if (pair.nRequest.storyState) next.storyState = pair.nRequest.storyState;
      continue;
    }
    if (key === "earlierChapters" && Array.isArray(value)) {
      next.earlierChapters = value.map((item) => {
        const entry = asRecord(item);
        return entry.index === pair.n ? { ...entry, digest: plannedDigest(pair) } : entry;
      });
      continue;
    }
    next[key] = value;
  }
  return messages.map((message, index) => {
    if (index === userIndex) return { ...message, content: JSON.stringify(next, null, 2) };
    if (message.role !== "system") return message;
    let content = message.content;
    if (ledger.length === 0) content = content.replace(` ${options.establishedFactsWriterRule}`, "").replace(options.establishedFactsWriterRule, "");
    if (options.withPlan) content = content.replace(TAIL_RULE, PLAN_RULE);
    return { ...message, content };
  });
}

/** Which product strings each transform touched, for the result record (a transform that matched nothing is a bug). */
export function transformAudit(pair: H8Pair, messages: readonly ChatMessage[], options: { withPlan: boolean; establishedFactsWriterRule: string }) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const original = pair.n1Request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  return {
    tailRuleReplaced: options.withPlan ? !system.includes(TAIL_RULE) && system.includes(PLAN_RULE) && original.includes(TAIL_RULE) : undefined,
    writerRuleDropped: pair.nRequest.establishedFacts.length === 0 ? original.includes(options.establishedFactsWriterRule) && !system.includes(options.establishedFactsWriterRule) : undefined
  };
}
