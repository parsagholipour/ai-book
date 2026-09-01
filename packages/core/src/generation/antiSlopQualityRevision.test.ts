import { describe, expect, it } from "vitest";
import { QUALITY_FEATURE_DEFAULTS } from "./qualityGates.js";
import {
  ANTI_SLOP_QUALITY_REVISION_NOTE,
  buildAntiSlopQualityRevisionPatch,
  qualityRevisionEncodesMandatoryIntegrity
} from "./antiSlopQualityRevision.js";

describe("buildAntiSlopQualityRevisionPatch", () => {
  it("preserves unrelated operator choices and unknown future fields", () => {
    const stored = {
      ...QUALITY_FEATURE_DEFAULTS,
      styleAuditor: ["fast"],
      futureGate: ["ultra", "secret-tier"],
      pageReviewPromptModes: { balanced: "compact" },
      models: { ultra: { writer: "kept-model" } }
    };
    const patch = buildAntiSlopQualityRevisionPatch(stored);
    expect(patch.note).toBe(ANTI_SLOP_QUALITY_REVISION_NOTE);
    expect(patch.note).toMatch(/manuscript-structural-audit-v1/);
    expect(patch.settings.styleAuditor).toEqual(["fast"]);
    expect(patch.settings.futureGate).toEqual(["ultra", "secret-tier"]);
    expect(patch.settings.pageReviewPromptModes).toEqual({ balanced: "compact" });
    expect(patch.settings.models).toEqual({ ultra: { writer: "kept-model" } });
    expect(patch.settings.bestOfPolish).toEqual([...QUALITY_FEATURE_DEFAULTS.bestOfPolish]);
    expect(qualityRevisionEncodesMandatoryIntegrity(patch.settings)).toBe(false);
  });

  it("does not encode mandatory integrity as a disableable tier list", () => {
    const patch = buildAntiSlopQualityRevisionPatch({
      "integrity.pageMap": ["ultra"],
      mandatoryIntegrity: []
    });
    expect(patch.settings).not.toHaveProperty("integrity.pageMap");
    expect(patch.settings).not.toHaveProperty("mandatoryIntegrity");
    expect(qualityRevisionEncodesMandatoryIntegrity(patch.settings)).toBe(false);
  });
});
