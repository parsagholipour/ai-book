import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GenerationModelRoutingSection,
  generationModelRoutingClaim,
  rebaseGenerationModelRouting
} from "./GenerationModelRouting.js";
import type { GenerationTextModelOption, GenerationTextModelRouting } from "@book-maker/core/generationTextModelRouting";

describe("GenerationModelRoutingSection", () => {
  it("renders all nine model selectors and only capability-backed effort selectors", () => {
    const markup = renderToStaticMarkup(
      createElement(GenerationModelRoutingSection, {
        models: routing(),
        options: catalog(),
        disabled: true,
        onChange: () => undefined
      })
    );

    for (const label of [
      "Fast judgments",
      "Quick Writer",
      "Quick Judgment",
      "Balanced Writer",
      "Balanced Judgment",
      "Premium Writer",
      "Premium Judgment",
      "Ultra Writer",
      "Ultra Judgment"
    ]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toContain('aria-label="Balanced Writer Effort"');
    expect(markup).toContain('aria-label="Fast judgments Effort"');
    expect(markup).not.toContain('aria-label="Premium Writer Effort"');
    expect(markup).not.toContain("Saved provider credentials are unavailable.");
    expect(markup.match(/<select/g)).toHaveLength(14);
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(14);
  });

  it("keeps an unavailable saved choice visible as a disabled warning", () => {
    const models = routing();
    models.ultra.writer = { provider: "gemini", model: "removed-model" };
    const markup = renderToStaticMarkup(
      createElement(GenerationModelRoutingSection, {
        models,
        options: catalog().filter((option) => option.provider !== "gemini"),
        disabled: false,
        onChange: () => undefined
      })
    );

    expect(markup).toContain("gemini/removed-model (unavailable)");
    expect(markup).toContain("Saved provider credentials are unavailable.");
  });
});

describe("model routing claims and rebasing", () => {
  it("submits only changed role leaves", () => {
    const stored = routing();
    const draft = routing();
    draft.balanced.writer = { ...draft.balanced.writer, thinkingEffort: "high" };
    draft.ultra.judgment = { provider: "deepseek", model: "deepseek-fast", thinkingEnabled: false };

    expect(generationModelRoutingClaim(stored, draft)).toEqual({
      balanced: { writer: { thinkingEffort: "high" } },
      ultra: {
        judgment: {
          provider: "deepseek",
          model: "deepseek-fast",
          thinkingEnabled: false
        }
      }
    });
  });

  it("rebases untouched leaves from the head and preserves unsaved role edits", () => {
    const loaded = routing();
    const draft = routing();
    draft.premium.writer = { provider: "deepseek", model: "deepseek-pro", thinkingEffort: "high" };
    const head = routing();
    head.balanced.judgment = { provider: "alibaba", model: "qwen-plus" };

    const rebased = rebaseGenerationModelRouting(head, loaded, draft);

    expect(rebased.premium.writer).toEqual(draft.premium.writer);
    expect(rebased.balanced.judgment).toEqual(head.balanced.judgment);
    expect(generationModelRoutingClaim(head, rebased)).toEqual({
      premium: {
        writer: { provider: "deepseek", model: "deepseek-pro", thinkingEffort: "high" }
      }
    });
  });
});

function routing(): GenerationTextModelRouting {
  const fast = { provider: "deepseek" as const, model: "deepseek-fast", thinkingEnabled: false };
  return {
    fastJudgments: { ...fast },
    fast: { writer: { ...fast }, judgment: { ...fast } },
    balanced: {
      writer: { provider: "deepseek", model: "deepseek-pro" },
      judgment: { ...fast }
    },
    premium: {
      writer: { provider: "gemini", model: "gemini-pro", thinkingBudget: 2048 },
      judgment: { provider: "gemini", model: "gemini-flash", thinkingBudget: 0 }
    },
    ultra: {
      writer: { provider: "gemini", model: "gemini-pro", thinkingBudget: 2048 },
      judgment: { provider: "gemini", model: "gemini-flash", thinkingBudget: 0 }
    }
  };
}

function catalog(): GenerationTextModelOption[] {
  return [
    {
      provider: "deepseek",
      model: "deepseek-pro",
      label: "DeepSeek Pro",
      thinkingEfforts: [
        { value: "none", label: "Off", default: true },
        { value: "high", label: "High" }
      ]
    },
    {
      provider: "deepseek",
      model: "deepseek-fast",
      label: "DeepSeek Fast",
      thinkingEfforts: [
        { value: "none", label: "Off", default: true },
        { value: "high", label: "High" }
      ]
    },
    { provider: "gemini", model: "gemini-pro", label: "Gemini Pro", thinkingBudget: 2048 },
    { provider: "gemini", model: "gemini-flash", label: "Gemini Flash", thinkingBudget: 0 },
    { provider: "alibaba", model: "qwen-plus", label: "Qwen Plus" }
  ];
}
