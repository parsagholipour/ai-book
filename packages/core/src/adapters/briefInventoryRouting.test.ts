import { expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { FakeTextModelAdapter } from "./fake.js";
import { LiveGenerationTextModelAdapter } from "./factory.js";
import { chapterOutputBudget } from "./chapterOutputBudget.js";
import { compiledGenerationTextModelRouting, generationStageRoute, resolveGenerationTextModelRouting,
  GENERATION_TEXT_MODEL_TIERS } from "./generationTextModelRouting.js";
import { inventoryManuscriptRequirements, reviewManuscriptCoverage } from "../generation/manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "../generation/testing/bookDevelopmentFixtures.js";

const config = loadConfig({ MOCK_AI: "false", OPENAI_API_KEY: "test" });
const primary = { provider: "openai", model: "gpt-6-luna", thinkingEffort: "high" } as const;
const fallback = { provider: "deepseek", model: "deepseek-v4-flash", thinkingEnabled: false } as const;
const stage = "inventory-brief-requirements";

it.each(GENERATION_TEXT_MODEL_TIERS)("inherits the entire existing manuscript route for %s without changing effort", tier => {
  const routing = resolveGenerationTextModelRouting({ models: { [tier]: { stages: { "read-manuscript": { primary, fallback } } } } }, compiledGenerationTextModelRouting(config, []));
  expect(generationStageRoute(routing, tier, stage)).toEqual({ primary, fallback });
  expect(generationStageRoute(routing, tier, "read-manuscript")).toEqual({ primary, fallback });
});

it("allows an explicit independent route and keeps the bound extraction pinned", async () => {
  const routing = resolveGenerationTextModelRouting({ models: { balanced: { stages: {
    "read-manuscript": { primary, fallback }, [stage]: { primary: { ...primary, thinkingEffort: "medium" }, fallback }
  } } } }, compiledGenerationTextModelRouting(config, []));
  const live = new LiveGenerationTextModelAdapter(config, { tier: "balanced", loadRouting: async () => routing,
    createAdapter: () => new FakeTextModelAdapter() });
  const bound = await live.bindForCall(stage);
  expect(bound.selection).toEqual({ ...primary, thinkingEffort: "medium" });
  routing.balanced.stages![stage] = { primary: { ...primary, thinkingEffort: "low" }, fallback };
  expect(bound.selection).toEqual({ ...primary, thinkingEffort: "medium" });
  expect((await live.bindForCall(stage)).selection).toEqual({ ...primary, thinkingEffort: "low" });
  expect((await live.bindForCall("read-manuscript")).selection).toEqual(primary);
});

it("routes inventory and exact brief-quote recovery separately from semantic review", async () => {
  const brief = "Rabbit and Turtle grow together.";
  const prose = "Rabbit learned to wait, and Turtle learned to trust.";
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ text: "Rabbit grows", kind: "content", quote: "Rabbit ... grow together." }] },
    { corrections: [{ id: "brief-1", supportsSameRequirement: true, quote: brief }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "A changed choice.", evidence: [{ pageIndex: 1, quote: prose }] }] }
  ]);
  const inventory = await inventoryManuscriptRequirements({ brief, textModel: model });
  expect(inventory.complete).toBe(true);
  const review = await reviewManuscriptCoverage({ brief, promises: [], pages: [{ index: 1, markdown: prose }], inventory, textModel: model });
  expect(review.status).toBe("reviewed");
  expect(calls.map(call => call.purpose)).toEqual([stage, stage, "read-manuscript"]);
  expect(calls.map(call => call.maxTokens)).toEqual([8000, 2500, 16000]);
  expect(calls[1]!.textAttemptBudget).toMatchObject({ limit: 1, outputWidened: true });
});

it.each(["low", "medium", "high", "xhigh", "max"] as const)("preserves the previous output headroom at %s effort", effort => {
  for (const maxTokens of [2500, 8000]) expect(chapterOutputBudget({ purpose: stage, messages: [], maxTokens }, effort))
    .toBe(chapterOutputBudget({ purpose: "read-manuscript", messages: [], maxTokens }, effort));
});

it("uses the inherited availability fallback, including its thinking configuration", async () => {
  const routing = resolveGenerationTextModelRouting({ models: { balanced: { stages: { "read-manuscript": { primary, fallback } } } } }, compiledGenerationTextModelRouting(config, []));
  const seen: unknown[] = [];
  const { ProviderHttpError } = await import("./retry.js");
  const live = new LiveGenerationTextModelAdapter(config, { tier: "balanced", loadRouting: async () => routing,
    createAdapter: selection => {
      seen.push(selection);
      const adapter = new FakeTextModelAdapter();
      vi.spyOn(adapter, "generateText").mockImplementation(async () => {
        if (selection.model === primary.model) throw new ProviderHttpError("unavailable", { status: 503 });
        return { text: "Recovered", model: selection.model, provider: selection.provider };
      });
      return adapter;
    } });
  expect((await live.generateText({ purpose: stage, messages: [] })).model).toBe(fallback.model);
  expect(seen).toEqual([primary, fallback]);
});
