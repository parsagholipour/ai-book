import { describe, expect, it } from "vitest";
import {
  ANTI_SLOP_DETECTOR_VERSION,
  ANTI_SLOP_LIVE_GATES_MET,
  ANTI_SLOP_THRESHOLD_STATUS,
  PHASE_06_AUTOMATIC_CONSOLIDATION_ENTRY_MET,
  replayAntiSlopCalibration
} from "./antiSlopCalibration.js";

describe("replayAntiSlopCalibration", () => {
  it("runs distilled known-failure, clean, and boundary fixtures without claiming live gates", async () => {
    const report = await replayAntiSlopCalibration();
    expect(report.detectorVersion).toBe(ANTI_SLOP_DETECTOR_VERSION);
    expect(report.liveGatesMet).toBe(false);
    expect(ANTI_SLOP_LIVE_GATES_MET).toBe(false);
    expect(report.phase06AutomaticConsolidationEntryMet).toBe(false);
    expect(PHASE_06_AUTOMATIC_CONSOLIDATION_ENTRY_MET).toBe(false);
    expect(report.thresholdStatus).toBe(ANTI_SLOP_THRESHOLD_STATUS);
    expect(report.fixtures.length).toBeGreaterThan(8);
    const failed = report.fixtures.filter((fixture) => !fixture.passed);
    expect(failed, failed.map((fixture) => `${fixture.id}: ${fixture.detail}`).join("\n")).toEqual([]);
  });
});
