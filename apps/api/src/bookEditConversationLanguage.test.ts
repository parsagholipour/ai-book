import { describe, expect, it } from "vitest";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import { fakeDecideModel, pages } from "./testing/bookEditIntentFixtures.js";

describe("conversation language at the router boundary", () => {
  it.each([
    ["he", "על מה הספר?", "הספר עוסק בשועל."],
    ["th", "หนังสือเกี่ยวกับอะไร?", "หนังสือเกี่ยวกับสุนัขจิ้งจอก"],
    ["nl", "Waar gaat het boek over?", "Het boek gaat over een vos."]
  ] as const)("retains %s for ordinary chat independently of matter-request grammar", async (responseLanguage, message, assistantMessage) => {
    const model = fakeDecideModel({
      action: "answer", confidence: 0.9, reasoning: "Answer in the conversation language.", assistantMessage, responseLanguage,
      clarification: "none", pageIndexes: [], chapterIndex: null, targetLanguage: null
    });
    const intent = await classifyProjectChatMessage({
      message, stage: "complete", pages, textModel: model, language: "english", conversationLanguage: responseLanguage
    });
    expect(intent).toMatchObject({ kind: "answer", responseLanguage, assistantMessage });
    const input = JSON.parse(model.generateWithTools.mock.calls[0]![0].messages.at(-1).content);
    expect(input.conversationLanguage).toBe(responseLanguage);
    expect(model.generateWithTools).toHaveBeenCalledOnce();
  });

  it.each(["answer", "clarify", "propose_edit"])("retains the model language on %s decisions", async (action) => {
    const model = fakeDecideModel({
      action, confidence: 0.9, reasoning: "The conversation is Arabic.",
      assistantMessage: "سأحذف هذه العبارة من الكتاب.", responseLanguage: "ar",
      clarification: action === "clarify" ? "scope" : "none",
      pageIndexes: [], chapterIndex: null, targetLanguage: null, editTarget: "tomeza_credit"
    });
    const intent = await classifyProjectChatMessage({
      message: "هل يمكنك حذف عبارة Tomeza؟", stage: "complete", pages, textModel: model
    });

    expect(intent.responseLanguage).toBe("ar");
    expect(intent.kind).toBe(action === "propose_edit" ? "tomeza_credit" : action);
    expect(model.generateWithTools).toHaveBeenCalledOnce();
  });

  it("passes prior conversation language and literal foreign text to the model independently of book language", async () => {
    const model = fakeDecideModel({
      action: "propose_edit", confidence: 0.9, reasoning: "Set the byline in the existing Spanish conversation.",
      assistantMessage: "Cambiaré el nombre del autor.", responseLanguage: "es", clarification: "none",
      pageIndexes: [], chapterIndex: null, targetLanguage: null, editTarget: "book_matter"
    });
    const recentMessages = [
      { role: "user" as const, content: "Pon el nombre del autor" },
      { role: "assistant" as const, content: "¿Qué nombre debe aparecer?" }
    ];
    const intent = await classifyProjectChatMessage({
      message: "김민수", stage: "complete", pages, textModel: model,
      language: "japanese", conversationLanguage: "es", recentMessages
    });

    expect(intent).toMatchObject({ kind: "book_matter", responseLanguage: "es" });
    const input = JSON.parse(model.generateWithTools.mock.calls[0]![0].messages.at(-1).content);
    expect(input).toMatchObject({ userMessage: "김민수", conversationLanguage: "es", recentConversation: recentMessages });
  });

  it("keeps a valid matter decision when the model omits or supplies an unsupported language", async () => {
    for (const responseLanguage of [undefined, "French"]) {
      const model = fakeDecideModel({
        action: "propose_edit", confidence: 0.9, reasoning: "Change the dedication.",
        assistantMessage: "Je vais modifier la dédicace.", clarification: "none",
        pageIndexes: [], chapterIndex: null, targetLanguage: null, editTarget: "book_matter",
        ...(responseLanguage ? { responseLanguage } : {})
      });
      const intent = await classifyProjectChatMessage({
        message: "Change la dédicace pour For Mom", stage: "complete", pages, textModel: model
      });
      expect(intent.kind).toBe("book_matter");
      expect(intent.responseLanguage).toBeUndefined();
      expect(model.generateWithTools).toHaveBeenCalledOnce();
    }
  });
});
