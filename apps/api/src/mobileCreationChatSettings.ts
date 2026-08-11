import { explicitLanguageRequest, LANGUAGE_NAME_CODES } from "@book-maker/core";
import type {
  MobileBookTypeChoice,
  MobileCreationMessage,
  MobileCreationMessageAttachment
} from "./mobileCreationSchemas.js";

/**
 * Model-free reading of a creation-chat message: build requests, capability
 * questions, explicit setting changes and script-based language detection.
 * Split out of mobileCreation.ts, which re-exports the public pieces so the
 * `./mobileCreation.js` surface is unchanged.
 */

export function isBuildRequestMessage(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/^(ok|okay|yes|yeah|alright|great|perfect|sounds good|looks good)[,.\s]*/i, "")
    .trim();
  if (!normalized) {
    return false;
  }
  return (
    /^(?:just\s+)?(?:build|make|create|generate|start|do)\s+(?:it|the\s+(?:plan|book)|my\s+book|this)(?:\s+now)?$/i.test(normalized) ||
    /^(?:build|make)\s+the\s+plan\b/i.test(normalized) ||
    /^(?:go\s+ahead|let'?s\s+(?:go|build|do\s+it|start)|start\s+building|i'?m\s+ready|ready\s+to\s+build)$/i.test(normalized)
  );
}

/** Deterministic grounded answers for common capability/process questions. */
export function metaAnswerForMessage(message: string): string | null {
  const text = message.toLowerCase().trim();
  if (!text || text.length > 400) {
    return null;
  }
  const asksQuestion = /\?|^(what|how|can|do|does|is|are|will|when|where|which)\b/i.test(text);
  if (!asksQuestion) {
    return null;
  }
  if (/\b(cost|price|credit|charge|pay|free)\b/.test(text)) {
    return "Building a plan and generating the book use credits from your balance, and you always see the exact amount before anything is charged. Reading and chatting here are free.";
  }
  if (/\b(upload|attach|send|share|give)\b.*\b(photo|image|picture|file|document|pdf|docx?|word|epub|notes?)s?\b/.test(text) ||
      /\b(can|how)\b.*\b(upload|attach)\b/.test(text)) {
    return "Yes - tap the paperclip to attach photos or documents (PDF, Word, EPUB, or plain text). I'll read them and use them as source material or instructions for your book.";
  }
  if (/\b(formats?|pdf|epub|downloads?|exports?|files?)\b/.test(text)) {
    return "You get your finished book as PDF and EPUB downloads, ready to share or publish.";
  }
  if (/\bhow long\b|\btake\b.*\b(time|minutes|long)\b|\bhow (?:fast|quick)\b/.test(text)) {
    return "Planning takes a couple of minutes, and writing the full book usually takes several more depending on length. You can watch progress live.";
  }
  if (/\b(language|languages|farsi|persian|spanish|french|german|arabic|translate)\b/.test(text)) {
    return "Yes - I can write your book in almost any language. Just chat in your language or tell me which one to use.";
  }
  if (/\b(how (?:do|does) (?:this|it) work|what can you do|what do you do|what is this)\b/.test(text)) {
    return "Tell me your book idea and I'll shape it into a plan you can review. Once you approve it, I write the full book with visuals and give you PDF and EPUB downloads. You can keep editing by chat afterwards.";
  }
  if (/\b(picture|image|images|illustration|visual|cover)s?\b/.test(text) && /\b(can|do|does|will|add|include|without|no)\b/.test(text)) {
    return "Yes - you can have AI cover art, in-book illustrations, both, or neither. They are separate choices, and every book gets a cover either way: turn the AI cover art off and I pick a designed cover to match your book, free.";
  }
  if (/\b(edit|change|fix|revise|rewrite|undo)\b/.test(text) && /\b(after|later|once|when|can)\b/.test(text)) {
    return "After your book is generated you can keep chatting to fix wording, rewrite pages or chapters, undo the last edit, or rebuild the whole book.";
  }
  return null;
}

export type ChatSettingChanges = {
  /** @deprecated Broad all-images compatibility setting. */
  imagesEnabled?: boolean;
  coverEnabled?: boolean;
  illustrationsEnabled?: boolean;
  bookTypeChoice?: MobileBookTypeChoice;
  tone?: string;
  language?: string;
};

/** Parses explicit setting changes ("no illustrations", "no cover") from the latest message. */
export function chatSettingChangesFromMessage(message: string): ChatSettingChanges {
  const changes: ChatSettingChanges = {};
  const text = message.trim();
  if (!text) {
    return changes;
  }
  const off = String.raw`(?:no|without|skip|remove|disable|turn\s+off|don'?t\s+(?:want|need|add|include))`;
  const on = String.raw`(?:add|include|enable|turn\s+on|with|want|keep|use)`;
  const broadImages = String.raw`(?:images?|pictures?|visuals?|artwork)`;
  const illustrations = String.raw`(?:in[- ]?book\s+|interior\s+)?(?:illustrations?|pictures?|visuals?)`;
  const explicitToggle = (target: string): boolean | undefined => {
    const lastMatchIndex = (pattern: RegExp): number => {
      let last = -1;
      for (const match of text.matchAll(pattern)) {
        last = match.index;
      }
      return last;
    };
    const offIndex = lastMatchIndex(new RegExp(`\\b${off}\\b.{0,40}\\b${target}\\b`, "gi"));
    const onIndex = lastMatchIndex(new RegExp(`\\b${on}\\b.{0,40}\\b${target}\\b`, "gi"));
    if (offIndex < 0 && onIndex < 0) {
      return undefined;
    }
    return onIndex > offIndex;
  };

  const broadChoice = explicitToggle(broadImages);
  if (broadChoice !== undefined) {
    changes.imagesEnabled = broadChoice;
    changes.coverEnabled = broadChoice;
    changes.illustrationsEnabled = broadChoice;
  }

  const illustrationChoice = explicitToggle(illustrations);
  if (illustrationChoice !== undefined) {
    changes.illustrationsEnabled = illustrationChoice;
  } else if (/\btext[- ]?(?:only|first)\b/i.test(text)) {
    changes.illustrationsEnabled = false;
  }

  const coverChoice = explicitToggle(String.raw`covers?`);
  if (coverChoice !== undefined) {
    changes.coverEnabled = coverChoice;
  } else if (/\bcovers?\b.{0,20}\bbut\b.{0,40}\b(?:no|without)\b/i.test(text)) {
    changes.coverEnabled = true;
  }
  const explicitType = explicitBookTypeChoiceFromText(text);
  if (explicitType) {
    changes.bookTypeChoice = explicitType;
  }
  const toneMatch = text.match(/\b(?:make\s+(?:it|the\s+tone)|tone\s+(?:should\s+be|is|:)|keep\s+it)\s+(?:more\s+)?(warm|funny|playful|serious|practical|polished|gentle|professional|casual|formal|poetic|dark|cozy|encouraging)\b/i);
  if (toneMatch?.[1]) {
    changes.tone = toneMatch[1].toLowerCase();
  }
  const language = explicitLanguageRequest(text);
  if (language) {
    changes.language = language;
  }
  return changes;
}

function explicitBookTypeChoiceFromText(text: string): MobileBookTypeChoice | undefined {
  const wantsChange =
    /\b(?:make|turn|change|switch|actually|instead|rather|convert)\b/i.test(text) ||
    /\b(?:it|this)\s+(?:should|must)\s+be\b/i.test(text);
  if (!wantsChange) {
    return undefined;
  }
  const candidates: Array<[RegExp, MobileBookTypeChoice]> = [
    [/\b(?:children'?s?|kids?|bedtime)\s+(?:story|book|tale)\b/i, "children_story"],
    [/\bworkbook\b|\bstudy\s+guide\b/i, "workbook"],
    [/\bclient\s+(?:tool|workbook|guide)\b/i, "client_tool"],
    [/\boffer\s+guide\b|\bsales\s+guide\b/i, "offer_guide"],
    [/\blead\s+magnet\b|\bopt[- ]?in\b/i, "lead_magnet"],
    [/\bpractical\s+guide\b|\bhow[- ]?to\s+guide\b/i, "practical_guide"],
    [/\b(?:short\s+story|novel(?:la)?|fiction)\b/i, "short_story"]
  ];
  for (const [pattern, choice] of candidates) {
    if (pattern.test(text)) {
      return choice;
    }
  }
  return undefined;
}

/**
 * Detects the language a message is written in from its script. Latin-script
 * languages return undefined (the AI patch handles those); non-Latin scripts
 * are reliable enough to detect deterministically. An explicit request ("write
 * it in Spanish") wins over the script, so an English speaker can ask for a
 * book in another language — but only when the message really is an
 * instruction, never when it merely names a language as its subject.
 */
export function detectMessageLanguage(message: string): string | undefined {
  const text = message.trim();
  if (!text) {
    return undefined;
  }
  const explicit = explicitLanguageRequest(text);
  if (explicit) {
    return explicit;
  }
  const counts = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  const letters = counts(/\p{L}/gu);
  if (letters < 4) {
    return undefined;
  }
  const threshold = letters * 0.4;
  if (counts(/[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/g) >= 1 && counts(/[\u0600-\u06FF]/g) >= threshold) {
    return "fa";
  }
  if (counts(/[\u0600-\u06FF]/g) >= threshold) {
    return "ar";
  }
  if (counts(/[\u0400-\u04FF]/g) >= threshold) {
    return "ru";
  }
  if (counts(/[\u0590-\u05FF]/g) >= threshold) {
    return "he";
  }
  if (counts(/[\u0370-\u03FF]/g) >= threshold) {
    return "el";
  }
  if (counts(/[\u3040-\u30FF]/g) >= 2) {
    return "ja";
  }
  if (counts(/[\uAC00-\uD7AF]/g) >= threshold) {
    return "ko";
  }
  if (counts(/[\u4E00-\u9FFF]/g) >= threshold) {
    return "zh";
  }
  if (counts(/[\u0E00-\u0E7F]/g) >= threshold) {
    return "th";
  }
  if (counts(/[\u0900-\u097F]/g) >= threshold) {
    return "hi";
  }
  return undefined;
}

export function languageDisplayName(code: string): string {
  for (const [name, value] of Object.entries(LANGUAGE_NAME_CODES)) {
    if (value === code) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
  return code;
}

export function latestUserMessageText(messages: MobileCreationMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      return message.content.trim();
    }
  }
  return "";
}

export function latestUserMessageAttachments(messages: MobileCreationMessage[]): MobileCreationMessageAttachment[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      return message.attachments ?? [];
    }
  }
  return [];
}

/** Human acknowledgement for files that arrived with the latest user message. */
export function attachmentAcknowledgement(attachments: MobileCreationMessageAttachment[]): string | null {
  if (attachments.length === 0) {
    return null;
  }
  if (attachments.length === 1) {
    const attachment = attachments[0]!;
    return attachment.kind === "photo"
      ? `I've looked at ${attachment.name}.`
      : `I've read ${attachment.name} and will use it as source material.`;
  }
  const documents = attachments.filter((attachment) => attachment.kind === "document").length;
  const photos = attachments.length - documents;
  const parts = [
    documents > 0 ? (documents === 1 ? "the document" : `${documents} documents`) : "",
    photos > 0 ? (photos === 1 ? "the photo" : `${photos} photos`) : ""
  ].filter(Boolean);
  return `I've gone through ${parts.join(" and ")} you sent and will use them for the book.`;
}
