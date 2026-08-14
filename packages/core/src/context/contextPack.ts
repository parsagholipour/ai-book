import type { BookPlan, ChapterPlan } from "../schemas/book.js";

export type ContextPackInput = {
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  pageIndex: number;
  targetPages: number;
  previousSummaries: string[];
  continuityNotes: string[];
  researchNotes: string[];
  /**
   * Semantically retrieved earlier-book context (e.g. page summaries found via
   * vector search) that falls outside the recency window. Gets its own budget
   * slice so it is not dropped before the recency window when trimming.
   */
  semanticMemory?: string[] | undefined;
  /** Current structured character/location state lines. */
  entityState?: string[] | undefined;
  /** Pinned accepted-page excerpts, separate from the recency window. */
  styleExcerpts?: string[] | undefined;
  tokenBudget?: number;
  readingGuidance?: string[] | undefined;
};

export type ContextPack = {
  system: string;
  outline: string;
  memory: string;
  research: string;
  budget: {
    requestedTokens: number;
    approximateTokens: number;
  };
};

export function buildContextPack(input: ContextPackInput): ContextPack {
  const requestedTokens = input.tokenBudget ?? 6000;
  const researchNotes = input.researchNotes.map(sanitizeResearchNote).filter(Boolean);
  const semanticMemory = (input.semanticMemory ?? []).map((entry) => entry.trim()).filter(Boolean);
  const entityState = (input.entityState ?? []).map((entry) => entry.trim()).filter(Boolean);
  const styleExcerpts = (input.styleExcerpts ?? []).map((entry) => entry.trim()).filter(Boolean);
  const hasSemanticMemory = semanticMemory.length > 0;
  // The memory budget (38% of the pack) is split so retrieved long-range
  // context survives trimming alongside the recency window.
  const semanticBudget = hasSemanticMemory ? Math.floor(requestedTokens * 0.12) : 0;
  const recencyBudget = Math.floor(requestedTokens * 0.38) - semanticBudget;
  const memorySections = [
    hasSemanticMemory
      ? trimToBudget(["Relevant earlier book context (retrieved):", ...semanticMemory].join("\n"), semanticBudget)
      : "",
    trimToBudget(
      [
        "Previous page summaries:",
        ...input.previousSummaries.slice(-18),
        "Continuity notes:",
        ...input.continuityNotes.slice(-28)
      ].join("\n"),
      recencyBudget
    )
  ].filter(Boolean);

  const parts = {
    system: [
      `Book: ${input.plan.title}`,
      `Audience: ${input.plan.audience}`,
      `Writing complexity: ${input.plan.writingComplexity}/10`,
      ...(input.readingGuidance?.length ? [`Reading guidance: ${input.readingGuidance.join(" ")}`] : []),
      `Voice: ${input.plan.voiceGuide.join(" ")}`,
      `Avoid: ${input.plan.antiAiRules.join(" ")}`,
      ...(styleExcerpts.length > 0
        ? [`Style lock excerpts:\n${styleExcerpts.map((excerpt, index) => `${index + 1}. ${excerpt}`).join("\n")}`]
        : [])
    ].join("\n"),
    outline: [
      input.chapter
        ? `Current chapter ${input.chapter.index}: ${input.chapter.title}\n${input.chapter.summary}`
        : "Current chapter: not assigned",
      `Target page ${input.pageIndex} of ${input.targetPages}.`,
      `Continuity rules: ${input.plan.continuityRules.join(" ")}`,
      ...(entityState.length > 0
        ? [trimToBudget(["Current story state:", ...entityState].join("\n"), Math.floor(requestedTokens * 0.1))]
        : [])
    ].join("\n\n"),
    memory: memorySections.join("\n\n"),
    research: trimToBudget(researchNotes.join("\n"), Math.floor(requestedTokens * 0.22))
  };

  const joined = Object.values(parts).join("\n\n");
  return {
    ...parts,
    budget: {
      requestedTokens,
      approximateTokens: approximateTokens(joined)
    }
  };
}

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimToBudget(text: string, tokenBudget: number): string {
  if (approximateTokens(text) <= tokenBudget) {
    return text;
  }
  const charBudget = tokenBudget * 4;
  return text.slice(Math.max(0, text.length - charBudget));
}

function sanitizeResearchNote(note: string): string {
  const clean = note.trim();
  if (RESEARCH_NOTE_LEAK_PATTERNS.some((pattern) => pattern.test(clean))) {
    return "";
  }
  return clean;
}

const RESEARCH_NOTE_LEAK_PATTERNS = [
  /for an ai book/i,
  /research this for/i,
  /global visual style/i,
  /image prompt/i
];
