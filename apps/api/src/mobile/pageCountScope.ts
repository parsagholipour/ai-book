import { linearizeCreationMessages } from "../creationChatTree.js";
import type { MobileCreationDraftPayload } from "../mobileCreation.js";

export type PageCountScope = {
  depth: "concise" | "balanced" | "expanded";
  reason: string;
};

/**
 * A conservative fallback for explicit scope requests when the model cannot
 * answer in time. Read the active user's requests, never an assistant's offer
 * or an edited-away branch. The full semantic judgment still belongs to the
 * recommendation model; this only recognizes clear depth/length requests.
 */
export function requestedPageCountScope(payload: MobileCreationDraftPayload): PageCountScope | null {
  const userMessages = linearizeCreationMessages(payload.messages ?? []).active
    .filter((message) => message.role === "user" && !message.skippedQuestion);
  const requests = [
    payload.brief?.mustInclude ?? "",
    payload.recipe?.mustInclude ?? "",
    payload.optionalDetails.mustInclude,
    ...(payload.messages?.length ? userMessages.map((message) => message.content) : [payload.rawIdea])
  ];
  let detail = false;
  let examples = false;
  let scope: PageCountScope | null = null;
  for (const request of requests) {
    // Negated clauses must not turn "don't add more detail" into an expansion.
    const clauses = request.toLowerCase().replaceAll("’", "'")
      .split(/[.!?,;\n]+|\bbut\b/)
      .filter((clause) => !/\b(?:no|not|without|avoid|skip|don't|do not)\b/.test(clause));
    const text = clauses.join(" ");
    if (/\b(?:keep|make|prefer|want)\b.{0,35}\b(?:short(?!\s+stor(?:y|ies)\b)|brief|concise|compact)\b|\b(?:shorter|less detail|fewer examples|quick overview|brief overview)\b/.test(text)) {
      detail = false;
      examples = false;
      scope = { depth: "concise", reason: "Fits your request to keep the book concise." };
      continue;
    }
    const wantsDetail = /\b(?:more detail(?:s|ed)?|detailed|in[- ]depth|step[- ]by[- ]step|deeper explanations?)\b/.test(text);
    const wantsExamples = /\b(?:examples?|case studies|walkthroughs?|worked solutions?)\b/.test(text);
    const wantsExpansion = /\b(?:longer|comprehensive|exhaustive|deep dive|more chapters)\b/.test(text);
    detail ||= wantsDetail;
    examples ||= wantsExamples;
    if (!(wantsDetail || wantsExamples || wantsExpansion)) continue;
    if (detail && examples) {
      scope = { depth: "expanded", reason: "Gives your requested detail and examples room to develop." };
    } else if (wantsExpansion) {
      scope = { depth: "expanded", reason: "Gives your request for fuller coverage more room." };
    } else if (scope?.depth !== "expanded") {
      scope = {
        depth: "balanced",
        reason: detail
          ? "Leaves room for the detailed explanations you requested."
          : "Leaves room for the examples you requested."
      };
    }
  }
  return scope;
}
