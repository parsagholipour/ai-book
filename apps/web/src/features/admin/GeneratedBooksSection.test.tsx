import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GeneratedBooksView } from "./GeneratedBooksSection.js";
import type { AdminGeneratedBookDetail, AdminGeneratedBookList } from "./types.js";

const list: AdminGeneratedBookList = {
  books: [
    {
      id: "book-1",
      title: "A Finished Book",
      ownerEmail: "owner@example.com",
      pageCount: 12,
      imageCount: 4,
      completedAt: "2026-08-25T14:00:00.000Z",
      grossCredits: 1200,
      refundedCredits: 200,
      netCredits: 1000,
      revenueUsd: 10,
      providerCostUsd: 1.234567,
      marginUsd: 8.765433,
      marginPercent: 87.7
    }
  ],
  total: 1,
  limit: 25,
  offset: 0
};

const noop = vi.fn();

const detail: AdminGeneratedBookDetail = {
  bookId: "book-1",
  chargeCount: 2,
  refundCount: 1,
  grossCredits: 1200,
  refundedCredits: 200,
  netCredits: 1000,
  revenueUsd: 10,
  providerCostUsd: 1.234567,
  marginUsd: 8.765433,
  marginPercent: 87.7,
  totals: {
    calls: 11,
    pricedCalls: 7,
    failedCalls: 1,
    inFlightCalls: 1,
    estimatedCalls: 1,
    unratedCalls: 1,
    usd: 1.234567,
    promptTokens: 12_345,
    cachedPromptTokens: 2_000,
    outputTokens: 678,
    images: 2,
    audioSeconds: 65
  },
  byKind: [
    {
      kind: "text",
      calls: 8,
      pricedCalls: 4,
      failedCalls: 1,
      inFlightCalls: 1,
      estimatedCalls: 1,
      unratedCalls: 1,
      usd: 0.000012,
      promptTokens: 12_345,
      cachedPromptTokens: 2_000,
      outputTokens: 678,
      images: 0,
      audioSeconds: 0
    },
    {
      kind: "image",
      calls: 2,
      pricedCalls: 2,
      failedCalls: 0,
      inFlightCalls: 0,
      estimatedCalls: 0,
      unratedCalls: 0,
      usd: 0.08,
      promptTokens: 0,
      cachedPromptTokens: 0,
      outputTokens: 0,
      images: 2,
      audioSeconds: 0
    },
    {
      kind: "audio",
      calls: 1,
      pricedCalls: 1,
      failedCalls: 0,
      inFlightCalls: 0,
      estimatedCalls: 0,
      unratedCalls: 0,
      usd: 0.02,
      promptTokens: 0,
      cachedPromptTokens: 0,
      outputTokens: 0,
      images: 0,
      audioSeconds: 65
    }
  ],
  qualityGates: [
    {
      id: "pageLocalQa",
      label: "Local page checks",
      calls: 0,
      providerCostUsd: 0,
      costNote: "Deterministic checks; no provider call."
    },
    {
      id: "pageModelReview",
      label: "Model page review",
      calls: 8,
      providerCostUsd: 0.000012,
      costNote: null
    },
    {
      id: "planThinkingBoost",
      label: "Deeper plan thinking",
      calls: null,
      providerCostUsd: null,
      costNote: "Incremental reasoning spend is included in the planning calls it modifies."
    }
  ],
  qaRewriteTriggers: [
    {
      key: "claim_grounding+style",
      reasons: ["claim_grounding", "style"],
      calls: 3,
      providerCostUsd: 0.42
    }
  ],
  purposes: [
    {
      key: "book.plan.raw",
      label: "book.plan.raw",
      kind: "text",
      calls: 8,
      pricedCalls: 4,
      failedCalls: 1,
      inFlightCalls: 1,
      estimatedCalls: 1,
      unratedCalls: 1,
      usd: 0.000012,
      promptTokens: 12_345,
      cachedPromptTokens: 2_000,
      outputTokens: 678,
      images: 0,
      audioSeconds: 0,
      models: [
        {
          key: "text:gemini:gemini-3.5-flash",
          provider: "gemini",
          model: "gemini-3.5-flash",
          kind: "text",
          calls: 8,
          pricedCalls: 4,
          failedCalls: 1,
          inFlightCalls: 1,
          estimatedCalls: 1,
          unratedCalls: 1,
          usd: 0.000012,
          promptTokens: 12_345,
          cachedPromptTokens: 2_000,
          outputTokens: 678,
          images: 0,
          audioSeconds: 0
        }
      ]
    }
  ]
};

describe("GeneratedBooksView", () => {
  it("renders completed books collapsed with an accessible expand control", () => {
    const markup = renderToStaticMarkup(
      <GeneratedBooksView
        list={list}
        listError={null}
        listStale={false}
        expandedBookId={null}
        detail={null}
        detailError={null}
        detailLoading={false}
        onToggle={noop}
        onRetryList={noop}
        onRetryDetail={noop}
        onPrevious={noop}
        onNext={noop}
      />
    );

    expect(markup).toContain("Generated books");
    expect(markup).toContain("A Finished Book");
    expect(markup).toContain("owner@example.com");
    expect(markup).toContain("Download");
    expect(markup).toContain('href="/api/admin/projects/book-1/export/pdf"');
    expect(markup).toContain('href="/api/admin/projects/book-1/export/epub"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="generated-book-detail-book-1"');
    expect(markup).not.toContain('id="generated-book-detail-book-1"');
    expect(markup).not.toContain("Purpose and model costs");
  });

  it("renders expanded economics, active quality-gate costs, raw model costs, and an understated-spend warning", () => {
    const markup = renderToStaticMarkup(
      <GeneratedBooksView
        list={list}
        listError={null}
        listStale={false}
        expandedBookId="book-1"
        detail={detail}
        detailError={null}
        detailLoading={false}
        onToggle={noop}
        onRetryList={noop}
        onRetryDetail={noop}
        onPrevious={noop}
        onNext={noop}
      />
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('id="generated-book-detail-book-1"');
    expect(markup).toContain("Charged");
    expect(markup).toContain("Refunded");
    expect(markup).toContain("Provider cost");
    expect(markup).toContain("Margin");
    expect(markup).toContain("Text");
    expect(markup).toContain("Images");
    expect(markup).toContain("Audio");
    expect(markup).toContain("Active quality gates");
    expect(markup).toContain("Local page checks");
    expect(markup).toContain("Model page review");
    expect(markup).toContain("Deeper plan thinking");
    expect(markup).toContain("Page QA rewrite triggers");
    expect(markup).toContain("Claim grounding + Style");
    expect(markup).toContain("Exact trigger combinations; calls and cost are counted once");
    expect(markup).toContain("$0.00001 directly attributable");
    expect(markup).toContain("Not separate");
    expect(markup).toContain("Purpose and model costs");
    expect(markup).toContain("book.plan.raw");
    expect(markup).toContain("gemini-3.5-flash");
    expect(markup).toContain("1 unrated");
    expect(markup).toContain("reported spend is understated");
  });

  it("renders a completed-book empty state without an empty table", () => {
    const markup = renderToStaticMarkup(
      <GeneratedBooksView
        list={{ books: [], total: 0, limit: 25, offset: 0 }}
        listError={null}
        listStale={false}
        expandedBookId={null}
        detail={null}
        detailError={null}
        detailLoading={false}
        onToggle={noop}
        onRetryList={noop}
        onRetryDetail={noop}
        onPrevious={noop}
        onNext={noop}
      />
    );

    expect(markup).toContain("No completed books in this window.");
    expect(markup).not.toContain("<table");
  });

  it("renders the list error with its own retry action", () => {
    const markup = renderToStaticMarkup(
      <GeneratedBooksView
        list={null}
        listError="Books could not be loaded"
        listStale={false}
        expandedBookId={null}
        detail={null}
        detailError={null}
        detailLoading={false}
        onToggle={noop}
        onRetryList={noop}
        onRetryDetail={noop}
        onPrevious={noop}
        onNext={noop}
      />
    );

    expect(markup).toContain("Books could not be loaded");
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("Loading generated books");
  });

  it("renders independent previous/next pagination for more than 25 books", () => {
    const markup = renderToStaticMarkup(
      <GeneratedBooksView
        list={{ ...list, total: 51, limit: 25, offset: 25 }}
        listError={null}
        listStale={false}
        expandedBookId={null}
        detail={null}
        detailError={null}
        detailLoading={false}
        onToggle={noop}
        onRetryList={noop}
        onRetryDetail={noop}
        onPrevious={noop}
        onNext={noop}
      />
    );

    expect(markup).toContain("Previous");
    expect(markup).toContain("Next");
    expect(markup).toContain("26–50 of 51");
  });
});
