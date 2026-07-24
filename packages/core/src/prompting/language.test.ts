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
  normalizeProjectLanguage,
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "./language.js";

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
