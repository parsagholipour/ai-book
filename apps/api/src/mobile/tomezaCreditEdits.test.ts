import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_LANGUAGES, type ConversationLanguage } from "@book-maker/core";

const removal = vi.hoisted(() => ({ removeTomezaCredit: vi.fn() }));
const chat = vi.hoisted(() => ({ createAssistantChatMessage: vi.fn() }));
vi.mock("./tomezaCredit.js", () => ({
  ...removal,
  TOMEZA_CREDIT_NOT_FINISHED_MESSAGE: "This book isn’t finished yet. On your plan it will be put together without the “Made with Tomeza” line."
}));
vi.mock("./projectChat.js", () => chat);

import { tomezaCreditIntent } from "../bookEditTomezaCredit.js";
import type { MobileProjectChatMessageRecord } from "./dto.js";
import type { ProjectForChat } from "./projectChat.js";
import type { TomezaCreditRemoval } from "./tomezaCredit.js";
import { applyTomezaCreditEdit, tomezaCreditReply } from "./tomezaCreditEdits.js";

const project = {
  id: "project-1", userId: "user-1", status: "COMPLETE", currentPlanId: "plan-1", language: "english"
} as ProjectForChat;
const OUTCOMES = ["reprinted", "not_printed", "subscription_required", "refreshing", "busy", "not_finished"] as const;

function apply(message: string, activeMessages: MobileProjectChatMessageRecord[] = [], responseLanguage?: ConversationLanguage) {
  return applyTomezaCreditEdit({
    project,
    intent: {
      ...tomezaCreditIntent({ confidence: 0.95, reasoning: "Remove the credit", assistantMessage: "I’ll remove the Tomeza line." }),
      ...(responseLanguage ? { responseLanguage } : {})
    },
    userMessageId: "user-message",
    message,
    activeMessages
  });
}

describe("credit-removal replies follow the conversation and the removal outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removal.removeTomezaCredit.mockResolvedValue({ kind: "not_printed" });
    chat.createAssistantChatMessage.mockImplementation(async (data) => ({
      id: "assistant-message", role: "ASSISTANT", operationId: null, createdAt: new Date(), ...data
    }));
  });

  it.each([
    ["reprinted", "فایل‌های خروجی را به‌روز می‌کنم"],
    ["not_printed", "چیزی برای حذف نیست"],
    ["subscription_required", "خرید اعتبار به‌تنهایی کافی نیست"],
    ["refreshing", "اگر عبارت"],
    ["busy", "پس از پایان آن"],
    ["not_finished", "آماده خواهد شد"]
  ] as const)("describes the actual %s outcome in Persian", async (kind, expected) => {
    removal.removeTomezaCredit.mockResolvedValue({ kind });
    const reply = await apply("Tomeza را از کتاب بردار", [], "fa");

    expect(removal.removeTomezaCredit).toHaveBeenCalledWith(project);
    expect(reply.content).toContain(expected);
    expect(reply.metadata).toMatchObject({ charged: false, replyLanguage: "fa" });
    if (kind === "subscription_required") expect(reply.metadata).toHaveProperty("insufficientCredits", {});
    else expect(reply.metadata).not.toHaveProperty("insufficientCredits");
    expect(reply.metadata).not.toHaveProperty("editProposal");
  });

  it("retains saved replyLanguage for a bare follow-up", async () => {
    // The router establishes the first language; metadata preserves it when
    // the later decision has no language hint.
    const first = await apply("بردارش", [], "fa");
    const followUp = await apply("بله", [first]);

    expect(first.metadata).toMatchObject({ replyLanguage: "fa" });
    expect(followUp.metadata).toMatchObject({ replyLanguage: "fa" });
    expect(followUp.content).toBe(first.content);
  });

  it.each(["he", "th", "nl"] as const)("keeps %s in the committed reply and the next bare follow-up", async (language) => {
    const first = await apply("Remove the Tomeza line", [], language);
    const followUp = await apply("yes", [first]);
    expect(first.metadata).toMatchObject({ replyLanguage: language });
    expect(followUp.metadata).toMatchObject({ replyLanguage: language });
    expect(first.content).toBe(tomezaCreditReply({ kind: "not_printed" }, language));
    expect(followUp.content).toBe(first.content);
  });

  it("honors an explicit new conversation language ahead of saved metadata", async () => {
    const first = await apply("Tomeza را از کتاب بردار", [], "fa");
    const reply = await apply("Remove the Tomeza credit", [first], "en");

    expect(reply.metadata).toMatchObject({ replyLanguage: "en" });
    expect(reply.content).toBe(tomezaCreditReply({ kind: "not_printed" }));
  });

  it.each(CONVERSATION_LANGUAGES)("has a distinct price-free reply for every outcome in %s", (language) => {
    const replies = OUTCOMES.map((kind: TomezaCreditRemoval["kind"]) => {
      const content = tomezaCreditReply({ kind }, language);
      expect(content.trim().length).toBeGreaterThan(20);
      expect(content).not.toMatch(/\p{N}/u);
      if (language !== "en") {
        expect(content).not.toBe(tomezaCreditReply({ kind }));
        expect(content).not.toContain("Made with Tomeza");
      }
      return content;
    });
    expect(new Set(replies).size).toBe(OUTCOMES.length);
  });
});
