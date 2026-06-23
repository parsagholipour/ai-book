import {
  generateJsonWithJailbreak,
  type TextModelAdapter
} from "@book-maker/core";
import { z } from "zod";

export type BookEditIntentKind =
  | "answer"
  | "clarify"
  | "plan_revision"
  | "local_patch"
  | "page_rewrite"
  | "book_replan";

export type BookEditProjectStage = "plan_ready" | "complete" | "other";

export type BookEditPageContext = {
  id: string;
  index: number;
  title: string;
  summary: string;
  previewText: string;
};

export type BookEditIntent = {
  kind: BookEditIntentKind;
  confidence: number;
  reasoning: string;
  affectedPageIndexes: number[];
  assistantMessage: string;
};

export const BOOK_EDIT_CONFIDENCE_THRESHOLD = 0.72;

const classifierSchema = z
  .object({
    kind: z.enum(["answer", "clarify", "plan_revision", "local_patch", "page_rewrite", "book_replan"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().trim().min(1).max(600),
    affectedPageIndexes: z.array(z.number().int().positive()).max(12).default([]),
    assistantMessage: z.string().trim().min(1).max(1200)
  })
  .strict();

export async function classifyProjectChatMessage(options: {
  message: string;
  stage: BookEditProjectStage;
  pages: BookEditPageContext[];
  planSummary?: string | undefined;
  textModel?: TextModelAdapter | undefined;
}): Promise<BookEditIntent> {
  const message = options.message.trim();
  const heuristic = classifyWithHeuristics(message, options.stage, options.pages);
  if (heuristic.confidence >= BOOK_EDIT_CONFIDENCE_THRESHOLD || !options.textModel) {
    return normalizeIntentForStage(heuristic, options.stage);
  }

  try {
    const result = await generateJsonWithJailbreak(options.textModel, {
      schema: classifierSchema,
      temperature: 0.1,
      maxTokens: 900,
      purpose: "project_chat.intent_classifier",
      lessCensored: false,
      jailbreakRole: "reviewer",
      messages: [
        {
          role: "system",
          content: [
            "Classify a user's chat message for an AI book-making app.",
            "Return answer for general questions that should not edit the book.",
            "Return clarify when the user appears to want an edit but the target/scope is unclear.",
            "Return plan_revision when the project is still in plan review and the user asks to change the plan.",
            "Return local_patch for small wording/typo/replacement edits to generated book text.",
            "Return page_rewrite for same-structure rewrites of pages/chapters/style/tone/details.",
            "Return book_replan for adding/removing chapters, changing length, premise, audience, book type, or structure.",
            "Use affectedPageIndexes only when the target page is explicit or strongly inferable.",
            "Never include provider, model, chain-of-thought, or internal routing details in assistantMessage."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            projectStage: options.stage,
            userMessage: message,
            planSummary: options.planSummary ?? null,
            pages: options.pages.map((page) => ({
              index: page.index,
              title: page.title,
              summary: page.summary,
              previewText: page.previewText.slice(0, 500)
            }))
          })
        }
      ]
    });
    return normalizeIntentForStage(result.data, options.stage);
  } catch {
    return normalizeIntentForStage(heuristic, options.stage);
  }
}

export function classifyWithHeuristics(
  message: string,
  stage: BookEditProjectStage,
  pages: BookEditPageContext[]
): BookEditIntent {
  const lower = message.toLowerCase();
  const explicitPages = pageIndexesFromMessage(message, pages);
  const hasEditVerb =
    /\b(change|edit|rewrite|revise|fix|replace|remove|delete|add|insert|update|make|turn|shorten|expand|polish|regenerate)\b/i.test(
      message
    );
  const asksQuestion = /\?$|^(what|why|how|can you explain|tell me|summari[sz]e|where|when)\b/i.test(message.trim());
  const structural =
    /\b(add|remove|delete|new)\s+(a\s+)?(chapter|section|page)\b/i.test(message) ||
    /\b(change|switch)\s+(the\s+)?(audience|premise|book type|length|structure|outline|plan)\b/i.test(message) ||
    /\bmake\s+it\s+(twice|half|much)\b/i.test(lower);
  const patch =
    /\b(typo|spelling|grammar|replace|rename|change)\b/i.test(message) ||
    /["“][^"”]{1,160}["”]\s+(to|with|into)\s+["“][^"”]{1,160}["”]/i.test(message);
  const rewrite =
    /\b(rewrite|revise|make.+tone|make.+warmer|make.+clearer|shorten|expand|polish|regenerate)\b/i.test(message);

  if (stage === "plan_ready" && hasEditVerb) {
    return {
      kind: "plan_revision",
      confidence: 0.86,
      reasoning: "The project is in plan review and the message requests a change.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll revise the book plan with that direction."
    };
  }

  if (stage !== "complete") {
    return {
      kind: asksQuestion || !hasEditVerb ? "answer" : "clarify",
      confidence: asksQuestion || !hasEditVerb ? 0.82 : 0.65,
      reasoning: "The project is not ready for generated-book edits.",
      affectedPageIndexes: [],
      assistantMessage:
        asksQuestion || !hasEditVerb
          ? "I can answer questions about this project, but book text edits are available after the book is generated."
          : "I can help with that after the current book work is finished."
    };
  }

  if (!hasEditVerb && asksQuestion) {
    return {
      kind: "answer",
      confidence: 0.86,
      reasoning: "The user is asking a general question.",
      affectedPageIndexes: [],
      assistantMessage: answerMessage(message, pages)
    };
  }

  if (!hasEditVerb) {
    return {
      kind: "answer",
      confidence: 0.74,
      reasoning: "No edit intent was detected.",
      affectedPageIndexes: [],
      assistantMessage: "I can help with questions about the book or make edits if you tell me what to change."
    };
  }

  if (structural) {
    return {
      kind: "book_replan",
      confidence: 0.84,
      reasoning: "The request changes the book structure or planning assumptions.",
      affectedPageIndexes: explicitPages,
      assistantMessage: "I’ll rebuild the plan and regenerate the book around that structural change."
    };
  }

  if (patch) {
    return {
      kind: "local_patch",
      confidence: explicitPages.length > 0 || quotedTexts(message).length > 0 ? 0.88 : 0.7,
      reasoning: "The request looks like a small text edit.",
      affectedPageIndexes: explicitPages,
      assistantMessage:
        explicitPages.length > 0
          ? `I’ll apply that text edit to page ${formatPageList(explicitPages)}.`
          : "Which page or exact phrase should I change?"
    };
  }

  if (rewrite) {
    return {
      kind: explicitPages.length > 0 ? "page_rewrite" : "clarify",
      confidence: explicitPages.length > 0 ? 0.83 : 0.66,
      reasoning: "The request is a same-structure rewrite, but broad targets need clarification.",
      affectedPageIndexes: explicitPages,
      assistantMessage:
        explicitPages.length > 0
          ? `I’ll rewrite page ${formatPageList(explicitPages)} with that direction.`
          : "Which page or chapter should I rewrite?"
    };
  }

  return {
    kind: "clarify",
    confidence: 0.6,
    reasoning: "The message appears edit-like but the target is unclear.",
    affectedPageIndexes: explicitPages,
    assistantMessage: "What exact page, chapter, or phrase should I edit?"
  };
}

function normalizeIntentForStage(intent: BookEditIntent, stage: BookEditProjectStage): BookEditIntent {
  const bounded: BookEditIntent = {
    ...intent,
    confidence: Math.max(0, Math.min(1, intent.confidence)),
    affectedPageIndexes: [...new Set(intent.affectedPageIndexes)].sort((a, b) => a - b)
  };
  if (stage === "plan_ready" && ["local_patch", "page_rewrite", "book_replan"].includes(bounded.kind)) {
    return { ...bounded, kind: "plan_revision" };
  }
  if (bounded.confidence < BOOK_EDIT_CONFIDENCE_THRESHOLD && bounded.kind !== "answer") {
    return {
      ...bounded,
      kind: "clarify",
      assistantMessage: bounded.assistantMessage || "Can you clarify what you want changed?"
    };
  }
  return bounded;
}

export function pageIndexesFromMessage(message: string, pages: BookEditPageContext[]): number[] {
  const indexes = new Set<number>();
  for (const match of message.matchAll(/\bpages?\s+(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
      indexes.add(index);
    }
  }
  for (const page of pages) {
    const title = page.title.trim().toLowerCase();
    if (title.length >= 4 && message.toLowerCase().includes(title)) {
      indexes.add(page.index);
    }
  }
  return [...indexes].filter((index) => pages.some((page) => page.index === index)).sort((a, b) => a - b);
}

export function quotedTexts(message: string): string[] {
  return [...message.matchAll(/["“]([^"”]{1,500})["”]/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

function answerMessage(message: string, pages: BookEditPageContext[]): string {
  const lower = message.toLowerCase();
  if (/\bhow many pages\b/.test(lower)) {
    return `This book currently has ${pages.length} generated pages.`;
  }
  if (/\bsummar/i.test(message)) {
    const pageLines = pages
      .slice(0, 6)
      .map((page) => `Page ${page.index}: ${page.summary || page.title}`)
      .join("\n");
    return pageLines || "There are no generated pages to summarize yet.";
  }
  return "I can answer questions about the latest book or edit it if you ask for a specific change.";
}

function formatPageList(indexes: number[]): string {
  return indexes.length === 1 ? String(indexes[0]) : indexes.join(", ");
}
