import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), persist: vi.fn() }));
vi.mock("@book-maker/core", async (original) => ({ ...await original<object>(), inventoryManuscriptRequirements: mocks.inventory }));
vi.mock("./composedChaptersMaterial.js", () => ({ persistPlanField: mocks.persist }));

import { createProjectSchema, makeFallbackPlan, FakeTextModelAdapter, type ManuscriptRequirementInventory } from "@book-maker/core";
import { briefRequirementsForForms, storeBriefInventory, takeBriefInventory } from "./composedBriefInventory.js";

const input = createProjectSchema.parse({ prompt: "A guide to one-on-one meetings with a question bank.", category: "BUSINESS", targetPages: 24 });
const plan = makeFallbackPlan(input);
const textModel = new FakeTextModelAdapter(input);
const requirement = (text: string, kind: string, quote = text) => ({ text, quote, kind, scope: { extent: "whole_book", quote } });
const available = {
  version: 1, status: "available", brief: input.prompt, complete: true,
  requirements: [requirement("Question bank", "content", "a question bank"), requirement("Around 24 pages", "page_count"), requirement("Tracker table", "table", "a tracker table")]
} as unknown as ManuscriptRequirementInventory;

beforeEach(() => vi.clearAllMocks());

it("takes the scoped inventory the compile reuses, and stores it only once asked to", async () => {
  mocks.inventory.mockResolvedValue(available);
  const inventory = await takeBriefInventory({ input, plan, textModel });
  // Version 1 is what `matchingRequirementInventory` accepts, and only requireScope produces it.
  expect(mocks.inventory).toHaveBeenCalledWith({ brief: input.prompt, textModel, requireScope: true });
  expect(inventory).toBe(available);
  expect(mocks.persist).not.toHaveBeenCalled();
  await storeBriefInventory({ planId: "plan-1", input, plan, inventory });
  expect(mocks.persist).toHaveBeenCalledWith("plan-1", "requirementInventory", available, expect.any(Function));
  const parses = mocks.persist.mock.calls[0]![3] as (stored: unknown) => boolean;
  expect(parses(available)).toBe(true);
  expect(parses({ ...available, brief: "Another brief" })).toBe(false);
});

it("reads back the plan's own inventory and stores nothing over it", async () => {
  const stored = { ...plan, requirementInventory: available };
  expect(await takeBriefInventory({ input, plan: stored, textModel })).toBe(available);
  expect(mocks.inventory).not.toHaveBeenCalled();
  await storeBriefInventory({ planId: "plan-1", input, plan: stored, inventory: available });
  expect(mocks.persist).not.toHaveBeenCalled();
});

it("keeps no failed attempt and never rejects, a stop included", async () => {
  mocks.inventory.mockResolvedValue({ ...available, status: "unavailable", complete: false, requirements: [] });
  expect(await takeBriefInventory({ input, plan, textModel })).toBeUndefined();
  mocks.inventory.mockRejectedValue(new Error("provider down"));
  expect(await takeBriefInventory({ input, plan, textModel })).toBeUndefined();
  const stop = new Error("stopped");
  stop.name = "StopRequestedError";
  mocks.inventory.mockRejectedValue(stop);
  expect(await takeBriefInventory({ input, plan, textModel })).toBeUndefined();
  mocks.persist.mockRejectedValue(new Error("plan changed"));
  await expect(storeBriefInventory({ planId: "plan-1", input, plan, inventory: available })).resolves.toBeUndefined();
});

it("hands the form planner the asks a section can deliver, in the brief's words", () => {
  expect(briefRequirementsForForms(available)).toEqual(['Question bank: "a question bank"', 'Tracker table: "a tracker table"']);
  expect(briefRequirementsForForms(undefined)).toEqual([]);
});
