import { z } from "zod";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { generateJsonWithRetry } from "../generation/generateJsonWithRetry.js";
import { unsupportedGenerateWithTools } from "./fake.js";
import {
  LiveGenerationTextModelAdapter,
  elevatedThinkingSelection,
  generationTextModelOptions,
  modelTierTextFallbackSelectionForRole
} from "./factory.js";
import {
  compiledGenerationTextModelRouting,
  generationTextModelOptionKey,
  resolveGenerationTextModelRouting,
  type GenerationTextModelRouting
} from "./generationTextModelRouting.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult
} from "./types.js";

describe("generation text model routing", () => {
  it("reproduces all nine historical defaults and resolves legacy revisions", () => {
    const config = testConfig({});
    const defaults = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));

    expect(defaults).toEqual({
      fastJudgments: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
      fast: {
        writer: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false },
        judgment: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false }
      },
      balanced: {
        writer: { provider: "deepseek", model: "deepseek-v4-pro" },
        judgment: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false }
      },
      premium: {
        writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        judgment: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 }
      },
      ultra: {
        writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        judgment: { provider: "gemini", model: "gemini-2.5-flash", thinkingBudget: 0 }
      }
    });
    expect(resolveGenerationTextModelRouting({ planCritic: ["premium"] }, defaults)).toEqual(defaults);
  });

  it("uses the next configured catalog option when a default provider is unavailable", () => {
    const config = testConfig({ DEEPSEEK_API_KEY: "", GEMINI_API_KEY: "" });
    const defaults = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));

    expect(defaults.fastJudgments.provider).toBe("deepinfra");
    expect(defaults.balanced.writer.provider).toBe("deepinfra");
    expect(defaults.premium.writer.provider).toBe("deepinfra");
  });

  it("uses Gemini flash-lite with thinkingBudget 0 when DeepSeek and DeepInfra are unavailable", () => {
    const config = testConfig({ DEEPSEEK_API_KEY: "", DEEPINFRA_API_KEY: "" });
    const defaults = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));
    const flashLite = { provider: "gemini", model: "gemini-2.5-flash-lite", thinkingBudget: 0 };

    expect(defaults.fastJudgments).toEqual(flashLite);
    expect(defaults.fast.writer).toEqual(flashLite);
    expect(defaults.fast.judgment).toEqual(flashLite);
  });

  it("matches catalog flash-lite to compiled FAST_GEMINI when only Gemini is configured", () => {
    const config = testConfig({ DEEPSEEK_API_KEY: "", DEEPINFRA_API_KEY: "", ALIBABA_API_KEY: "" });
    const options = generationTextModelOptions(config);
    const defaults = compiledGenerationTextModelRouting(config, options);
    const catalogFlashLite = options.find(
      (option) => option.provider === "gemini" && option.model === "gemini-2.5-flash-lite"
    );
    if (!catalogFlashLite) {
      throw new Error("expected gemini-2.5-flash-lite in the generation catalog");
    }

    expect(catalogFlashLite).toMatchObject({ thinkingBudget: 0 });
    expect(generationTextModelOptionKey(catalogFlashLite)).toBe(
      generationTextModelOptionKey(defaults.fastJudgments)
    );
  });

  it("preserves numeric budgets, elevates supported efforts, and adds no unsupported reasoning", () => {
    const options = generationTextModelOptions(testConfig({}));
    expect(
      elevatedThinkingSelection(
        { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        "ultra",
        "plan-book",
        options
      ).thinkingBudget
    ).toBe(8192);
    expect(
      elevatedThinkingSelection(
        { provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Pro", thinkingEffort: "low" },
        "premium",
        "plan-book",
        options
      ).thinkingEffort
    ).toBe("high");
    expect(
      elevatedThinkingSelection(
        { provider: "alibaba", model: "qwen-plus" },
        "ultra",
        "plan-book",
        options
      )
    ).toEqual({ provider: "alibaba", model: "qwen-plus" });
  });

  it("lets consecutive calls see revisions while a repair retry stays bound", async () => {
    const config = testConfig({});
    let routing = routingWithBalancedWriter("writer-one");
    const calls: string[] = [];
    const live = new LiveGenerationTextModelAdapter(config, {
      tier: "balanced",
      loadRouting: async () => routing,
      createAdapter: (selection) => new RevisionAdapter(
        selection.model,
        calls,
        selection.model === "writer-one"
          ? () => { routing = routingWithBalancedWriter("writer-two"); }
          : undefined
      )
    });
    const schema = z.object({ ok: z.boolean() });

    const first = await generateJsonWithRetry(live, {
      purpose: "generate-page",
      messages: [],
      schema,
      repairAttempts: 1
    });
    const second = await generateJsonWithRetry(live, {
      purpose: "generate-page",
      messages: [],
      schema,
      repairAttempts: 0
    });

    expect(first.model).toBe("writer-one");
    expect(second.model).toBe("writer-two");
    expect(calls).toEqual(["writer-one", "writer-one", "writer-two"]);
  });

  it("routes mechanical and unknown purposes to Judgment and Writer respectively", async () => {
    const config = testConfig({});
    const calls: string[] = [];
    const live = new LiveGenerationTextModelAdapter(config, {
      tier: "balanced",
      loadRouting: async () => routingWithBalancedWriter("writer"),
      createAdapter: (selection) => new RevisionAdapter(selection.model, calls)
    });

    await live.generateText({ messages: [], purpose: "review-page" });
    await live.generateText({ messages: [], purpose: "future-prose" });

    expect(calls).toEqual(["judgment", "writer"]);
  });

  it("routes inline API purposes through Fast judgments", async () => {
    const config = testConfig({});
    const calls: string[] = [];
    const routing = routingWithBalancedWriter("tier-writer");
    routing.fastJudgments = { provider: "deepseek", model: "inline-fast" };
    const live = new LiveGenerationTextModelAdapter(config, {
      fastJudgments: true,
      loadRouting: async () => routing,
      createAdapter: (selection) => new RevisionAdapter(selection.model, calls)
    });

    await live.generateText({ messages: [], purpose: "mobile-language-detection" });
    await live.generateText({ messages: [], purpose: "review-page" });

    expect(calls).toEqual(["inline-fast", "inline-fast"]);
  });

  it("throws at construction when MOCK_AI is off and no text provider is configured", () => {
    const empty = {
      DEEPSEEK_API_KEY: "",
      DEEPINFRA_API_KEY: "",
      GEMINI_API_KEY: "",
      ALIBABA_API_KEY: "",
      MOCK_AI: "false"
    };
    expect(
      () =>
        new LiveGenerationTextModelAdapter(testConfig({ ...empty, MOCK_AI: "false" }), {
          fastJudgments: true,
          loadRouting: async () => routingWithBalancedWriter("unused")
        })
    ).toThrow("A text model API key is required when MOCK_AI=false.");
    expect(
      () =>
        new LiveGenerationTextModelAdapter(testConfig({ ...empty, MOCK_AI: "true" }), {
          fastJudgments: true,
          loadRouting: async () => routingWithBalancedWriter("unused")
        })
    ).not.toThrow();
  });

  it("chooses Gemini failover by Writer versus Judgment role", () => {
    const config = testConfig({});
    expect(modelTierTextFallbackSelectionForRole("writer", config)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro"
    });
    expect(modelTierTextFallbackSelectionForRole("judgment", config)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingEnabled: false
    });
  });
});

class RevisionAdapter implements TextModelAdapter {
  private attempts = 0;
  constructor(
    private readonly model: string,
    private readonly calls: string[],
    private readonly moveRevision?: (() => void) | undefined
  ) {}
  async generateText(_options: GenerateTextOptions): Promise<TextResult> {
    this.calls.push(this.model);
    return { text: this.model, provider: "test", model: this.model };
  }
  async generateJson<T>(_options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    this.calls.push(this.model);
    this.attempts += 1;
    if (this.moveRevision && this.attempts === 1) {
      this.moveRevision();
      throw new SyntaxError("invalid JSON");
    }
    return { text: '{"ok":true}', data: { ok: true } as T, provider: "test", model: this.model };
  }
  async *streamText() { yield this.model; }
  generateWithTools() { return unsupportedGenerateWithTools(); }
}

function routingWithBalancedWriter(model: string): GenerationTextModelRouting {
  const fast = { provider: "deepseek" as const, model: "fast" };
  return {
    fastJudgments: fast,
    fast: { writer: fast, judgment: fast },
    balanced: {
      writer: { provider: "deepseek", model },
      judgment: { provider: "deepseek", model: "judgment" }
    },
    premium: { writer: fast, judgment: fast },
    ultra: { writer: fast, judgment: fast }
  };
}

function testConfig(overrides: NodeJS.ProcessEnv) {
  return loadConfig({
    DEEPSEEK_API_KEY: "deepseek-key",
    DEEPINFRA_API_KEY: "deepinfra-key",
    GEMINI_API_KEY: "gemini-key",
    ALIBABA_API_KEY: "alibaba-key",
    MOCK_AI: "false",
    ...overrides
  });
}
