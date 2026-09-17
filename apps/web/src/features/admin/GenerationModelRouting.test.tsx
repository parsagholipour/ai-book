import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  readGenerationModelRouting,
  applyFastDecisionsPrimaryChange,
  cloneGenerationModelRouting,
  GenerationModelRoutingSection,
  generationModelRoutingClaim,
  readGenerationModelOptions,
  rebaseGenerationModelRouting
} from "./GenerationModelRouting.js";
import type { GenerationTextModelOption, GenerationTextModelRouting } from "@book-maker/core/generationTextModelRouting";

describe("GenerationModelRoutingSection", () => {
  it("renders a primary and fallback for all nine routes with capability-backed effort selectors", () => {
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
      "Fast judgments fallback",
      "Fast decisions",
      "Fast decisions fallback",
      "Quick Writer",
      "Quick Writer fallback",
      "Quick Judgment",
      "Quick Judgment fallback",
      "Balanced Writer",
      "Balanced Writer fallback",
      "Balanced Judgment",
      "Balanced Judgment fallback",
      "Premium Writer",
      "Premium Writer fallback",
      "Premium Judgment",
      "Premium Judgment fallback",
      "Ultra Writer",
      "Ultra Writer fallback",
      "Ultra Judgment",
      "Ultra Judgment fallback"
    ]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toContain('aria-label="Balanced Writer Effort"');
    expect(markup).toContain('aria-label="Fast judgments Effort"');
    expect(markup).not.toContain('aria-label="Fast decisions Effort"');
    expect(markup).not.toContain('aria-label="Premium Writer Effort"');
    expect(markup).not.toContain("Saved provider credentials are unavailable.");
    expect(markup).toContain("Input $0.66–$1.32 · output $1.98–$3.96 / 1M tokens");
    expect(markup.match(/<select/g)).toHaveLength(26);
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(23);
  });

  it("accepts valid rate-card costs and rejects malformed costs from the API", () => {
    expect(readGenerationModelOptions(catalog())).not.toBeNull();
    expect(readGenerationModelOptions([
      { provider: "gemini", model: "gemini-pro", label: "Gemini Pro", costs: [{ inputPerMillion: -1, outputPerMillion: 2 }] }
    ])).toBeNull();
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
    draft.fastJudgmentsFallback = { provider: "deepseek", model: "deepseek-pro" };
    draft.ultra.judgment = { provider: "deepseek", model: "deepseek-fast", thinkingEnabled: false };

    expect(generationModelRoutingClaim(stored, draft)).toEqual({
      fastJudgmentsFallback: { provider: "deepseek", model: "deepseek-pro" },
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
  const fallback = { provider: "alibaba" as const, model: "qwen-plus" };
  return {
    fastJudgments: { ...fast },
    fastJudgmentsFallback: { ...fallback },
    fast: {
      writer: { ...fast },
      writerFallback: { ...fallback },
      judgment: { ...fast },
      judgmentFallback: { ...fallback }
    },
    balanced: {
      writer: { provider: "deepseek", model: "deepseek-pro" },
      writerFallback: { ...fallback },
      judgment: { ...fast },
      judgmentFallback: { ...fallback }
    },
    premium: {
      writer: { provider: "gemini", model: "gemini-pro", thinkingBudget: 2048 },
      writerFallback: { ...fallback },
      judgment: { provider: "gemini", model: "gemini-flash", thinkingBudget: 0 },
      judgmentFallback: { ...fallback }
    },
    ultra: {
      writer: { provider: "gemini", model: "gemini-pro", thinkingBudget: 2048 },
      writerFallback: { ...fallback },
      judgment: { provider: "gemini", model: "gemini-flash", thinkingBudget: 0 },
      judgmentFallback: { ...fallback }
    }
  };
}

function selectMarkup(markup: string, label: string): string {
  const match = markup.match(new RegExp(`<select aria-label="${label}"[^>]*>[\\s\\S]*?</select>`));
  if (!match) throw new Error(`Missing select ${label}`);
  return match[0];
}

function catalog(): GenerationTextModelOption[] {
  return [
    {
      provider: "deepseek",
      model: "deepseek-pro",
      label: "DeepSeek Pro",
      costs: [
        { inputPerMillion: 0.66, outputPerMillion: 1.98, label: "Off-peak" },
        { inputPerMillion: 1.32, outputPerMillion: 3.96, label: "Peak" }
      ],
      thinkingEfforts: [
        { value: "none", label: "Off", default: true },
        { value: "high", label: "High" }
      ]
    },
    {
      provider: "deepseek",
      model: "deepseek-fast",
      label: "DeepSeek Fast",
      costs: [{ inputPerMillion: 0.22, outputPerMillion: 0.66 }],
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

it("selecting Jev from Off pins fallback to current Fast judgments, not a leftover fallback", () => {
  const leftover = { provider: "alibaba" as const, model: "qwen-plus" };
  const models = { ...cloneGenerationModelRouting(routing()), fastDecisions: null, fastDecisionsFallback: leftover };
  expect(models.fastJudgments).not.toEqual(leftover);
  const next = applyFastDecisionsPrimaryChange(models, "jev");
  expect(next.fastDecisions).toEqual({ provider: "vercel-ai-gateway", model: "typesafe-ai/jev" });
  expect(next.fastDecisionsFallback).toEqual(models.fastJudgments);
});

it("round-trips, rebases, and disables a Jev choice without changing text routes", () => {
  const original = routing();
  const jev = { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" } as const;
  const changed = { ...cloneGenerationModelRouting(original), fastDecisions: jev, fastDecisionsFallback: original.fastJudgments };
  expect(readGenerationModelRouting(changed)?.fastDecisions).toEqual(jev);
  expect(generationModelRoutingClaim(original, changed)).toEqual({ fastDecisions: jev });
  expect(generationModelRoutingClaim(original, { ...original, fastDecisionsFallback: { provider: "alibaba", model: "qwen-plus" } })).toBeNull();
  expect(generationModelRoutingClaim(changed, { ...changed, fastDecisionsFallback: { provider: "alibaba", model: "qwen-plus" } })).toEqual({
    fastDecisionsFallback: { provider: "alibaba", model: "qwen-plus" }
  });
  const head = { ...original, fastJudgments: { provider: "alibaba", model: "qwen-plus" } as const };
  const rebased = rebaseGenerationModelRouting(head, original, changed);
  expect(rebased.fastDecisions).toEqual(jev);
  expect(rebased.fastJudgments).toEqual(head.fastJudgments);
  expect(generationModelRoutingClaim(changed, { ...changed, fastDecisions: null })).toEqual({ fastDecisions: null });
  expect(generationModelRoutingClaim(changed, {
    ...changed,
    fastDecisions: null,
    fastDecisionsFallback: { provider: "alibaba", model: "qwen-plus" }
  })).toEqual({ fastDecisions: null });
  expect(readGenerationModelRouting({ ...changed, fastDecisionsFallback: jev })).toBeNull();
  const markup = renderToStaticMarkup(createElement(GenerationModelRoutingSection, { models: changed, options: catalog(), jevAvailable: false, disabled: false, onChange: () => undefined }));
  expect(markup).toContain("Jev · TypeSafe (unavailable)");
  expect(markup).toContain("Use existing judgment routes");
  expect(markup.match(/Jev · TypeSafe/g)).toHaveLength(1);
  expect(selectMarkup(markup, "Fast decisions")).not.toContain("DeepSeek");
  expect(markup).not.toContain('aria-label="Fast decisions Effort"');
});

it("offers only Off or Jev as the Fast decisions primary and keeps the fallback LLM", () => {
  const models = routing();
  const markup = renderToStaticMarkup(createElement(GenerationModelRoutingSection, {
    models,
    options: catalog(),
    jevAvailable: true,
    disabled: false,
    onChange: () => undefined
  }));
  const primary = selectMarkup(markup, "Fast decisions");
  expect(primary).toContain("Use existing judgment routes");
  expect(primary).toContain("Jev · TypeSafe");
  expect(primary).not.toContain("DeepSeek Pro");
  expect(primary).not.toContain("DeepSeek Fast");
  expect(primary).not.toContain("Gemini Pro");
  expect(markup).not.toContain('aria-label="Fast decisions Effort"');
  const fallbackOff = selectMarkup(markup, "Fast decisions fallback");
  expect(fallbackOff).toContain("DeepSeek Fast");
  expect(fallbackOff.match(/<select aria-label="Fast decisions fallback"[^>]*>/)?.[0]).toContain("disabled");
  const jevMarkup = renderToStaticMarkup(createElement(GenerationModelRoutingSection, {
    models: { ...cloneGenerationModelRouting(models), fastDecisions: { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" } },
    options: catalog(),
    jevAvailable: true,
    disabled: false,
    onChange: () => undefined
  }));
  expect(selectMarkup(jevMarkup, "Fast decisions fallback").match(/<select aria-label="Fast decisions fallback"[^>]*>/)?.[0]).not.toContain("disabled");
});

it("shows a stored text Fast decisions primary without offering catalog models or Effort", () => {
  const models = cloneGenerationModelRouting(routing());
  models.fastDecisions = { provider: "deepseek", model: "deepseek-fast", thinkingEnabled: false };
  const markup = renderToStaticMarkup(createElement(GenerationModelRoutingSection, {
    models,
    options: catalog(),
    jevAvailable: true,
    disabled: false,
    onChange: () => undefined
  }));
  const primary = selectMarkup(markup, "Fast decisions");
  expect(primary).toContain("deepseek/deepseek-fast");
  expect(primary).toContain("Jev · TypeSafe");
  expect(primary).not.toContain("DeepSeek Pro");
  expect(markup).not.toContain('aria-label="Fast decisions Effort"');
});
