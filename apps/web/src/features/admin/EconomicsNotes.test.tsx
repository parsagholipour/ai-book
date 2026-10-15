import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CurrencyRevenueSection, ValuationNote } from "./EconomicsNotes.js";
import type { CreditValuation, CurrencyRevenue } from "./types.js";

const valuation: CreditValuation = {
  method: "Credits are valued by where they came from, net of the store fee.",
  subscriptionFeeRate: 0.15,
  oneTimeFeeRate: 0.15,
  rates: [
    { key: "tomeza.creator_monthly", label: "Creator", usdPerCredit: 0.0028319 },
    { key: "welcome", label: "Welcome credits", usdPerCredit: 0 }
  ],
  cheapestPaidUsdPerCredit: 0.0021229
};

describe("ValuationNote", () => {
  it("states the server's method, each source's rate and the fee-tier caveat", () => {
    const markup = renderToStaticMarkup(<ValuationNote valuation={valuation} />);

    expect(markup).toContain(valuation.method);
    expect(markup).toContain("Creator");
    expect(markup).toContain("$0.00283");
    expect(markup).toContain("$2.83");
    expect(markup).toContain("Welcome credits");
    expect(markup).toContain("15% on subscriptions");
    expect(markup).toContain("otherwise Google keeps 30%");
  });

  it("renders nothing for an API that sends no valuation", () => {
    expect(renderToStaticMarkup(<ValuationNote valuation={undefined} />)).toBe("");
  });
});

describe("CurrencyRevenueSection", () => {
  const rows: CurrencyRevenue[] = [
    {
      currency: "EUR",
      orders: 3,
      refundedOrders: 1,
      localGross: 22.47,
      localKept: 14.98,
      sources: { client: 2, playRecurringPrice: 1 },
      catalogUsd: 15.98
    },
    {
      currency: null,
      orders: 2,
      refundedOrders: 0,
      localGross: 0,
      localKept: 0,
      sources: { client: 0, playRecurringPrice: 0 },
      catalogUsd: 39.98
    }
  ];

  it("shows each currency's own amounts unconverted, beside the catalog USD and where the price came from", () => {
    const markup = renderToStaticMarkup(<CurrencyRevenueSection rows={rows} windowLabel="last 30 days" />);

    expect(markup).toContain("Not converted to dollars");
    expect(markup).toContain("EUR");
    expect(markup).toContain("1 refunded");
    expect(markup).toContain("2 from the app");
    expect(markup).toContain("1 from Google&#x27;s plan price");
    expect(markup).toContain("$15.98");
    // Orders from builds that never reported a price get their own row, with no local amount.
    expect(markup).toContain("Not recorded");
    expect(markup).toContain("an app build that did not report it");
  });

  it("says so when the window had no orders", () => {
    const markup = renderToStaticMarkup(<CurrencyRevenueSection rows={[]} windowLabel="last 7 days" />);

    expect(markup).toContain("No orders in this window.");
  });
});
