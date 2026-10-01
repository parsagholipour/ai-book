import {
  type MobileBookTypeChoice,
  type MobileCreationBrief,
  type MobileCreationLane,
  type MobileCreationPresets
} from "./mobileCreationSchemas.js";

/**
 * Lane vocabulary: the deterministic per-lane fallback copy and the mappings
 * between lanes, legacy intents, and product book types. Split out of
 * mobileCreation.ts, which is its only consumer.
 */

/**
 * Words that make a phrase after "for" a reader rather than a purpose ("for
 * supply chains today") or the rest of the sentence.
 */
const AUDIENCE_NOUN =
  /\b(?:readers?|people|anyone|everyone|those|beginners?|newcomers?|kids?|children|toddlers?|teens?|teenagers?|adults?|seniors?|students?|learners?|parents?|mothers?|fathers?|mums?|moms?|dads?|families|couples?|teachers?|educators?|coaches|managers?|leaders?|founders?|owners?|entrepreneurs?|executives?|professionals?|freelancers?|consultants?|clients?|customers?|employees?|teams?|developers?|engineers?|designers?|writers?|authors?|artists?|marketers?|nurses?|doctors?|women|men|girls?|boys?|daughters?|sons?|friends?|fans?|lovers?|enthusiasts?|travell?ers?|investors?|homeowners?|volunteers?)\b/i;
/** Where the reader ends and the rest of the idea begins. */
const AUDIENCE_END = /[,.!?;:\u2014\u2013(]|\s+(?:on|about|who|that|which|to|so|how|where|when|because|and)\s/i;
const AUDIENCE_MAX_WORDS = 8;
/** "looking for her mother" names what a character wants, not who reads the book. */
const PHRASAL_FOR = /\b(?:look(?:s|ing|ed)?|search(?:es|ing|ed)?|wait(?:s|ing|ed)?|ask(?:s|ing|ed)?|hop(?:es?|ing|ed)|long(?:s|ing|ed)?|car(?:es?|ing|ed)|fight(?:s|ing)?|hunt(?:s|ing|ed)?)\s+$/i;

/**
 * The reader the idea itself names, or nothing. Only a fallback for a draft
 * whose brief the model did not fill in, so it answers when it is sure: the
 * old capture ran from "for" to the next comma and printed "new first-time
 * managers on running genuinely useful one-on-one meetings with their direct
 * reports: how to structure them" as the book's audience (2026-09-30).
 */
export function audienceFor(rawIdea: string): string {
  const age = rawIdea.match(/\b([2-9]|10|11|12)\s*(-| )?(year|yr)s?\s*olds?\b/i)?.[0];
  if (age) {
    return age.replace(/\s+/g, " ");
  }
  for (const match of rawIdea.matchAll(/\bfor\s+/gi)) {
    if (PHRASAL_FOR.test(rawIdea.slice(0, match.index))) continue;
    const named = rawIdea.slice(match.index + match[0].length).split(AUDIENCE_END)[0]!.trim();
    if (named && named.split(/\s+/).length <= AUDIENCE_MAX_WORDS && AUDIENCE_NOUN.test(named)) {
      return named;
    }
  }
  return "";
}

export function audienceFallback(lane: MobileCreationLane): string {
  return {
    auto: "readers implied by the idea",
    children_story: "young children",
    adult_story: "adult fiction readers",
    workbook: "learners",
    client_tool: "clients",
    offer_guide: "prospective clients",
    lead_magnet: "ideal readers",
    practical_guide: "readers who want a practical next step"
  }[lane];
}

export function artifactForLane(lane: MobileCreationLane): string {
  return {
    auto: "Book",
    children_story: "Children's story",
    adult_story: "Short story",
    workbook: "Workbook",
    client_tool: "Client workbook",
    offer_guide: "Offer guide",
    lead_magnet: "Lead magnet",
    practical_guide: "Practical guide"
  }[lane];
}

export function toneFallback(lane: MobileCreationLane): string {
  return {
    auto: "clear and fitted to the intended book shape",
    children_story: "warm, simple, and read-aloud friendly",
    adult_story: "immersive and emotionally clear",
    workbook: "clear, encouraging, and practical",
    client_tool: "supportive and action-oriented",
    offer_guide: "polished and credible",
    lead_magnet: "concise, useful, and confident",
    practical_guide: "plainspoken and helpful"
  }[lane];
}

/**
 * What the lane promises when the model named no outcome. Never a span of
 * the idea: splicing a "cleaned" title in printed "get a useful first step
 * for i want a practical , what" into a book's brief (2026-09-30).
 */
export function promiseFallback(lane: MobileCreationLane): string {
  if (lane === "auto") return "the book that best fits the idea described in the chat";
  if (lane === "children_story") return "a gentle story children can follow and enjoy";
  if (lane === "adult_story") return "a compact story with a clear emotional turn";
  if (lane === "workbook" || lane === "client_tool") return "complete useful practice and leave with a next step";
  if (lane === "offer_guide") return "understand the offer and decide what to do next";
  return "leave with a clear, practical first step on the topic";
}

export function mainCharacterFor(rawIdea: string, lane: MobileCreationLane): string {
  if (lane === "children_story") return "a curious child or gentle animal";
  if (lane === "adult_story") return "a character facing a meaningful choice";
  return "";
}

export function conflictFallback(lane: MobileCreationLane): string {
  if (lane === "children_story") return "a small worry, surprise, or adventure";
  if (lane === "adult_story") return "a problem that forces a choice";
  return "";
}

export function endingFallback(lane: MobileCreationLane): string {
  if (lane === "children_story") return "warm, reassuring, and memorable";
  if (lane === "adult_story") return "satisfying with a clear final image";
  return "";
}

export function themeFallback(lane: MobileCreationLane): string {
  if (lane === "children_story") return "kindness, courage, curiosity, or bedtime calm";
  if (lane === "adult_story") return "change, repair, courage, or second chances";
  return "";
}

export function nextStepFallback(lane: MobileCreationLane): string {
  if (lane === "lead_magnet") return "invite the reader to take one clear next step";
  if (lane === "offer_guide") return "book a call, compare options, or understand the method";
  if (lane === "workbook" || lane === "client_tool") return "finish a checklist or action plan";
  return "";
}

export function exercisesFallback(lane: MobileCreationLane): string {
  if (lane === "workbook" || lane === "client_tool") return "short exercises, reflection prompts, and a recap checklist";
  return "";
}

export function laneForLegacyIntent(intent: MobileCreationBrief["intent"]): MobileCreationLane {
  const lanes = {
    collect_leads: "lead_magnet",
    teach_practice: "workbook",
    support_clients: "client_tool",
    explain_offer: "offer_guide",
    short_story: "adult_story",
    unspecified: "auto"
  } as const satisfies Record<MobileCreationBrief["intent"], MobileCreationLane>;
  return lanes[intent];
}

export function laneFromBookTypeChoice(choice: MobileBookTypeChoice | undefined): MobileCreationLane | undefined {
  if (!choice || choice === "auto") {
    return undefined;
  }
  if (choice === "short_story") {
    return "adult_story";
  }
  return choice;
}

export function laneFromProductBookType(bookType: MobileCreationPresets["bookType"]): MobileCreationLane {
  if (bookType === "workbook") {
    return "workbook";
  }
  if (bookType === "short_story") {
    return "adult_story";
  }
  return "lead_magnet";
}

export function productBookTypeForLane(lane: MobileCreationLane): MobileCreationPresets["bookType"] {
  if (lane === "workbook" || lane === "client_tool") {
    return "workbook";
  }
  if (lane === "adult_story" || lane === "children_story") {
    return "short_story";
  }
  return "lead_magnet";
}

export function intentForLane(lane: MobileCreationLane): MobileCreationBrief["intent"] {
  if (lane === "auto") return "unspecified";
  if (lane === "workbook") return "teach_practice";
  if (lane === "client_tool") return "support_clients";
  if (lane === "offer_guide") return "explain_offer";
  if (lane === "adult_story" || lane === "children_story") return "short_story";
  return "collect_leads";
}

export function laneLabel(lane: MobileCreationLane): string {
  return {
    auto: "Auto",
    children_story: "Children's story",
    adult_story: "Short story",
    workbook: "Workbook",
    client_tool: "Client tool",
    offer_guide: "Offer guide",
    lead_magnet: "Lead magnet",
    practical_guide: "Practical guide"
  }[lane];
}

export function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

export function looksFactualOrCurrent(value: string): boolean {
  return /\b(research|study|studies|statistics|current|recent|latest|medical|legal|financial|law|health|science|evidence)\b/i.test(value);
}
