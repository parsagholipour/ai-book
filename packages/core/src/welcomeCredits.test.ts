import { describe, expect, it } from "vitest";
import { CREDIT_PRICE_KEYS, DEFAULT_CREDIT_COSTS, creditPricingInputSchema, normalizeCreditPricing } from "./creditPricing.js";
import { welcomeCreditAmount, welcomeCreditIpLimit, welcomeCreditRegion } from "./welcomeCredits.js";

const regional = {
  ...DEFAULT_CREDIT_COSTS,
  welcomeCreditsRegionalEnabled: 1,
  welcomeCredits: 250,
  welcomeCreditsHighIncome: 1500,
  welcomeCreditsLowMiddleIncome: 500
};

describe("welcome credit offers", () => {
  it.each("US CA AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO AX GF GP MQ MF RE YT".split(" "))(
    "keeps %s in the shared high-income offer", (country) => {
      expect(welcomeCreditRegion(country)).toBe("HIGH_INCOME");
      expect(welcomeCreditAmount(country, regional)).toBe(1500);
    }
  );
  it.each(["IN", "PK", "BD", "ID", "CN", "IR", "TR", "ZA", "NG", "EG", "KE", "BR", "AR", "PE", "MX", "ET", "VE", "XK"])(
    "uses the low- and middle-income amount for %s", (country) => {
      expect(welcomeCreditRegion(country)).toBe("LOW_MIDDLE_INCOME");
      expect(welcomeCreditAmount(country, regional)).toBe(500);
    }
  );
  it.each(["JP", "KR", "SG", "AE", "QA", "SA", "GB", "AU", "NZ", "CH", "CR", "CL", "UY", "GY", "SC", "TW", "HK", "MO", "JE", "GG"])(
    "uses the high-income amount for %s regardless of continent", (country) => {
      expect(welcomeCreditRegion(country)).toBe("HIGH_INCOME");
      expect(welcomeCreditAmount(country, regional)).toBe(1500);
    }
  );
  it.each([null, undefined, "", "XX", "T1", "AQ", "ZZ"])(
    "uses the fallback for %s", (country) => expect(welcomeCreditAmount(country, regional)).toBe(250)
  );
  it("normalizes country codes and includes EU territories without a separate income classification", () => {
    expect(welcomeCreditAmount(" cy ", regional)).toBe(1500);
    expect(welcomeCreditAmount("gf", regional)).toBe(1500);
  });
  it("supports global off, regional off, and zero amounts per group", () => {
    for (const country of ["US", "IN", null]) {
      expect(welcomeCreditAmount(country, { ...regional, welcomeCreditsEnabled: 0 })).toBe(0);
      expect(welcomeCreditAmount(country, { ...regional, welcomeCreditsRegionalEnabled: 0 })).toBe(250);
    }
    expect(welcomeCreditAmount("US", { ...regional, welcomeCreditsHighIncome: 0 })).toBe(0);
  });
  it("preserves old global settings until regional offers are enabled", () => {
    const old = normalizeCreditPricing({ welcomeCredits: 700, welcomeCreditsEnabled: 1 });
    expect(welcomeCreditAmount("US", old)).toBe(700);
    expect(welcomeCreditAmount("IN", old)).toBe(700);
  });
  it("preserves saved amounts from earlier geographic settings", () => {
    const old = normalizeCreditPricing({ welcomeCreditsRegionalEnabled: 1, welcomeCreditsUsEuCanada: 2200,
      welcomeCreditsAsiaAfricaSouthAmerica: 300 });
    expect(welcomeCreditAmount("IN", old)).toBe(300);
    expect(welcomeCreditAmount("JP", old)).toBe(2200);
    expect(welcomeCreditAmount("US", old)).toBe(2200);
  });
  it("prefers explicit income amounts, including zero, over earlier regional amounts", () => {
    const values = normalizeCreditPricing({ ...regional, welcomeCreditsHighIncome: 0,
      welcomeCreditsUsEuCanada: 9000, welcomeCreditsAsiaAfricaSouthAmerica: 9000 });
    expect(welcomeCreditAmount("JP", values)).toBe(0);
    expect(welcomeCreditAmount("IN", values)).toBe(500);
  });
  it.each([
    { welcomeCreditsRegionalEnabled: 2 }, { welcomeCreditsHighIncome: -1 },
    { welcomeCreditsLowMiddleIncome: 0.5 }, { welcomeCreditsHighIncome: 100001 },
    { welcomeCreditsAccountsPerIpHighIncome: -1 }, { welcomeCreditsAccountsPerIpLowMiddleIncome: -1 },
    { welcomeCreditsAccountsPerIpHighIncome: 1.5 }, { welcomeCreditsAccountsPerIpLowMiddleIncome: 1.5 },
    { welcomeCreditsAccountsPerIpHighIncome: 101 }, { welcomeCreditsAccountsPerIpLowMiddleIncome: 101 }
  ])("rejects invalid admin values: %j", (override) => {
    expect(creditPricingInputSchema.safeParse({ ...regional, ...override }).success).toBe(false);
  });
  it("does not count welcome gifts as revenue", () => {
    expect(CREDIT_PRICE_KEYS.some((key) => key.startsWith("welcomeCredits"))).toBe(false);
  });
});

describe("welcome credit IP limits", () => {
  it.each([["US", 4], ["JP", 4], ["GF", 4], ["IN", 3], ["BR", 3], [null, 3], ["AQ", 3]] as const)(
    "uses the configured account cap for %s", (country, limit) => {
      expect(welcomeCreditIpLimit(country, {
        ...DEFAULT_CREDIT_COSTS,
        welcomeCreditsAccountsPerIpHighIncome: 4,
        welcomeCreditsAccountsPerIpLowMiddleIncome: 3
      })).toBe(limit);
    }
  );

  it("backfills existing pricing revisions with the current two/one defaults", () => {
    const old = normalizeCreditPricing({ welcomeCredits: 700 });
    expect(welcomeCreditIpLimit("US", old)).toBe(2);
    expect(welcomeCreditIpLimit("IN", old)).toBe(1);
    expect(welcomeCreditIpLimit(null, old)).toBe(1);
  });

  it("keeps country caps active with regional amounts off and preserves zero", () => {
    const pricing = normalizeCreditPricing({ welcomeCreditsRegionalEnabled: 0,
      welcomeCreditsAccountsPerIpHighIncome: 0, welcomeCreditsAccountsPerIpLowMiddleIncome: 5 });
    expect(welcomeCreditIpLimit("US", pricing)).toBe(0);
    expect(welcomeCreditIpLimit("IN", pricing)).toBe(5);
    expect(welcomeCreditIpLimit(null, pricing)).toBe(5);
  });
});
