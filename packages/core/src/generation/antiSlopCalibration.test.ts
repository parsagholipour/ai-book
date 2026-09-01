import { describe, expect, it } from "vitest";
import {
  ANTI_SLOP_AUTOMATIC_REPAIR_EXCLUSIONS,
  ANTI_SLOP_CORPUS_CALIBRATION_CADENCE,
  ANTI_SLOP_CORPUS_CALIBRATION_OWNER,
  ANTI_SLOP_DETECTOR_VERSION,
  ANTI_SLOP_LIVE_GATES_MET,
  ANTI_SLOP_STYLE_CONTRACT_VERSION,
  ANTI_SLOP_STRUCTURAL_REVIEW_BOUNDS,
  ANTI_SLOP_THRESHOLD_STATUS,
  BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV,
  PHASE_06_AUTOMATIC_CONSOLIDATION_ENTRY_MET,
  formatAntiSlopCalibrationCli,
  replayAntiSlopCalibration
} from "./antiSlopCalibration.js";

describe("replayAntiSlopCalibration", () => {
  it("runs distilled known-failure, clean, and boundary fixtures without claiming live gates", async () => {
    const report = await replayAntiSlopCalibration();
    expect(report.detectorVersion).toBe(ANTI_SLOP_DETECTOR_VERSION);
    expect(report.styleContractVersion).toBe(ANTI_SLOP_STYLE_CONTRACT_VERSION);
    expect(report.liveGatesMet).toBe(false);
    expect(ANTI_SLOP_LIVE_GATES_MET).toBe(false);
    expect(report.phase06AutomaticConsolidationEntryMet).toBe(false);
    expect(PHASE_06_AUTOMATIC_CONSOLIDATION_ENTRY_MET).toBe(false);
    expect(report.automaticConsolidationImplemented).toBe(false);
    expect(report.productionMapIntegrityEnvRetained).toBe(true);
    expect(report.productionMapIntegrityEnv).toBe(BOOK_MAKER_PRODUCTION_MAP_INTEGRITY_ENV);
    expect(report.thresholdStatus).toBe(ANTI_SLOP_THRESHOLD_STATUS);
    expect(report.structuralReviewBounds).toEqual(ANTI_SLOP_STRUCTURAL_REVIEW_BOUNDS);
    expect(report.structuralReviewBounds.maxOutputTokens).toBe(1800);
    expect(report.structuralReviewBounds.temperature).toBe(0);
    expect(report.corpusCalibrationOwner).toBe(ANTI_SLOP_CORPUS_CALIBRATION_OWNER);
    expect(report.corpusCalibrationCadence).toBe(ANTI_SLOP_CORPUS_CALIBRATION_CADENCE);
    expect(report.automaticRepairExclusions).toEqual([...ANTI_SLOP_AUTOMATIC_REPAIR_EXCLUSIONS]);
    expect(report.productionMapIntegrityRemovalPlan).toMatch(/Phase 06 did not remove/);
    expect(report.fixtures.length).toBeGreaterThan(8);
    const failed = report.fixtures.filter((fixture) => !fixture.passed);
    expect(failed, failed.map((fixture) => `${fixture.id}: ${fixture.detail}`).join("\n")).toEqual([]);
    const cli = formatAntiSlopCalibrationCli(report);
    expect(cli.ok).toBe(true);
    expect(cli.summary.failed).toBe(0);
    expect(cli.summary.total).toBe(report.fixtures.length);
    expect(JSON.stringify(cli)).not.toMatch(/storage\//);
  });
});
