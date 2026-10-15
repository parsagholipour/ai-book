import { describe, expect, it } from "vitest";
import { bookMatterChatAnswerSchema } from "@book-maker/core";
import { decideActionSchema } from "../bookEditRouterPrompt.js";
import { busyEditMessage } from "./bookEditBusyCopy.js";
import { matterChatLanguage } from "./bookMatterChatLanguage.js";
import { localizedMatterChatReplies } from "./bookMatterChatReplies.js";
import { TOMEZA_CREDIT_CHAT_COPY } from "./tomezaCreditChatCopy.js";

// These are supported by the app's language picker, independently of the
// smaller set with deterministic matter-request grammars.
const languages = ["da", "nl", "el", "he", "no", "pl", "sv", "th", "uk", "vi"] as const;

describe("conversation languages outside the matter grammar inventory", () => {
  it.each(languages)("keeps %s through both model schemas and saved history", (responseLanguage) => {
    const decision = decideActionSchema(["answer"]).parse({
      action: "answer", confidence: 0.9, reasoning: "Question about the book", assistantMessage: "Reply", responseLanguage
    });
    expect(decision.responseLanguage).toBe(responseLanguage);
    expect(bookMatterChatAnswerSchema.parse({ outcome: "none", responseLanguage }).responseLanguage).toBe(responseLanguage);
    expect(matterChatLanguage(responseLanguage)).toBe(responseLanguage);
    expect(matterChatLanguage(undefined, [{ role: "ASSISTANT", metadata: { replyLanguage: responseLanguage } }])).toBe(responseLanguage);
    expect(matterChatLanguage("xx", [{ role: "ASSISTANT", metadata: { intent: decision } }])).toBe(responseLanguage);
  });

  it.each(languages)("can explain a refusal, outage, credit outcome and saved busy edit in %s", (selected) => {
    const language = matterChatLanguage(selected);
    expect(language).toBe(selected);
    if (language === "en") throw new Error("The selected conversation language was lost");
    const replies = localizedMatterChatReplies(language);
    expect(replies.problem({ kind: "not_given", field: "aboutAuthor" }, false).length).toBeGreaterThan(20);
    expect(replies.text("failed").length).toBeGreaterThan(20);
    const credit = Object.values(TOMEZA_CREDIT_CHAT_COPY[language]);
    expect(new Set(credit).size).toBe(6);
    expect(credit.every((reply) => reply.length > 20 && !reply.includes("Made with Tomeza"))).toBe(true);
    for (const execute of [true, false]) {
      const busy = busyEditMessage(language, execute);
      expect(busy).toContain("apply it");
      expect(busy).not.toBe(busyEditMessage("en", execute));
    }
  });
});
