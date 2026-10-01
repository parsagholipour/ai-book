import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  legacy: vi.fn(async (_options: Record<string, unknown>): Promise<Record<string, unknown>> => ({ compositions: [], issues: [], source: "model" })),
  toolkit: vi.fn(async (_options: Record<string, unknown>): Promise<Record<string, unknown>> => ({ compositions: [], issues: [], source: "model" })),
  persist: vi.fn()
}));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), planChapterForms: mocks.legacy, planInstructionalForms: mocks.toolkit }));
vi.mock("./composedChaptersMaterial.js", () => ({ persistPlanField: mocks.persist }));

import { createProjectSchema, makeFallbackPlan, FakeTextModelAdapter } from "@book-maker/core";
import { planComposedForms } from "./composedFormPlan.js";

const stance = { thesis: "t", positions: [], refusals: [], voiceSample: "" };
const quality = { enabled: () => false } as unknown as Parameters<typeof planComposedForms>[0]["quality"];

function book(category: string, prompt: string, bookTypeChoice?: string) {
  return createProjectSchema.parse({ prompt, category, targetPages: 24, ...(bookTypeChoice ? { mediaSettings: { mobile: { bookTypeChoice } } } : {}) });
}

function common(input: ReturnType<typeof book>) {
  return { projectId: "p", planId: "v", input, stance, arc: undefined, setups: [], fixed: [], episodes: undefined, quality, textModel: new FakeTextModelAdapter(input) };
}

it("plans a chosen practical guide as a toolkit, with its setting, and stores the toolkit once", async () => {
  const guide = book("BUSINESS", "Create a practical guide to one-on-one meetings.", "practical_guide");
  const toolkit = { kind: "guide", caveats: [], rules: ["The agenda runs 25 minutes."] };
  mocks.toolkit.mockResolvedValueOnce({ compositions: [], issues: [], source: "model", toolkit });
  await planComposedForms({ ...common(guide), plan: makeFallbackPlan(guide), setting: { country: "United States" } });
  expect(mocks.legacy).not.toHaveBeenCalled();
  expect(mocks.toolkit).toHaveBeenLastCalledWith(expect.objectContaining({ setting: { country: "United States" }, exampleCast: "plan" }));
  expect(mocks.persist).toHaveBeenCalledWith("v", "toolkit", toolkit, expect.any(Function));
  mocks.persist.mockClear();
  await planComposedForms({ ...common(guide), plan: { ...makeFallbackPlan(guide), toolkit: toolkit as never } });
  expect(mocks.toolkit).toHaveBeenLastCalledWith(expect.objectContaining({ toolkit }));
  expect(mocks.persist).not.toHaveBeenCalledWith("v", "toolkit", expect.anything(), expect.any(Function));
});

it("never plans a business history as a toolkit, though Business makes it instructional", async () => {
  mocks.toolkit.mockClear();
  for (const input of [
    book("BUSINESS", "A history of Nokia, from rubber boots to phones.", "lead_magnet"),
    book("BUSINESS", "A history of the Hudson's Bay Company."),
    book("HISTORY", "A history of the shipping container.")
  ]) {
    await planComposedForms({ ...common(input), plan: makeFallbackPlan(input), setting: { country: "United States" } });
    expect(mocks.legacy.mock.lastCall![0]).not.toHaveProperty("toolkit");
    expect(mocks.legacy.mock.lastCall![0]).not.toHaveProperty("setting");
  }
  expect(mocks.toolkit).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalledWith("v", "toolkit", expect.anything(), expect.any(Function));
});
