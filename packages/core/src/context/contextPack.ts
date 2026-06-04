import type { BookPlan, ChapterPlan } from "../schemas/book.js";
import { contextDirectnessLine } from "../prompting/contentPolicy.js";

export type ContextPackInput = {
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  pageIndex: number;
  targetPages: number;
  previousSummaries: string[];
  continuityNotes: string[];
  researchNotes: string[];
  tokenBudget?: number;
  lessCensored?: boolean;
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
  const directness = contextDirectnessLine(input.lessCensored === true);
  const researchNotes = input.researchNotes.map(sanitizeResearchNote).filter(Boolean);
  const parts = {
    system: [
      `Book: ${input.plan.title}`,
      `Audience: ${input.plan.audience}`,
      `Writing complexity: ${input.plan.writingComplexity}/10`,
      ...(input.readingGuidance?.length ? [`Reading guidance: ${input.readingGuidance.join(" ")}`] : []),
      `Voice: ${input.plan.voiceGuide.join(" ")}`,
      `Avoid: ${input.plan.antiAiRules.join(" ")}`,
      ...(directness ? [directness] : [])
    ].join("\n"),
    outline: [
      input.chapter
        ? `Current chapter ${input.chapter.index}: ${input.chapter.title}\n${input.chapter.summary}`
        : "Current chapter: not assigned",
      `Target page ${input.pageIndex} of ${input.targetPages}.`,
      `Continuity rules: ${input.plan.continuityRules.join(" ")}`
    ].join("\n\n"),
    memory: trimToBudget(
      [
        "Previous page summaries:",
        ...input.previousSummaries.slice(-18),
        "Continuity notes:",
        ...input.continuityNotes.slice(-28)
      ].join("\n"),
      Math.floor(requestedTokens * 0.38)
    ),
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
