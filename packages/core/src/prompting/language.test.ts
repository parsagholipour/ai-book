import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter, unsupportedGenerateWithTools } from "../adapters/fake.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "../adapters/types.js";
import {
  detectPromptLanguage,
  explicitLanguageRequest,
  normalizeProjectLanguage,
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "./language.js";

describe("explicitLanguageRequest", () => {
  it("reads an explicit request to write the book in a language", () => {
    expect(explicitLanguageRequest("Write it in Spanish")).toBe("es");
    expect(explicitLanguageRequest("write the book in Persian please")).toBe("fa");
    expect(explicitLanguageRequest("Please write the whole book in German")).toBe("de");
    expect(explicitLanguageRequest("translate it into French")).toBe("fr");
    expect(explicitLanguageRequest("Can you make the book in Japanese?")).toBe("ja");
    expect(explicitLanguageRequest("I want the book in Chinese")).toBe("zh");
    expect(explicitLanguageRequest("I'd like the whole thing written in Russian")).toBe("ru");
    expect(explicitLanguageRequest("rewrite the pages in Arabic")).toBe("ar");
    expect(explicitLanguageRequest("language: German")).toBe("de");
    expect(explicitLanguageRequest("the language should be Italian")).toBe("it");
    expect(explicitLanguageRequest("set the language to Korean")).toBe("ko");
    expect(explicitLanguageRequest("use Japanese")).toBe("ja");
    expect(explicitLanguageRequest("in Spanish please")).toBe("es");
    expect(explicitLanguageRequest("In Portuguese, thanks")).toBe("pt");
  });

  // A language name is overwhelmingly more often the subject than the
  // instruction. Reading "aliens in Chinese media" as a request once wrote a
  // whole book in Chinese for a reader who only ever chatted in English.
  it("ignores a language named as subject matter", () => {
    expect(explicitLanguageRequest("Just write a book about aliens in Chinese media")).toBeUndefined();
    expect(
      explicitLanguageRequest("An informative guide to aliens in Chinese films, TV, and literature")
    ).toBeUndefined();
    expect(explicitLanguageRequest("a book about growing up in Italian villages")).toBeUndefined();
    expect(explicitLanguageRequest("a history of jazz in French colonial Africa")).toBeUndefined();
    expect(explicitLanguageRequest("make it about samurai in Japanese history")).toBeUndefined();
    expect(explicitLanguageRequest("write a story set in Japanese-occupied Korea")).toBeUndefined();
    expect(explicitLanguageRequest("a novel about a girl in Italian Renaissance Florence")).toBeUndefined();
    expect(explicitLanguageRequest("Explain the differences in German and Dutch grammar")).toBeUndefined();
    expect(
      explicitLanguageRequest("create a book on the rise of anime in Japanese pop culture")
    ).toBeUndefined();
    expect(explicitLanguageRequest("a novel set in Persian Gulf oil towns")).toBeUndefined();
    expect(explicitLanguageRequest("a guide to learning Spanish")).toBeUndefined();
    expect(explicitLanguageRequest("A bedtime story about a fox")).toBeUndefined();
  });

  // A name inside a list is naming a subject, not choosing one of several books.
  it("ignores a language that is one item of a list", () => {
    expect(
      explicitLanguageRequest("a guide to travel in Spanish, French, and German cities")
    ).toBeUndefined();
    expect(
      explicitLanguageRequest("a book about food in Japanese, Korean, and Thai cuisine")
    ).toBeUndefined();
    expect(explicitLanguageRequest("compare recipes in Italian and French cooking")).toBeUndefined();
  });

  it("lets an explicit English request undo a wrong language", () => {
    expect(explicitLanguageRequest("actually write it in English")).toBe("en");
    expect(targetLanguageGenerationGuidance(explicitLanguageRequest("write it in English"))).toEqual([]);
  });
});

describe("prompt language helpers", () => {
  it("keeps English as the default no-op language", async () => {
    await expect(
      detectPromptLanguage(new FakeTextModelAdapter(), "A practical book about community gardens.")
    ).resolves.toBe("en");

    expect(normalizeProjectLanguage("English")).toBe("en");
    expect(targetLanguageGenerationGuidance("en")).toEqual([]);
    expect(targetLanguagePayload("en")).toBeUndefined();
  });

  it("detects and names non-English prompt languages", async () => {
    await expect(
      detectPromptLanguage(new FakeTextModelAdapter(), "یک کتاب کودکانه درباره ماه و قصه‌های شبانه.")
    ).resolves.toBe("Persian");

    expect(targetLanguageGenerationGuidance("fa").join(" ")).toContain("Persian");
    expect(targetLanguagePayload("Persian")).toEqual({ targetLanguage: "Persian" });
  });

  it("accepts detector responses that omit the optional language code", async () => {
    await expect(
      detectPromptLanguage(new LanguageOnlyDetectorAdapter("Persian"), "یک کتاب کودکانه درباره ماه.")
    ).resolves.toBe("Persian");
  });
});

class LanguageOnlyDetectorAdapter implements TextModelAdapter {
  constructor(private readonly language: string) {}

  async generateText(): Promise<TextResult> {
    return { text: this.language, model: "test-model", provider: "test" };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>) {
    const data = options.schema.parse({ language: this.language });
    return {
      data,
      text: JSON.stringify(data),
      model: "test-model",
      provider: "test"
    };
  }

  async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
    yield this.language;
  }

  generateWithTools(): Promise<ToolCallsResult> {
    return unsupportedGenerateWithTools();
  }
}
