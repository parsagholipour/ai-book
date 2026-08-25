import { describe, expect, it, vi } from "vitest";
import type { GenerationTextModelRouting } from "@book-maker/core";
import { loadGenerationTextRoutingSnapshot } from "./generationTextRouting.js";

describe("loadGenerationTextRoutingSnapshot", () => {
  it("falls back to compiled defaults on a failed read and logs it", async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const compiled = routing("compiled");

    const resolved = await loadGenerationTextRoutingSnapshot({
      compiled,
      load: async () => {
        throw new Error("database unavailable");
      },
      log
    });

    expect(resolved).toEqual(compiled);
    expect(log).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not reuse a previous successful read after a later failure", async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const compiled = routing("compiled");
    const saved = routing("saved");
    await loadGenerationTextRoutingSnapshot({
      compiled,
      load: async () => ({ models: saved }),
      log
    });

    const resolved = await loadGenerationTextRoutingSnapshot({
      compiled,
      load: async () => {
        throw new Error("database unavailable");
      },
      log
    });

    expect(resolved).toEqual(compiled);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

function routing(model: string): GenerationTextModelRouting {
  const selection = { provider: "deepseek" as const, model };
  return {
    fastJudgments: selection,
    fast: { writer: selection, judgment: selection },
    balanced: { writer: selection, judgment: selection },
    premium: { writer: selection, judgment: selection },
    ultra: { writer: selection, judgment: selection }
  };
}
