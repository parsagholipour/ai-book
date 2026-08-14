import { describe, expect, it, vi } from "vitest";
import {
  FakeTextModelAdapter,
  RoutingTextModelAdapter,
  type TextModelAdapter
} from "@book-maker/core";

vi.mock("@book-maker/db", () => ({ prisma: {}, Prisma: {} }));

import { applyPlanThinkingBoost } from "./qualitySettings.js";
import { LoggingTextModelAdapter } from "../providers/loggedAdapters.js";

function routingWithPlanOverride() {
  const prose = new FakeTextModelAdapter();
  const mechanical = new FakeTextModelAdapter();
  const plan = new FakeTextModelAdapter();
  const routing = new RoutingTextModelAdapter(
    { selection: { provider: "gemini", model: "prose-model", thinkingBudget: 2048 }, adapter: prose },
    { selection: { provider: "gemini", model: "mechanical-model", thinkingBudget: 0 }, adapter: mechanical },
    new Map([
      [
        "plan-book",
        { selection: { provider: "gemini", model: "plan-thinking-model", thinkingBudget: 4096 }, adapter: plan }
      ]
    ])
  );
  return routing;
}

function silentLogger() {
  return {
    filePath: "/tmp/quality-settings-test.jsonl",
    append: async () => "2026-01-01T00:00:00.000Z"
  };
}

describe("applyPlanThinkingBoost", () => {
  it("disables purpose overrides on a routing adapter", () => {
    const routing = routingWithPlanOverride();
    expect(routing.selectionForPurpose("plan-book").model).toBe("plan-thinking-model");

    applyPlanThinkingBoost(routing, false);

    expect(routing.selectionForPurpose("plan-book").model).toBe("prose-model");
    expect(routing.selectionForPurpose("plan-book").thinkingBudget).toBe(2048);
  });

  it("reaches the routing adapter through LoggingTextModelAdapter", () => {
    const routing = routingWithPlanOverride();
    const logged = new LoggingTextModelAdapter(
      routing,
      silentLogger(),
      undefined,
      undefined,
      { provider: "gemini", model: "prose-model" }
    );

    applyPlanThinkingBoost(logged, false);

    expect(routing.selectionForPurpose("plan-book").model).toBe("prose-model");
    expect(routing.selectionForPurpose("plan-book").thinkingBudget).toBe(2048);
  });

  it("forwards through a wrapper that only exposes the toggle", () => {
    const setPurposeOverridesEnabled = vi.fn();
    const wrapper = { setPurposeOverridesEnabled } as unknown as TextModelAdapter;

    applyPlanThinkingBoost(wrapper, false);

    expect(setPurposeOverridesEnabled).toHaveBeenCalledWith(false);
  });

  it("leaves adapters without the toggle unchanged", () => {
    const adapter = new FakeTextModelAdapter();
    expect(() => applyPlanThinkingBoost(adapter, false)).not.toThrow();
  });
});
