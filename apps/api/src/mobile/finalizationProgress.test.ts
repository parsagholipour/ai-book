import { describe, expect, it } from "vitest";
import { serializeFinalizationProgress } from "./finalizationProgress.js";

const checkpoint = {
  operationId: "internal-operation-id",
  phase: "repair",
  pageIndex: 8,
  attempts: 2,
  remainingRepairPages: 1,
  updatedAt: "2026-09-23T11:15:00.000Z",
  message: "internal provider message",
  model: "private-model"
};

describe("public finalization progress", () => {
  it("names the current repair and honest page budget without internal identifiers", () => {
    const output = serializeFinalizationProgress({ finalizationProgress: checkpoint }, 30);
    expect(output).toEqual({
      phase: "repair", label: "Polishing page 8 of 30", pageIndex: 8,
      repairPagesAttempted: 2, remainingRepairPages: 1, lastProgressAt: checkpoint.updatedAt
    });
    expect(JSON.stringify(output)).not.toMatch(/provider|model|internal|operationId/);
  });

  it.each(["review", "final_review", "illustrations", "coverage", "render", "published"])("uses a curated %s phase label", (phase) => {
    const result = serializeFinalizationProgress({ finalizationProgress: { ...checkpoint, phase, pageIndex: null } }, 30);
    expect(result?.phase).toBe(phase);
    expect(result?.pageIndex).toBeNull();
    expect(result?.label).not.toContain("internal");
  });

  it.each([
    { phase: "provider_retry" }, { attempts: -1 }, { attempts: Number.NaN },
    { remainingRepairPages: 31 }, { remainingRepairPages: 1.5 }, { updatedAt: "not a date" }
  ])("does not expose malformed checkpoint counters or unknown phase %j", (change) => {
    expect(serializeFinalizationProgress({ finalizationProgress: { ...checkpoint, ...change } }, 30)).toBeNull();
  });

  it("supports old jobs without inventing a repair budget", () => {
    expect(serializeFinalizationProgress({}, 30)).toBeNull();
  });
});
