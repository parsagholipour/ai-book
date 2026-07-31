import {
  FREE_CALL_SECONDS,
  VOICE_CALL_POLICY,
  billableVoiceCallMinutes,
  planVoiceCallHold,
  settleVoiceCall,
  voiceCallEndingReason,
  voiceCallSecondsRemaining,
  voiceCallStartingCredits
} from "./voiceCallMetering.js";
import { creditPricing, resetCreditPricing, setCreditPricing } from "./creditPricing.js";
import { afterEach, describe, expect, it } from "vitest";

const perMinute = creditPricing().voiceCallPerMinute;

afterEach(() => {
  resetCreditPricing();
});

describe("billableVoiceCallMinutes", () => {
  it("rounds a started minute up", () => {
    expect(billableVoiceCallMinutes(1)).toBe(1);
    expect(billableVoiceCallMinutes(60)).toBe(1);
    expect(billableVoiceCallMinutes(61)).toBe(2);
  });

  it("charges nothing for a call with no time on it", () => {
    expect(billableVoiceCallMinutes(0)).toBe(0);
    expect(billableVoiceCallMinutes(-5)).toBe(0);
    expect(billableVoiceCallMinutes(Number.NaN)).toBe(0);
  });
});

describe("settleVoiceCall", () => {
  it("does not charge for a call that dropped before it started", () => {
    const settlement = settleVoiceCall(FREE_CALL_SECONDS - 1);
    expect(settlement.credits).toBe(0);
    expect(settlement.billableMinutes).toBe(0);
  });

  it("charges the rounded-up minutes actually spoken", () => {
    expect(settleVoiceCall(75).credits).toBe(2 * perMinute);
  });

  it("never charges past the call length the user was promised", () => {
    const wayOver = VOICE_CALL_POLICY.maxCallMinutes * 60 + 10_000;
    expect(settleVoiceCall(wayOver).credits).toBe(VOICE_CALL_POLICY.maxCallMinutes * perMinute);
  });
});

describe("planVoiceCallHold", () => {
  it("opens a call holding a full block of headroom", () => {
    const plan = planVoiceCallHold({ elapsedSeconds: 0, heldCredits: 0 });
    expect(plan.additionalCredits).toBe(voiceCallStartingCredits());
    expect(plan.targetHeldCredits).toBe(VOICE_CALL_POLICY.reserveBlockMinutes * perMinute);
  });

  it("tops the hold up as the call eats into it", () => {
    const opening = voiceCallStartingCredits();
    const plan = planVoiceCallHold({ elapsedSeconds: 90, heldCredits: opening });
    // Two minutes used, so the hold has to reach two plus the block.
    expect(plan.targetHeldCredits).toBe((2 + VOICE_CALL_POLICY.reserveBlockMinutes) * perMinute);
    expect(plan.additionalCredits).toBe(2 * perMinute);
  });

  it("asks for nothing when the hold is already deep enough", () => {
    const deep = 50 * perMinute;
    expect(planVoiceCallHold({ elapsedSeconds: 30, heldCredits: deep }).additionalCredits).toBe(0);
  });

  it("stops extending at the maximum call length", () => {
    const nearTheEnd = (VOICE_CALL_POLICY.maxCallMinutes - 1) * 60;
    const plan = planVoiceCallHold({ elapsedSeconds: nearTheEnd, heldCredits: 0 });
    expect(plan.targetHeldCredits).toBe(VOICE_CALL_POLICY.maxCallMinutes * perMinute);
  });
});

describe("voiceCallSecondsRemaining", () => {
  it("reports the time the current hold pays for", () => {
    expect(voiceCallSecondsRemaining({ elapsedSeconds: 0, heldCredits: 3 * perMinute })).toBe(180);
    expect(voiceCallSecondsRemaining({ elapsedSeconds: 100, heldCredits: 3 * perMinute })).toBe(80);
  });

  it("floors at zero rather than going negative", () => {
    expect(voiceCallSecondsRemaining({ elapsedSeconds: 500, heldCredits: perMinute })).toBe(0);
  });

  it("ignores credits that do not add up to a whole minute", () => {
    expect(voiceCallSecondsRemaining({ elapsedSeconds: 0, heldCredits: perMinute - 1 })).toBe(0);
  });
});

describe("voiceCallEndingReason", () => {
  it("names credits when the hold could not be topped up", () => {
    expect(
      voiceCallEndingReason({ elapsedSeconds: 120, heldCredits: 3 * perMinute, topUpFailed: true })
    ).toBe("credits");
  });

  it("names the length cap when the call is simply running long", () => {
    // Nothing throws at the cap — the hold just stops growing — so elapsed time
    // is the only thing that tells the two apart.
    const nearTheCap = (VOICE_CALL_POLICY.maxCallMinutes - 1) * 60;
    expect(
      voiceCallEndingReason({ elapsedSeconds: nearTheCap, heldCredits: 999 * perMinute, topUpFailed: false })
    ).toBe("limit");
  });

  it("says nothing about a healthy call", () => {
    expect(
      voiceCallEndingReason({ elapsedSeconds: 90, heldCredits: 5 * perMinute, topUpFailed: false })
    ).toBeNull();
  });

  it("blames credits rather than the cap when both could apply", () => {
    // Running dry is the one the caller can do something about.
    const nearTheCap = (VOICE_CALL_POLICY.maxCallMinutes - 1) * 60;
    expect(
      voiceCallEndingReason({ elapsedSeconds: nearTheCap, heldCredits: 0, topUpFailed: true })
    ).toBe("credits");
  });
});

describe("live pricing", () => {
  it("charges the rate in force at settlement, not the one compiled in", () => {
    setCreditPricing({ ...creditPricing(), voiceCallPerMinute: 90 });
    expect(settleVoiceCall(75).credits).toBe(180);
    expect(voiceCallStartingCredits()).toBe(VOICE_CALL_POLICY.reserveBlockMinutes * 90);
    expect(planVoiceCallHold({ elapsedSeconds: 0, heldCredits: 0 }).targetHeldCredits).toBe(
      VOICE_CALL_POLICY.reserveBlockMinutes * 90
    );
    expect(voiceCallSecondsRemaining({ elapsedSeconds: 0, heldCredits: 180 })).toBe(120);
  });

  it("gives a free call the full length cap instead of dividing by zero", () => {
    setCreditPricing({ ...creditPricing(), voiceCallPerMinute: 0 });
    expect(settleVoiceCall(75).credits).toBe(0);
    expect(voiceCallStartingCredits()).toBe(0);
    expect(voiceCallSecondsRemaining({ elapsedSeconds: 60, heldCredits: 0 })).toBe(
      VOICE_CALL_POLICY.maxCallMinutes * 60 - 60
    );
  });

  it("can be priced explicitly without touching the live snapshot", () => {
    const proposed = { ...creditPricing(), voiceCallPerMinute: 500 };
    expect(settleVoiceCall(30, proposed).credits).toBe(500);
    expect(settleVoiceCall(30).credits).toBe(perMinute);
  });
});
