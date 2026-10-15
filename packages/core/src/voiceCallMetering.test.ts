import {
  FREE_CALL_SECONDS,
  VOICE_CALL_POLICY,
  billableVoiceCallMinutes,
  planVoiceCallHold,
  settleVoiceCall,
  voiceCallEndingReason,
  voiceCallSecondsRemaining,
  voiceCallStartingCredits,
  voiceRelayCallRunway
} from "./voiceCallMetering.js";
import { creditPricing, resetCreditPricing, setCreditPricing } from "./creditPricing.js";
import { afterEach, describe, expect, it } from "vitest";

const perMinute = creditPricing().voiceCallPerMinute;

afterEach(() => {
  resetCreditPricing();
});

describe("VOICE_CALL_POLICY", () => {
  it("caps a call at fifteen minutes", () => {
    // Every bound on a call's length derives from this one number: the relay's
    // funded minutes, the settlement, the provider token and `maxCallSeconds`.
    expect(VOICE_CALL_POLICY.maxCallMinutes).toBe(15);
    expect(settleVoiceCall(30 * 60).billableMinutes).toBe(15);
  });
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

describe("voiceRelayCallRunway", () => {
  const lead = VOICE_CALL_POLICY.endingLeadSeconds;

  it("runs to the cap while the balance can pay, however thin the hold is", () => {
    // Ten seconds before the relay holds its next minute: the old meter said
    // "out of credits, 0:10" here.
    expect(voiceRelayCallRunway({ elapsedSeconds: 230, reservedMinutes: 4, affordableMinutes: 50 })).toEqual({
      secondsRemaining: 900 - 230 - lead,
      endingReason: null
    });
  });

  it("names the cap for its last block and reaches zero ahead of the relay's deadline", () => {
    expect(voiceRelayCallRunway({ elapsedSeconds: 900 - lead - 181, reservedMinutes: 12, affordableMinutes: 50 }))
      .toEqual({ secondsRemaining: 181, endingReason: null });
    expect(voiceRelayCallRunway({ elapsedSeconds: 900 - lead - 180, reservedMinutes: 12, affordableMinutes: 50 }))
      .toEqual({ secondsRemaining: 180, endingReason: "limit" });
    expect(voiceRelayCallRunway({ elapsedSeconds: 900 - lead, reservedMinutes: 15, affordableMinutes: 50 }))
      .toEqual({ secondsRemaining: 0, endingReason: "limit" });
    expect(voiceRelayCallRunway({ elapsedSeconds: 900, reservedMinutes: 15, affordableMinutes: 50 }).secondsRemaining)
      .toBe(0);
  });

  it("names the credits when the balance runs out before the cap", () => {
    // Four minutes held and two more affordable: the call can reach six, and
    // says why once it is inside the last block.
    expect(voiceRelayCallRunway({ elapsedSeconds: 100, reservedMinutes: 4, affordableMinutes: 2 })).toEqual({
      secondsRemaining: 360 - 100 - lead,
      endingReason: null
    });
    expect(voiceRelayCallRunway({ elapsedSeconds: 200, reservedMinutes: 4, affordableMinutes: 2 })).toEqual({
      secondsRemaining: 360 - 200 - lead,
      endingReason: "credits"
    });
    expect(voiceRelayCallRunway({ elapsedSeconds: 60, reservedMinutes: 3, affordableMinutes: 30 }).endingReason)
      .toBeNull();
  });

  it("names the cap when the balance would run out at the cap anyway", () => {
    expect(voiceRelayCallRunway({ elapsedSeconds: 800, reservedMinutes: 14, affordableMinutes: 1 }).endingReason)
      .toBe("limit");
  });

  it("gives a free rate the whole cap", () => {
    expect(voiceRelayCallRunway({ elapsedSeconds: 0, reservedMinutes: 3, affordableMinutes: Number.POSITIVE_INFINITY }))
      .toEqual({ secondsRemaining: 900 - lead, endingReason: null });
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
