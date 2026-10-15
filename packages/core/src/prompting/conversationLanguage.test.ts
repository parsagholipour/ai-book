import { describe, expect, it } from "vitest";
import { bookMatterChatAnswerSchema, bookMatterChatMessages } from "../authoring/bookMatterChatEdit.js";
import { CONVERSATION_LANGUAGES } from "./conversationLanguage.js";

describe("the matter composer speaks every supported conversation language", () => {
  it.each(CONVERSATION_LANGUAGES)("keeps %s in the model answer and follow-up context", (responseLanguage) => {
    const parsed = bookMatterChatAnswerSchema.parse({ outcome: "question", responseLanguage, question: "Which name?" });
    expect(parsed.responseLanguage).toBe(responseLanguage);
    const messages = bookMatterChatMessages({
      message: "김민수", conversationLanguage: responseLanguage, bookLanguage: "english",
      current: { authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null, copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false }
    });
    expect(messages[0]!.content).toContain(CONVERSATION_LANGUAGES.join(", "));
    expect(JSON.parse(messages.at(-1)!.content).conversationLanguage).toBe(responseLanguage);
  });
});
