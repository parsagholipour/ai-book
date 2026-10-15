import { describe, expect, it } from "vitest";
import { freshAlertState, newerAlertState, stepAlert, type AlertObservation, type AlertPolicy, type AlertState } from "./alertState.js";

const MINUTE = 60_000;
const policy: AlertPolicy = { confirmSweeps: 3, clearSweeps: 2, repeat: { kind: "cooldown", ms: 60 * MINUTE } };
const fail: AlertObservation = { failing: true, detail: "Postgres timed out" };
const pass: AlertObservation = { failing: false };
const start = new Date("2026-10-13T10:00:00.000Z");

/** Runs one observation per minute and returns every email kind sent, in order. */
function run(observations: AlertObservation[], from: AlertState = freshAlertState("db"), p: AlertPolicy = policy, at = start) {
  let state = from;
  const sent: string[] = [];
  observations.forEach((observation, index) => {
    const step = stepAlert(state, observation, p, new Date(at.getTime() + index * MINUTE));
    state = step.state;
    if (step.notification) sent.push(step.notification.kind);
  });
  return { state, sent };
}

describe("stepAlert", () => {
  it("fires once, only after the confirming sweeps, and recovers once", () => {
    expect(run([fail, fail]).sent).toEqual([]);
    const { state, sent } = run([fail, fail, fail, fail, fail, pass, pass]);
    expect(sent).toEqual(["firing", "recovered"]);
    expect(state.firing).toBe(false);
    expect(state.notified).toBe(false);
  });

  it("does not recover on a single good sweep, so a check at its edge is one alert", () => {
    const { state, sent } = run([fail, fail, fail, pass, fail, pass, fail, pass, fail]);
    expect(sent).toEqual(["firing"]);
    expect(state.firing).toBe(true);
  });

  it("holds a re-fire inside the cooldown and tells the owner once it has passed, if still failing", () => {
    // Fires at minute 2, recovers at 4, fails again from 5.
    const observations: AlertObservation[] = [fail, fail, fail, pass, pass, fail, fail, fail];
    const flapped = run(observations);
    expect(flapped.sent).toEqual(["firing", "recovered"]);
    expect(flapped.state).toMatchObject({ firing: true, notified: false });

    const stillFailing = run([...observations, ...Array<AlertObservation>(60).fill(fail)]);
    expect(stillFailing.sent).toEqual(["firing", "recovered", "firing"]);
    expect(stillFailing.state.lastFiredAt?.getTime()).toBe(start.getTime() + 62 * MINUTE);
  });

  it("drops a held re-fire that clears before its window, with no recovery for an alert never sent", () => {
    const { state, sent } = run([fail, fail, fail, pass, pass, fail, fail, fail, pass, pass]);
    expect(sent).toEqual(["firing", "recovered"]);
    expect(state).toMatchObject({ firing: false, notified: false });
  });

  it("leaves everything as it was for a sweep that could not measure", () => {
    const before = run([fail, fail]).state;
    expect(stepAlert(before, null, policy, new Date(start.getTime() + 10 * MINUTE)).state).toBe(before);
    const { sent } = run([fail, null, null, fail, null, fail]);
    expect(sent).toEqual(["firing"]);
  });

  it("allows one alert per UTC day for a daily condition, and recovers when it clears", () => {
    const daily: AlertPolicy = { confirmSweeps: 1, clearSweeps: 1, repeat: { kind: "utc-day" } };
    const evening = new Date("2026-10-13T23:58:00.000Z");
    const { sent } = run([fail, pass, fail, fail, pass, fail], freshAlertState("spend_soft"), daily, evening);
    // 23:58 fires, 23:59 recovers, 00:00 is a new day and fires again,
    // 00:02 recovers, 00:03 is held until the next day.
    expect(sent).toEqual(["firing", "recovered", "firing", "recovered"]);
  });

  it("carries what was wrong into the recovery and when it began", () => {
    let state = freshAlertState("db");
    const notifications = [];
    for (const [index, observation] of [fail, fail, fail, pass, pass].entries()) {
      const step = stepAlert(state, observation, policy, new Date(start.getTime() + index * MINUTE));
      state = step.state;
      if (step.notification) notifications.push(step.notification);
    }
    expect(notifications[1]).toEqual({
      key: "db",
      kind: "recovered",
      detail: "Postgres timed out",
      firingSince: new Date(start.getTime() + 2 * MINUTE)
    });
  });
});

describe("newerAlertState", () => {
  it("prefers whichever copy was observed later", () => {
    const older = { ...freshAlertState("db"), observedAt: new Date(1_000) };
    const newer = { ...freshAlertState("db"), observedAt: new Date(2_000), firing: true };
    expect(newerAlertState(older, newer)).toBe(newer);
    expect(newerAlertState(newer, older)).toBe(newer);
    expect(newerAlertState(undefined, older)).toBe(older);
    expect(newerAlertState(older, undefined)).toBe(older);
    expect(newerAlertState(freshAlertState("db"), older)).toBe(older);
  });
});
