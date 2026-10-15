/**
 * One alert condition's life, as a pure step from the stored state and this
 * sweep's observation to the next state and the email it owes, if any.
 *
 * An alert is a state, not an event. A condition must fail `confirmSweeps`
 * sweeps in a row before it fires, so a deploy's restart or one slow query is
 * not an email; it must pass `clearSweeps` in a row before it clears, so a check
 * hovering at its edge does not recover and fire every minute. Firing and
 * telling the owner are separate: a condition that fires again inside its
 * repeat window is *firing but not notified* — no second email — and is told
 * once the window has passed if it is still firing then, or silently dropped
 * if it clears first. A recovery is owed only for a firing the owner was told
 * about, so every recovery email answers exactly one alert email.
 */

export type AlertRepeat = { kind: "cooldown"; ms: number } | { kind: "utc-day" };

export type AlertPolicy = {
  confirmSweeps: number;
  clearSweeps: number;
  /** The least time between two alert emails for one condition. */
  repeat: AlertRepeat;
};

export type AlertState = {
  key: string;
  firing: boolean;
  notified: boolean;
  failingSweeps: number;
  passingSweeps: number;
  detail: string | null;
  firingSince: Date | null;
  lastFiredAt: Date | null;
  lastRecoveredAt: Date | null;
  observedAt: Date | null;
};

/** `null` is "not measured this sweep": neither a failure nor a pass, and nothing moves. */
export type AlertObservation = { failing: true; detail: string } | { failing: false } | null;

export type AlertNotification = {
  key: string;
  kind: "firing" | "recovered";
  /** For a firing, what is wrong now; for a recovery, the last thing that was. */
  detail: string | null;
  firingSince: Date | null;
};

export function freshAlertState(key: string): AlertState {
  return {
    key,
    firing: false,
    notified: false,
    failingSweeps: 0,
    passingSweeps: 0,
    detail: null,
    firingSince: null,
    lastFiredAt: null,
    lastRecoveredAt: null,
    observedAt: null
  };
}

export function stepAlert(
  state: AlertState,
  observation: AlertObservation,
  policy: AlertPolicy,
  now: Date
): { state: AlertState; notification: AlertNotification | null } {
  if (observation === null) {
    return { state, notification: null };
  }
  const next: AlertState = { ...state, observedAt: now };
  if (observation.failing) {
    next.failingSweeps = state.failingSweeps + 1;
    next.passingSweeps = 0;
    next.detail = observation.detail;
    if (!next.firing && next.failingSweeps >= policy.confirmSweeps) {
      next.firing = true;
      next.firingSince = now;
    }
  } else {
    next.passingSweeps = state.passingSweeps + 1;
    next.failingSweeps = 0;
    if (next.firing && next.passingSweeps >= policy.clearSweeps) {
      const firingSince = next.firingSince;
      next.firing = false;
      next.firingSince = null;
      if (!next.notified) {
        // Fired inside its repeat window and cleared before it was told: the
        // owner heard neither half, which is the point of the window.
        return { state: next, notification: null };
      }
      next.notified = false;
      next.lastRecoveredAt = now;
      return { state: next, notification: { key: state.key, kind: "recovered", detail: state.detail, firingSince } };
    }
  }
  if (next.firing && !next.notified && mayNotify(policy.repeat, next.lastFiredAt, now)) {
    next.notified = true;
    next.lastFiredAt = now;
    return { state: next, notification: { key: state.key, kind: "firing", detail: next.detail, firingSince: next.firingSince } };
  }
  return { state: next, notification: null };
}

function mayNotify(repeat: AlertRepeat, lastFiredAt: Date | null, now: Date): boolean {
  if (!lastFiredAt) return true;
  if (repeat.kind === "utc-day") {
    return lastFiredAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10);
  }
  return now.getTime() - lastFiredAt.getTime() >= repeat.ms;
}

/**
 * Of two copies of one condition's state, the one observed later — the
 * database's after a restart or another process's sweep, this process's own
 * after a sweep it could not save (the database was the thing that was down).
 */
export function newerAlertState(memory: AlertState | undefined, stored: AlertState | undefined): AlertState | undefined {
  if (!memory) return stored;
  if (!stored) return memory;
  const memoryAt = memory.observedAt?.getTime() ?? -Infinity;
  const storedAt = stored.observedAt?.getTime() ?? -Infinity;
  return memoryAt > storedAt ? memory : stored;
}
