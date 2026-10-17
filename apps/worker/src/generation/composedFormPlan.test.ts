import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(async (_options: Record<string, unknown>): Promise<Record<string, unknown>> => ({ compositions: [], issues: [], source: "model" })),
  persist: vi.fn()
}));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), planChapterForms: mocks.plan }));
vi.mock("./composedChaptersMaterial.js", () => ({ persistPlanField: mocks.persist }));

import { createProjectSchema, makeFallbackPlan, FakeTextModelAdapter } from "@book-maker/core";
import { planComposedForms } from "./composedFormPlan.js";

it("asks the form planner for no repair call on any tier (removed 2026-10-16)", async () => {
  const input = createProjectSchema.parse({ prompt: "A guide to one-on-one meetings.", category: "BUSINESS", targetPages: 24 });
  const plan = makeFallbackPlan(input);
  const stance = { thesis: "Meetings are for the employee.", positions: [], refusals: [], voiceSample: "" };
  const quality = { enabled: () => false } as unknown as Parameters<typeof planComposedForms>[0]["quality"];
  await planComposedForms({ projectId: "p", planId: "v", input, plan, stance, arc: undefined, setups: [], fixed: [], episodes: undefined, quality, textModel: new FakeTextModelAdapter(input) });
  expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ figures: false }));
  expect(mocks.plan.mock.lastCall?.[0]).not.toHaveProperty("repair");
});

it("hands the planner the brief's asks, and plans a cast only for a guide, storing a new one and keeping a stored one", async () => {
  const guide = createProjectSchema.parse({ prompt: "A practical guide to one-on-one meetings.", category: "BUSINESS", targetPages: 24 });
  const history = createProjectSchema.parse({ prompt: "A history of the shipping container.", category: "HISTORY", targetPages: 24 });
  const stance = { thesis: "t", positions: [], refusals: [], voiceSample: "" };
  const quality = { enabled: () => true } as unknown as Parameters<typeof planComposedForms>[0]["quality"];
  const cast = [{ name: "Maya", role: "a first-time manager" }];
  const common = { projectId: "p", planId: "v", stance, arc: undefined, setups: [], fixed: [], episodes: undefined, quality, textModel: new FakeTextModelAdapter(guide) };
  mocks.plan.mockResolvedValueOnce({ compositions: [], issues: [], source: "model", cast });
  await planComposedForms({ ...common, input: guide, plan: makeFallbackPlan(guide), requirements: ["Question bank"] });
  expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ requirements: ["Question bank"], exampleCast: "plan" }));
  expect(mocks.persist).toHaveBeenCalledWith("v", "exampleCast", cast, expect.any(Function));
  mocks.persist.mockClear();
  mocks.plan.mockResolvedValueOnce({ compositions: [], issues: [], source: "model", cast });
  await planComposedForms({ ...common, input: guide, plan: { ...makeFallbackPlan(guide), exampleCast: cast } });
  expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ exampleCast: cast }));
  expect(mocks.persist).not.toHaveBeenCalled();
  await planComposedForms({ ...common, input: history, plan: makeFallbackPlan(history) });
  expect(mocks.plan.mock.lastCall![0]).not.toHaveProperty("exampleCast");
  expect(mocks.plan.mock.lastCall![0]).not.toHaveProperty("requirements");
});
