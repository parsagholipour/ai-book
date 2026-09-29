import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "@book-maker/core";
import { assertCreationBookLanguage, resolveCreationBookLanguage } from "./mobileCreationLanguage.js";

describe("creation book language", () => {
  it("isolates user-authored language evidence from assistant guesses and the generated brief", async () => {
    const model = new FakeTextModelAdapter();
    const generate = vi.spyOn(model, "generateJson");
    const language = await resolveCreationBookLanguage(model, {
      messages: [
        { role: "user", content: "A romance about Neymar and a waitress" },
        { role: "assistant", content: "I'll write it in Portuguese unless you'd rather another language." }
      ]
    });
    expect(language).toBe("en");
    const payload = JSON.parse(generate.mock.calls[0]![0].messages[1]!.content);
    expect(payload).toEqual({
      currentBookLanguage: null,
      prompt: "A romance about Neymar and a waitress",
      recentUserMessages: ["A romance about Neymar and a waitress"]
    });
  });

  it("compares equivalent names and codes while rejecting a different language", () => {
    expect(() => assertCreationBookLanguage("English", "en")).not.toThrow();
    expect(() => assertCreationBookLanguage("Portuguese", "pt")).not.toThrow();
    expect(() => assertCreationBookLanguage("pt-BR", "pt-br")).not.toThrow();
    expect(() => assertCreationBookLanguage(undefined, "pt")).not.toThrow();
    expect(() => assertCreationBookLanguage("pt", "en")).toThrow("English");
  });
});
