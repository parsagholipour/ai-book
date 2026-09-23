import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { LiveGenerationTextModelAdapter } from "./factory.js";
import { FakeTextModelAdapter } from "./fake.js";
import { ProviderHttpError } from "./retry.js";
import { createDecisionModelRoute } from "./decisionRouting.js";
import { FakeDecisionAdapter } from "./decisions.js";
import {
  GENERATION_MODEL_STAGES, GENERATION_TEXT_MODEL_TIERS, JEV_SELECTION,
  compiledGenerationTextModelRouting, generationStageRoute, materializeGenerationStages,
  resolveGenerationTextModelRouting, type TextModelSelection
} from "./generationTextModelRouting.js";

const config = loadConfig({ MOCK_AI: "false", OPENAI_API_KEY: "test-key" });
const primary = { provider: "openai", model: "gpt-5.6-sol", thinkingEffort: "medium" } as const;
const fallback = { provider: "openai", model: "gpt-5-nano", thinkingEffort: "low" } as const;
const fixture = () => resolveGenerationTextModelRouting({ models: { ultra: { writer: primary } } }, compiledGenerationTextModelRouting(config, []));

describe("authoritative stage routing", () => {
  it.each(GENERATION_TEXT_MODEL_TIERS)("preserves explicit efforts at every stage on %s", async (tier) => {
    for (const effort of ["none", "low", "medium", "high", "max"] as const) {
      const routing = fixture();
      const selected = { ...primary, thinkingEffort: effort };
      const seen: TextModelSelection[] = [];
      for (const { id } of GENERATION_MODEL_STAGES) routing[tier].stages![id] = { primary: selected, fallback };
      const live = new LiveGenerationTextModelAdapter(config, {
        tier, loadRouting: async () => routing,
        createAdapter: (selection) => { seen.push(selection); return new FakeTextModelAdapter(); }
      });
      for (const { id } of GENERATION_MODEL_STAGES) expect((await live.bindForCall(id)).selection).toEqual(selected);
      expect(seen).toContainEqual(selected);
      expect(seen.every((selection) => selection.thinkingEffort === effort)).toBe(true);
    }
  });

  it("uses the saved stage fallback effort on availability failure", async () => {
    const routing = fixture();
    routing.ultra.stages!["compose-chapter"] = { primary, fallback };
    const seen: TextModelSelection[] = [];
    const live = new LiveGenerationTextModelAdapter(config, {
      tier: "ultra", loadRouting: async () => routing,
      createAdapter: (selection) => {
        seen.push(selection);
        const adapter = new FakeTextModelAdapter();
        vi.spyOn(adapter, "generateText").mockImplementation(async () => {
          if (selection.model === primary.model) throw new ProviderHttpError("unavailable", { status: 503 });
          return { ...selection, text: "Complete chapter" };
        });
        return adapter;
      }
    });
    expect((await live.generateText({ purpose: "compose-chapter", messages: [] })).model).toBe(fallback.model);
    expect(seen).toEqual([primary, fallback]);
  });

  it("gives the chapter comparison stage priority over the fast-judgment wrapper", async () => {
    const routing = fixture();
    routing.ultra.stages!["judge-chapter-drafts"] = { primary, fallback };
    const live = new LiveGenerationTextModelAdapter(config, { tier: "ultra", fastJudgments: true,
      loadRouting: async () => routing, createAdapter: () => new FakeTextModelAdapter() });
    expect((await live.bindForCall("judge-chapter-drafts")).selection).toEqual(primary);
  });

  it("keeps a bound call pinned and observes a new effort on the next call", async () => {
    let routing = fixture();
    const live = new LiveGenerationTextModelAdapter(config, { tier: "ultra", loadRouting: async () => routing,
      createAdapter: () => new FakeTextModelAdapter() });
    const bound = await live.bindForCall("compose-chapter");
    routing = materializeGenerationStages(routing);
    routing.ultra.stages!["compose-chapter"] = { primary: { ...primary, thinkingEffort: "low" }, fallback };
    expect(bound.selection).toEqual(primary);
    expect((await live.bindForCall("compose-chapter")).selection.thinkingEffort).toBe("low");
    expect((await live.bindForCall("edit-chapter")).selection).toEqual(primary);
  });

  it("seeds legacy numeric, disabled and finite-choice settings without boosts", () => {
    const routing = resolveGenerationTextModelRouting({ models: { fastDecisions: JEV_SELECTION,
      fastDecisionsFallback: fallback, ultra: { writer: { provider: "gemini", model: "gemini-2.5-pro", thinkingBudget: 2048 },
        judgment: { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false } } } }, compiledGenerationTextModelRouting(config, []));
    expect(generationStageRoute(routing, "ultra", "plan-book").primary).toHaveProperty("thinkingBudget", 2048);
    expect(generationStageRoute(routing, "ultra", "generate-page-map").primary).toHaveProperty("thinkingEnabled", false);
    expect(generationStageRoute(routing, "ultra", "judge-chapter-drafts")).toEqual({ primary: JEV_SELECTION, fallback });
  });

  it("does not let a global finite-choice setting override a stage text model", async () => {
    const routing = fixture();
    routing.fastDecisions = JEV_SELECTION;
    routing.ultra.stages!["judge-chapter-drafts"] = { primary, fallback };
    const route = createDecisionModelRoute(config, { tier: "ultra", loadRouting: async () => routing });
    expect(await route.resolve("judge-chapter-drafts")).toBeUndefined();
    routing.ultra.stages!["judge-chapter-drafts"] = { primary: JEV_SELECTION, fallback };
    const finiteRoute = createDecisionModelRoute(config, { tier: "ultra", loadRouting: async () => routing,
      createAdapter: () => new FakeDecisionAdapter() });
    expect(await finiteRoute.resolve("judge-chapter-drafts")).toBeDefined();
  });

  it("refuses a broken saved stage instead of silently choosing a default", () => {
    expect(() => resolveGenerationTextModelRouting({ models: { ultra: { stages: {
      "compose-chapter": { primary, fallback: { provider: "typo", model: "invalid" } }
    } } } }, compiledGenerationTextModelRouting(config, []))).toThrow("Invalid saved model route");
  });
});

it("seeds claim extraction from the saved mechanical extraction route and keeps verification independent", () => {
  const routing = fixture();
  routing.ultra.stages!["extract-excerpts"] = { primary: fallback, fallback: primary };
  routing.ultra.stages!["review-chapter-evidence"] = { primary, fallback };
  delete routing.ultra.stages!["inventory-chapter-claims"];
  expect(generationStageRoute(routing, "ultra", "inventory-chapter-claims").primary).toEqual(fallback);
  expect(generationStageRoute(routing, "ultra", "review-chapter-evidence").primary).toEqual(primary);
  routing.ultra.stages!["inventory-chapter-claims"] = { primary: { ...primary, thinkingEffort: "none" }, fallback };
  expect(generationStageRoute(routing, "ultra", "inventory-chapter-claims").primary).toMatchObject({ thinkingEffort: "none" });
});
