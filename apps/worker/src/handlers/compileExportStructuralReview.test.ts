import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPageForRepair } from "../runtime/jobTypes.js";
import { StopRequestedError } from "../runtime/jobTypes.js";
import type { ManuscriptQualityIssue } from "@book-maker/core";

const { generateJsonWithRetry } = vi.hoisted(() => ({ generateJsonWithRetry: vi.fn() }));

vi.mock("@book-maker/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@book-maker/core")>();
  return { ...actual, generateJsonWithRetry };
});

import {
  CORROBORATED_STRUCTURAL_DUPLICATION,
  MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE
} from "@book-maker/core";
import { reviewManuscriptStructure } from "./compileExportStructuralReview.js";

function exportPage(index: number, markdown: string): ExportPageForRepair {
  return {
    id: `page-${index}`,
    index,
    title: `Page ${index}`,
    markdown,
    summary: `Planning summary for page ${index}.`,
    imagePrompt: null,
    status: "COMPLETED",
    revision: 1,
    chapter: { id: "ch-1", index: 1, productionBrief: null },
    images: []
  } as ExportPageForRepair;
}

const candidate: ManuscriptQualityIssue = {
  code: "RECAP_BACKTRACKING",
  severity: "warning",
  source: "deterministic",
  message: "Pages 1-3 repeat a treatment.",
  guidance: "Review the cluster.",
  affectedPageIndexes: [1, 2, 3],
  metrics: { occurrences: 3, clusterCount: 1, wouldBlock: true }
};

const pages = [
  exportPage(1, "Cubical chert weights at Harappa show administrative control of Indus trade."),
  exportPage(2, "Those standardized stones therefore show administrative control of Indus trade."),
  exportPage(3, "The 13.63 gram unit recurs among cubical chert stones kept beside balance pans.")
];

const plan = {
  title: "Weights",
  premise: "A history of Indus weights",
  audience: "adults",
  voiceGuide: ["Be specific."],
  antiAiRules: ["UNIQUE_LOCAL_PAGE_RULE"],
  styleContract: {
    localRules: [{ id: "custom-local", instruction: "UNIQUE_LOCAL_PAGE_RULE" }],
    distributionRules: [{ id: "custom-dist", instruction: "UNIQUE_DISTRIBUTION_CAVEAT_RULE" }]
  },
  chapters: [{ index: 1, title: "Measure" }]
};

function highConfidenceCluster() {
  return {
    canonicalPageIndex: 1,
    duplicatePageIndexes: [2, 3],
    repeatedSubject: "Cubical chert weights as Indus administrative control of trade",
    repeatedEvidence: "The 13.63 gram unit and matching balance pans are reused without new finds",
    repeatedConclusion: "Each page closes on the same claim that officials constrained exchange",
    confidence: "high" as const,
    recommendedAction: "review" as const
  };
}

describe("reviewManuscriptStructure", () => {
  beforeEach(() => {
    generateJsonWithRetry.mockReset();
  });

  it("makes no structural-review call for a clean manuscript", async () => {
    await expect(
      reviewManuscriptStructure({
        pages,
        plan: plan as never,
        findings: [],
        textModel: {} as never,
        projectId: "project-1"
      })
    ).resolves.toEqual([]);
    expect(generateJsonWithRetry).not.toHaveBeenCalled();
  });

  it("turns a high-confidence duplicate into a blocking corroborated issue", async () => {
    generateJsonWithRetry.mockResolvedValue({ data: { clusters: [highConfidenceCluster()] } });

    const issues = await reviewManuscriptStructure({
      pages,
      plan: plan as never,
      findings: [candidate],
      textModel: {} as never,
      projectId: "project-1"
    });

    expect(generateJsonWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: MANUSCRIPT_STRUCTURAL_REVIEW_PURPOSE })
    );
    const user = JSON.parse(
      String(
        generateJsonWithRetry.mock.calls[0]?.[1]?.messages.find((message: { role: string }) => message.role === "user")
          ?.content
      )
    ) as { distributionRules?: string[] };
    expect(user.distributionRules?.some((rule) => rule.includes("UNIQUE_DISTRIBUTION_CAVEAT_RULE"))).toBe(true);
    expect(JSON.stringify(user)).not.toContain("UNIQUE_LOCAL_PAGE_RULE");
    expect(issues).toEqual([
      expect.objectContaining({
        code: CORROBORATED_STRUCTURAL_DUPLICATION,
        severity: "error",
        source: "model"
      })
    ]);
  });

  it("keeps a stored parallel-structure distribution line unchanged in the review payload", async () => {
    generateJsonWithRetry.mockResolvedValue({ data: { clusters: [highConfidenceCluster()] } });
    const userWording = "Ask the same questions throughout the book.";

    await reviewManuscriptStructure({
      pages,
      plan: {
        ...plan,
        writingMode: "analytical-history",
        styleContract: {
          localRules: plan.styleContract.localRules,
          distributionRules: [{ id: "user-parallel-questions", instruction: userWording }]
        }
      } as never,
      findings: [candidate],
      textModel: {} as never,
      projectId: "project-1"
    });

    const user = JSON.parse(
      String(
        generateJsonWithRetry.mock.calls[0]?.[1]?.messages.find((message: { role: string }) => message.role === "user")
          ?.content
      )
    ) as { distributionRules?: string[] };
    expect(user.distributionRules).toContain(userWording);
    expect(user.distributionRules?.join(" ")).not.toMatch(/chapter where it is assigned/i);
  });

  it("keeps medium confidence advisory", async () => {
    generateJsonWithRetry.mockResolvedValue({
      data: { clusters: [{ ...highConfidenceCluster(), confidence: "medium" }] }
    });

    const issues = await reviewManuscriptStructure({
      pages,
      plan: plan as never,
      findings: [candidate],
      textModel: {} as never,
      projectId: "project-1"
    });

    expect(issues[0]).toMatchObject({
      code: CORROBORATED_STRUCTURAL_DUPLICATION,
      severity: "warning"
    });
  });

  it("preserves deterministic findings on provider failure and never claims approval", async () => {
    generateJsonWithRetry.mockRejectedValue(new Error("model outage"));

    const issues = await reviewManuscriptStructure({
      pages,
      plan: plan as never,
      findings: [candidate],
      textModel: {} as never,
      projectId: "project-1"
    });

    expect(issues).toEqual([]);
    expect(generateJsonWithRetry).toHaveBeenCalled();
  });

  it("lets a stop request escape", async () => {
    generateJsonWithRetry.mockRejectedValue(new StopRequestedError());
    await expect(
      reviewManuscriptStructure({
        pages,
        plan: plan as never,
        findings: [candidate],
        textModel: {} as never,
        projectId: "project-1"
      })
    ).rejects.toBeInstanceOf(StopRequestedError);
  });

  it("drops a result whose indexes fall outside the pack", async () => {
    generateJsonWithRetry.mockResolvedValue({
      data: { clusters: [{ ...highConfidenceCluster(), canonicalPageIndex: 99 }] }
    });

    await expect(
      reviewManuscriptStructure({
        pages,
        plan: plan as never,
        findings: [candidate],
        textModel: {} as never,
        projectId: "project-1"
      })
    ).resolves.toEqual([]);
  });
});
