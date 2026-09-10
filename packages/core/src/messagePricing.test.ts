import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, setCreditPricing } from "./creditPricing.js";
import { messagePolicy } from "./messagePricing.js";

afterEach(() => {
  resetCreditPricing();
});

describe("messagePolicy", () => {
  it.each([
    ["free", 0, 50, 50, "messageCreditsFree", "messageResetCreditsFree"],
    ["creator", 0, 150, 100, "messageCreditsCreator", "messageResetCreditsCreator"],
    ["pro", 0, 300, 150, "messageCreditsPro", "messageResetCreditsPro"],
    ["max", 0, 600, 200, "messageCreditsMax", "messageResetCreditsMax"]
  ] as const)(
    "reads %s defaults from that plan's own keys",
    (tier, creditsPerMessage, dailyLimit, resetCredits, messagePricingKey, resetPricingKey) => {
      expect(messagePolicy(tier)).toEqual({
        creditsPerMessage,
        dailyLimit,
        resetCredits,
        resetEnabled: true,
        messagePricingKey,
        resetPricingKey
      });
    }
  );

  it("uses an explicit pricing argument without moving the live snapshot", () => {
    // Dashboard preview: quote a proposed change without making it real mid-request.
    const proposed = { ...DEFAULT_CREDIT_COSTS, messageCreditsPro: 3, messageResetEnabledPro: 0 };
    expect(messagePolicy("pro", proposed)).toEqual({
      creditsPerMessage: 3,
      dailyLimit: DEFAULT_CREDIT_COSTS.messageDailyLimitPro,
      resetCredits: DEFAULT_CREDIT_COSTS.messageResetCreditsPro,
      resetEnabled: false,
      messagePricingKey: "messageCreditsPro",
      resetPricingKey: "messageResetCreditsPro"
    });
    expect(messagePolicy("pro")).toMatchObject({
      creditsPerMessage: DEFAULT_CREDIT_COSTS.messageCreditsPro,
      resetEnabled: true
    });
  });

  it("treats the reset flag as enabled only when it is 1", () => {
    expect(messagePolicy("free", { ...DEFAULT_CREDIT_COSTS, messageResetEnabledFree: 0 }).resetEnabled).toBe(
      false
    );
    expect(messagePolicy("free", { ...DEFAULT_CREDIT_COSTS, messageResetEnabledFree: 1 }).resetEnabled).toBe(
      true
    );
  });

  it("reads the live snapshot when no pricing argument is given", () => {
    setCreditPricing({
      ...DEFAULT_CREDIT_COSTS,
      messageCreditsPro: 3,
      messageDailyLimitPro: 12,
      messageResetCreditsPro: 9,
      messageResetEnabledPro: 0
    });
    expect(messagePolicy("pro")).toEqual({
      creditsPerMessage: 3,
      dailyLimit: 12,
      resetCredits: 9,
      resetEnabled: false,
      messagePricingKey: "messageCreditsPro",
      resetPricingKey: "messageResetCreditsPro"
    });
  });
});
