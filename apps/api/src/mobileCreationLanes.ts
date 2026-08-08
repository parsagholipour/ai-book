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

export function audienceFor(rawIdea: string, lane: MobileCreationLane): string {
  const age = rawIdea.match(/\b([2-9]|10|11|12)\s*(-| )?(year|yr)s?\s*olds?\b/i)?.[0];
  if (age) {
    return age.replace(/\s+/g, " ");
  }
  const forMatch = rawIdea.match(/\bfor\s+([^,.!?;]+)/i)?.[1]?.trim();
  if (forMatch) {
    return forMatch;
  }
  return audienceFallback(lane);
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

export function titleFromIdea(rawIdea: string, lane: MobileCreationLane): string {
  const cleaned = cleanTitlePart(rawIdea);
  if (cleaned) {
    return cleaned;
  }
  return fallbackTopic(lane === "workbook" || lane === "client_tool" ? "workbook" : lane.includes("story") ? "short_story" : "lead_magnet");
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

export function promiseFallback(rawIdea: string, lane: MobileCreationLane): string {
  if (lane === "auto") return `become the best-fitting book for ${cleanTitlePart(rawIdea).toLowerCase() || "the idea"}`;
  if (lane === "children_story") return "a gentle story children can follow and enjoy";
  if (lane === "adult_story") return "a compact story with a clear emotional turn";
  if (lane === "workbook" || lane === "client_tool") return "complete useful practice and leave with a next step";
  if (lane === "offer_guide") return "understand the offer and decide what to do next";
  return `get a useful first step for ${cleanTitlePart(rawIdea).toLowerCase() || "the topic"}`;
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
    short_story: "adult_story"
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

export function cleanTitlePart(value: string): string {
  const cleaned = value
    .replace(/^create\s+(an?|the)?\s*/i, "")
    .replace(/\b(book|ebook|guide|workbook|story|lead magnet|bedtime)\b/gi, "")
    .replace(/\bfor\s+([2-9]|10|11|12)\s*(-| )?(year|yr)s?\s*olds?\b/gi, "")
    .replace(/\bfor\s+[^,.!?;]+/i, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned
    .split(/\s+/)
    .slice(0, 6)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function fallbackTopic(bookType: MobileCreationPresets["bookType"]): string {
  return bookType === "workbook" ? "Practice" : bookType === "short_story" ? "Moon Garden" : "Starter";
}
