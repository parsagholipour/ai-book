import { describe, expect, it } from "vitest";
import { PAGE_QA_TRIGGER_REASONS } from "../adapters/types.js";
import {
  pageQaProviderCallMetadata,
  pageQaTriggerReasonsForReport,
  withPageQaTriggerReasons
} from "./pageQaRewriteTelemetry.js";
import { SMART_UNSLOP_ISSUE_PREFIX } from "./smartUnslop.js";

const baseReport = {
  groundedOk: true,
  unsupportedClaims: [] as string[],
  issues: [] as string[],
  requiredRevisions: [] as string[],
  notes: "",
  checks: { styleNatural: true }
};

describe("page QA rewrite telemetry", () => {
  it("supports every bounded trigger code and preserves multiple causes", () => {
    const observed = new Set([
      ...pageQaTriggerReasonsForReport(baseReport),
      ...pageQaTriggerReasonsForReport({ ...baseReport, groundedOk: false }),
      ...pageQaTriggerReasonsForReport(withPageQaTriggerReasons(baseReport, ["story_contradiction"])),
      ...pageQaTriggerReasonsForReport({ ...baseReport, stylePenalty: 15 }),
      ...pageQaTriggerReasonsForReport({ ...baseReport, notes: "Local quality checks rejected the page." }),
      ...pageQaTriggerReasonsForReport({
        ...baseReport,
        issues: [`${SMART_UNSLOP_ISSUE_PREFIX} found a possible signal cluster.`]
      }),
      ...pageQaTriggerReasonsForReport({ ...baseReport, issues: ["The page restages a reserved closing beat."] }),
      ...pageQaProviderCallMetadata({
        report: { ...baseReport, groundedOk: false, stylePenalty: 15 },
        candidateNumber: 3,
        additionalReasons: ["brief_repair"]
      }).qaTriggerReasons
    ]);

    expect([...observed]).toEqual(expect.arrayContaining([...PAGE_QA_TRIGGER_REASONS]));
    expect(pageQaProviderCallMetadata({
      report: { ...baseReport, groundedOk: false, stylePenalty: 15 },
      candidateNumber: 3,
      additionalReasons: ["brief_repair"]
    })).toEqual({
      qaTriggerReasons: ["claim_grounding", "style", "brief_repair"],
      qaCandidateNumber: 3,
      qaRewriteNumber: 2
    });
  });
});
