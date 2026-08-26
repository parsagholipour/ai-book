import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GeneratedPlansView } from "./GeneratedPlansSection.js";
import type { AdminGeneratedPlanDetail, AdminGeneratedPlanList } from "./types.js";

const list: AdminGeneratedPlanList = {
  plans: [
    {
      id: "plan-1",
      projectId: "book-1",
      title: "A Finished Plan",
      ownerEmail: "owner@example.com",
      targetPages: 24,
      version: 1,
      status: "APPROVED",
      generatedAt: "2026-08-25T12:00:00.000Z",
      grossCredits: 100,
      refundedCredits: 0,
      netCredits: 100,
      revenueUsd: 1,
      providerCostUsd: 0.123456,
      marginUsd: 0.876544,
      marginPercent: 87.7
    }
  ],
  total: 1,
  limit: 25,
  offset: 0
};

const detail: AdminGeneratedPlanDetail = {
  planId: "plan-1",
  chargeCount: 1,
  refundCount: 0,
  grossCredits: 100,
  refundedCredits: 0,
  netCredits: 100,
  revenueUsd: 1,
  providerCostUsd: 0.123456,
  marginUsd: 0.876544,
  marginPercent: 87.7,
  totals: {
    calls: 2,
    pricedCalls: 2,
    failedCalls: 0,
    inFlightCalls: 0,
    estimatedCalls: 0,
    unratedCalls: 0,
    usd: 0.123456,
    promptTokens: 1000,
    cachedPromptTokens: 100,
    outputTokens: 200,
    images: 0,
    audioSeconds: 0
  },
  byKind: [
    {
      kind: "text",
      calls: 2,
      pricedCalls: 2,
      failedCalls: 0,
      inFlightCalls: 0,
      estimatedCalls: 0,
      unratedCalls: 0,
      usd: 0.123456,
      promptTokens: 1000,
      cachedPromptTokens: 100,
      outputTokens: 200,
      images: 0,
      audioSeconds: 0
    }
  ],
  purposes: [
    {
      key: "book.plan.raw",
      label: "book.plan.raw",
      kind: "text",
      calls: 2,
      pricedCalls: 2,
      failedCalls: 0,
      inFlightCalls: 0,
      estimatedCalls: 0,
      unratedCalls: 0,
      usd: 0.123456,
      promptTokens: 1000,
      cachedPromptTokens: 100,
      outputTokens: 200,
      images: 0,
      audioSeconds: 0,
      models: [
        {
          key: "text:gemini:gemini-3.5-flash",
          provider: "gemini",
          model: "gemini-3.5-flash",
          kind: "text",
          calls: 2,
          pricedCalls: 2,
          failedCalls: 0,
          inFlightCalls: 0,
          estimatedCalls: 0,
          unratedCalls: 0,
          usd: 0.123456,
          promptTokens: 1000,
          cachedPromptTokens: 100,
          outputTokens: 200,
          images: 0,
          audioSeconds: 0
        }
      ]
    }
  ]
};

const noop = vi.fn();

function view(overrides: Partial<Parameters<typeof GeneratedPlansView>[0]> = {}) {
  return renderToStaticMarkup(
    <GeneratedPlansView
      list={list}
      listError={null}
      listStale={false}
      expandedPlanId={null}
      detail={null}
      detailError={null}
      detailLoading={false}
      onToggle={noop}
      onRetryList={noop}
      onRetryDetail={noop}
      onPrevious={noop}
      onNext={noop}
      {...overrides}
    />
  );
}

describe("GeneratedPlansView", () => {
  it("renders generated plans and explicitly excludes their downstream books", () => {
    const markup = view();

    expect(markup).toContain("Generated plans");
    expect(markup).toContain("A Finished Plan");
    expect(markup).toContain("owner@example.com");
    expect(markup).toContain("24");
    expect(markup).toContain("v1 · approved");
    expect(markup).toContain("a book later generated from the plan is intentionally excluded");
    expect(markup).toContain('aria-controls="generated-plan-detail-plan-1"');
    expect(markup).not.toContain('id="generated-plan-detail-plan-1"');
  });

  it("renders the same expanded economics and raw model detail as generated books", () => {
    const markup = view({ expandedPlanId: "plan-1", detail });

    expect(markup).toContain('id="generated-plan-detail-plan-1"');
    expect(markup).toContain("Charged");
    expect(markup).toContain("Refunded");
    expect(markup).toContain("Provider cost");
    expect(markup).toContain("Margin");
    expect(markup).toContain("Text");
    expect(markup).toContain("Images");
    expect(markup).toContain("Audio");
    expect(markup).toContain("Purpose and model costs");
    expect(markup).toContain("book.plan.raw");
    expect(markup).toContain("gemini-3.5-flash");
  });

  it("renders empty and independently paginated states", () => {
    expect(view({ list: { plans: [], total: 0, limit: 25, offset: 0 } })).toContain(
      "No generated plans in this window."
    );
    const paginated = view({ list: { ...list, total: 51, limit: 25, offset: 25 } });
    expect(paginated).toContain("Previous");
    expect(paginated).toContain("Next");
    expect(paginated).toContain("26–50 of 51");
  });
});
