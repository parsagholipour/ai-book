import { describe, expect, it } from "vitest";
import { GENERATION_PIPELINE_STAGES, PLANNING_STAGES, pipelineForStrategy } from "./pipelineStages.js";
import { QUALITY_FEATURES, QUALITY_FEATURE_IDS, MANDATORY_INTEGRITY_CHECKS, QUALITY_PIPELINES } from "./qualityGates.js";
import { autoStrategyRoutingMatrix, ROUTING_MATRIX_PAGE_BANDS } from "./strategies/router.js";
import { bookGenerationStrategies, composedChaptersStrategy, pageMapSequentialStrategy } from "./strategies/index.js";

describe("quality gate pipeline metadata", () => {
  it("places every gate on at least one pipeline with a stage label", () => {
    for (const feature of QUALITY_FEATURES) {
      expect(feature.pipelines.length, feature.id).toBeGreaterThan(0);
      expect(feature.stage, feature.id).not.toBe("");
      for (const pipeline of feature.pipelines) {
        expect(QUALITY_PIPELINES).toContain(pipeline);
      }
    }
    expect(QUALITY_FEATURES.map((feature) => feature.id).sort()).toEqual([...QUALITY_FEATURE_IDS].sort());
    for (const check of MANDATORY_INTEGRITY_CHECKS) {
      expect(check.pipelines.length, check.id).toBeGreaterThan(0);
    }
  });

  it("names every gate a pipeline claims in one of that pipeline's stages", () => {
    const stageGates = {
      planning: new Set(PLANNING_STAGES.flatMap((stage) => stage.gates)),
      "per-page": new Set(GENERATION_PIPELINE_STAGES["per-page"].flatMap((stage) => stage.gates)),
      composed: new Set(GENERATION_PIPELINE_STAGES.composed.flatMap((stage) => stage.gates))
    };
    for (const feature of QUALITY_FEATURES) {
      for (const pipeline of feature.pipelines) {
        expect(stageGates[pipeline].has(feature.id), `${feature.id} on ${pipeline}`).toBe(true);
      }
    }
    for (const [pipeline, gates] of Object.entries(stageGates)) {
      for (const gate of gates) {
        const feature = QUALITY_FEATURES.find((candidate) => candidate.id === gate);
        expect(feature?.pipelines, `${gate} in ${pipeline} stages`).toContain(pipeline);
      }
    }
  });

  it("gives every stage purposes and a lane", () => {
    for (const stage of [...PLANNING_STAGES, ...GENERATION_PIPELINE_STAGES["per-page"], ...GENERATION_PIPELINE_STAGES.composed]) {
      expect(stage.purposes.length, stage.id).toBeGreaterThan(0);
      expect(["prose", "mechanical", "mixed", "none"]).toContain(stage.lane);
    }
  });
});

describe("pipelineForStrategy", () => {
  it("maps the composed strategies to the composed pipeline and everything else to per-page", () => {
    expect(pipelineForStrategy(composedChaptersStrategy)).toBe("composed");
    expect(pipelineForStrategy(pageMapSequentialStrategy)).toBe("per-page");
    for (const strategy of bookGenerationStrategies) {
      expect(["per-page", "composed"]).toContain(pipelineForStrategy(strategy));
    }
  });
});

describe("autoStrategyRoutingMatrix", () => {
  it("samples every category at every page band through the router", () => {
    const matrix = autoStrategyRoutingMatrix();
    expect(matrix.pageBands).toEqual([...ROUTING_MATRIX_PAGE_BANDS]);
    expect(matrix.rows.length).toBeGreaterThan(5);
    const known = new Set(bookGenerationStrategies.map((strategy) => strategy.id));
    for (const row of matrix.rows) {
      expect(row.strategyIds).toHaveLength(matrix.pageBands.length);
      for (const id of row.strategyIds) expect(known.has(id), id).toBe(true);
    }
    const history = matrix.rows.find((row) => row.category === "HISTORY")!;
    const kids = matrix.rows.find((row) => row.category === "KIDS")!;
    const story = matrix.rows.find((row) => row.category === "STORY")!;
    expect(history.strategyIds[matrix.pageBands.indexOf(100)]).toBe("composed-chapters-research");
    expect(story.strategyIds[matrix.pageBands.indexOf(60)]).toBe("composed-chapters");
    expect(kids.strategyIds.some((id) => id.startsWith("composed"))).toBe(false);
    expect(history.strategyIds[matrix.pageBands.indexOf(4)]).toBe("whole-book-single-pass");
  });
});
