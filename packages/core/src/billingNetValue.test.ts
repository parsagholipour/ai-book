import { describe, expect, it } from "vitest";
import {
  CHEAPEST_PAID_CREDIT_USD_VALUE,
  DEFAULT_BILLING_PRODUCTS,
  PLAY_ONE_TIME_PRODUCT_FEE_RATE,
  PLAY_SUBSCRIPTION_FEE_RATE,
  SUBSCRIPTION_INTRO_OFFERS,
  billingPeriodMonths,
  introOfferForGrant,
  monthlyPlanCredits,
  netUsdPerCredit,
  playServiceFeeRate
} from "./billing.js";

const product = (sku: string) => {
  const found = DEFAULT_BILLING_PRODUCTS.find((entry) => entry.sku === sku);
  if (!found) throw new Error(`no product ${sku}`);
  return found;
};

describe("what a sold credit earns after Google's fee", () => {
  it("charges a subscription and a one-time product the rates named in one place", () => {
    expect(playServiceFeeRate("SUBSCRIPTION")).toBe(PLAY_SUBSCRIPTION_FEE_RATE);
    expect(playServiceFeeRate("CREDIT_PACK")).toBe(PLAY_ONE_TIME_PRODUCT_FEE_RATE);
    // A retired one-time unlock, or a row with no type, is a one-time product.
    expect(playServiceFeeRate("ONE_TIME_UNLOCK")).toBe(PLAY_ONE_TIME_PRODUCT_FEE_RATE);
    expect(playServiceFeeRate(null)).toBe(PLAY_ONE_TIME_PRODUCT_FEE_RATE);
  });

  it("values each plan and pack at the launch review's figures", () => {
    // 15% on both kinds of product; the pack figures assume the 15% tier enrolment.
    expect(netUsdPerCredit(product("tomeza.creator_monthly"))).toBeCloseTo(0.0028319, 7);
    expect(netUsdPerCredit(product("tomeza.pro_monthly"))).toBeCloseTo(0.0022661, 7);
    expect(netUsdPerCredit(product("tomeza.max_monthly"))).toBeCloseTo(0.0021249, 7);
    expect(netUsdPerCredit(product("tomeza.creator_yearly"))).toBeCloseTo(0.0021249, 7);
    expect(netUsdPerCredit(product("tomeza.credit_pack_1"))).toBeCloseTo(0.0067915, 7);
    expect(netUsdPerCredit(product("tomeza.credit_pack_2"))).toBeCloseTo(0.0063708, 7);
  });

  it("values the intro month at its own price and credits, and finds it from the grant", () => {
    const offer = introOfferForGrant("tomeza.creator_monthly", 4_000);
    expect(offer).toEqual(SUBSCRIPTION_INTRO_OFFERS[0]);
    expect(netUsdPerCredit({ ...offer!, productType: "SUBSCRIPTION" })).toBeCloseTo(0.0021229, 7);
    // A grant whose amount matches no offer still names the plan's only one.
    expect(introOfferForGrant("tomeza.creator_monthly", 6_000)).toEqual(SUBSCRIPTION_INTRO_OFFERS[0]);
    expect(introOfferForGrant("tomeza.max_monthly", 80_000)).toBeNull();
  });

  it("says a credit nothing priced earned nothing rather than inventing a rate", () => {
    expect(netUsdPerCredit({ priceMicros: null, creditAmount: 1_000, productType: "CREDIT_PACK" })).toBe(0);
    expect(netUsdPerCredit({ priceMicros: 7_990_000n, creditAmount: 0, productType: "CREDIT_PACK" })).toBe(0);
    expect(netUsdPerCredit({ priceMicros: 7_990_000n, creditAmount: 1_000, productType: "CREDIT_PACK" })).toBeCloseTo(0.0067915, 7);
  });

  it("takes the cheapest credit sold for money, intro offers included, as the conservative value", () => {
    expect(CHEAPEST_PAID_CREDIT_USD_VALUE).toBeCloseTo(0.002122875, 9);
  });
});

describe("what a plan grants each month", () => {
  it("grants the yearly plan's year as 6,000 every month, and a monthly plan's whole allowance", () => {
    // A credit is still valued against what one payment buys in all (above);
    // what arrives at once is a month of it.
    expect(product("tomeza.creator_yearly").creditAmount).toBe(72_000);
    expect(monthlyPlanCredits(product("tomeza.creator_yearly"))).toBe(6_000);
    expect(product("tomeza.creator_yearly").description).toMatch(/^6,000 credits every month, billed yearly\./);
    expect(monthlyPlanCredits(product("tomeza.creator_monthly"))).toBe(6_000);
    expect(monthlyPlanCredits(product("tomeza.max_monthly"))).toBe(80_000);
    expect(monthlyPlanCredits(product("tomeza.credit_pack_1"))).toBeNull();
  });

  it("counts a billing period in calendar months", () => {
    expect(billingPeriodMonths("P1M")).toBe(1);
    expect(billingPeriodMonths("P1Y")).toBe(12);
    expect(billingPeriodMonths("P3M")).toBe(3);
    expect(billingPeriodMonths("P1W")).toBeNull();
    expect(billingPeriodMonths(null)).toBeNull();
  });
});
