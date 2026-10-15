import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GrowthFunnel } from "./GrowthFunnel.js";
import type { ProductFunnel } from "./types.js";

const empty: ProductFunnel = {
  cohort: {
    signups: 0,
    welcome: { GRANTED: 0, RECENT_IP: 0, NO_IP: 0, DISABLED: 0, PENDING: 0 },
    startedChat: 0,
    builtPlan: 0,
    startedBook: 0,
    deliveredBook: 0,
    secondBook: 0,
    paid: 0
  },
  timeToFirstBook: { samples: 0, medianMinutes: null, p90Minutes: null },
  paywall: [],
  purchasesBySku: [],
  checkout: { bySku: [], failures: [], bySurface: [] },
  introConversion: [],
  churn: [],
  revenueByCountry: [],
  installSources: [],
  retention: [],
  cost: { perSignupUsd: null, perActiveUserUsd: null, activeUsers: 0, unattributedUsd: 0, perDeliveredBook: [] }
};

const render = (growth: ProductFunnel) => renderToStaticMarkup(<GrowthFunnel growth={growth} windowLabel="last 30 days" />);

describe("GrowthFunnel", () => {
  it("shows per-product cash net of Google's fee, with the gross beside it", () => {
    const markup = render({
      ...empty,
      purchasesBySku: [{ sku: "tomeza.creator_monthly", payments: 2, buyers: 2, cashUsd: 39.98, netUsd: 33.98 }]
    });

    expect(markup).toContain("creator_monthly");
    expect(markup).toContain("$33.98 net");
    expect(markup).toContain("$39.98 before");
  });

  it("renders checkouts, failures, intro conversion, churn, countries and install sources", () => {
    const markup = render({
      ...empty,
      checkout: {
        bySku: [
          { sku: "tomeza.creator_monthly", started: 5, introStarted: 3, cancelled: 2, failed: 1, starters: 4, paidWithin1Day: 2 }
        ],
        failures: [{ reason: "play_error", events: 1 }],
        bySurface: [{ surface: "export", started: 5 }]
      },
      introConversion: [{ sku: "tomeza.creator_monthly", intros: 5, due: 4, renewed: 3 }],
      churn: [{ month: "2026-09", activeAtStart: 10, ended: 2, refunded: 1, started: 4, partial: false }],
      revenueByCountry: [
        {
          country: "TR",
          orders: 2,
          buyers: 1,
          collectedUsd: 29.99,
          netUsd: 25.49,
          byCurrency: [{ currency: "TRY", orders: 2, localKept: 450.06 }]
        },
        { country: null, orders: 1, buyers: 1, collectedUsd: 4.99, netUsd: 4.24, byCurrency: [{ currency: null, orders: 1, localKept: 0 }] }
      ],
      installSources: [
        { source: "share", medium: "none", installs: 4, readers: 3, newAccounts: 2, fromShares: 3, paid: 1 }
      ]
    });

    expect(markup).toContain("5 started (3 intro)");
    expect(markup).toContain("2 of 4 readers paid within a day (50%)");
    expect(markup).toContain("Google Play error");
    expect(markup).toContain("Export 5");
    expect(markup).toContain("3 of 4 due paid full price (75%)");
    expect(markup).toContain("1 still in their intro");
    expect(markup).toContain("10 subscribed at start");
    expect(markup).toContain("20% churn, 1 refunded");
    expect(markup).toContain("TR");
    expect(markup).toContain("$25.49 net");
    expect(markup).toContain("TRY 450.06");
    expect(markup).toContain("Unknown country");
    expect(markup).toContain("no local price");
    expect(markup).toContain("share / none");
    expect(markup).toContain("3 readers (2 new accounts)");
  });

  it("says nothing has happened yet rather than rendering empty sections", () => {
    const markup = render(empty);

    expect(markup).toContain("no intro offers yet");
    expect(markup.match(/none yet/g)?.length).toBe(4);
  });
});
