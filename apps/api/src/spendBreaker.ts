import { prisma, type Prisma } from "@book-maker/db";
import { hasActiveSubscriptionEntitlement } from "@book-maker/db/billing";
import { providerSpendSince } from "@book-maker/db/providerSpend";
import { DEFAULT_LOCAL_ADMIN_USER_ID } from "./localAdminUser.js";
import { freeSideUsd, NO_SPEND, readSpendBreakdown, type SpendBreakdown } from "./spendBreakdown.js";
import { DEFAULT_AI_SPEND_CONTROLS, readAiSpendControls, type AiSpendControls } from "./spendControls.js";

/**
 * The AI spend breaker: "may this reader start this kind of AI work now?"
 *
 * Every door in the API that starts AI work — an inline model call, or a job
 * that makes one — asks {@link SpendBreaker.check} before it reserves credits,
 * claims a free-tier slot or hits a rate limiter, so a refusal costs nothing and
 * claims nothing (`mobile/aiCapacity.ts` is the door side). It never pauses the
 * worker: a queued job was paid for when it was queued, and it runs.
 *
 * The global caps protect the budget from the spend nobody pays for, so they
 * count **free spend** (readers with no plan plus unattributed calls,
 * `spendBreakdown.ts`) and stop only free accounts. A paying reader is stopped
 * by their own daily cap, by a pause, or by the paid cap — a catastrophe stop
 * on paid spend, which revenue backs (`spendControls.ts` has the arithmetic).
 *
 * | state                                   | free plan                           | paid plan     |
 * |-----------------------------------------|-------------------------------------|---------------|
 * | paused by the operator                  | 503 AI_PAUSED                       | 503 AI_PAUSED |
 * | free spend this month >= monthly cap    | 503 AI_PAUSED (until month or raise)| as normal     |
 * | free spend today >= hard cap            | 503 AI_PAUSED (until 00:00 UTC)     | as normal     |
 * | free spend today >= soft cap            | Ultra, voice, audiobook: AI_BUSY;   | as normal     |
 * |                                         | welcome credits held                |               |
 *
 * (Voice and audiobooks stay in that row as a backstop, but a free account
 * never reaches it on them: both are plan perks, refused with
 * SUBSCRIPTION_REQUIRED before the breaker is asked — `mobile/planPerks.ts`.
 * In practice the soft cap holds back a free account's Ultra and its welcome
 * credits.)
 * | paid spend today >= paid cap            | (its own row above)                 | 503 AI_PAUSED |
 * | normal                                  | per-reader cap                      | per-reader cap|
 *
 * and in every state that lets a request through, a reader whose own spend
 * today has reached their cap (free or paid, by active plan) gets 429
 * AI_DAILY_LIMIT until 00:00 UTC. The operator's `local-admin` user is never a
 * free account and has no per-reader cap; the operator console's routes never
 * ask at all.
 *
 * **It fails open, except for a pause it has already seen.** The breaker exists
 * to protect a budget, not to be a second way for the product to go down, so a
 * failed read never refuses anyone on a number it did not observe: a controls
 * read that fails keeps the last controls this process read (a pause included)
 * or the defaults, a spend read that fails keeps the spend already seen today or
 * this month (spend only grows within a window, so that is still a floor) or
 * zero, and a reader's spend or plan that cannot be read is treated as zero and
 * as paid. Every failure is logged at error level.
 *
 * Global state is read at most once a minute per process, single-flight, so a
 * burst at a door is one aggregate: today's split every minute, and the month's
 * earlier days once per UTC day (they no longer move). A reader's spend is one
 * indexed aggregate cached for a few seconds, so a reader can run a few seconds
 * past their cap: spend is only recorded once a call settles anyway, and the cap
 * is a backstop, not a meter.
 */

/**
 * `speculative` is work nobody has asked or paid for yet: the composition prep a plan door queues for its plan
 * (harness redesign H4). A free account past the soft cap is refused it, like Ultra.
 */
export type AiWorkKind = "standard" | "ultra" | "voice" | "audiobook" | "speculative";

/** Where free accounts stand. */
export type SpendState = "normal" | "soft" | "hard" | "monthly" | "paused";

/** Where paid accounts stand. */
export type PaidSpendState = "normal" | "capped" | "paused";

/** The kinds a free account may not start while the day is past the soft cap. */
const SOFT_RESTRICTED_KINDS: ReadonlySet<AiWorkKind> = new Set<AiWorkKind>(["ultra", "voice", "audiobook", "speculative"]);

export type AiAccessDecision =
  | { allowed: true }
  /** Paused by the operator, or a paying reader past the paid cap. */
  | { allowed: false; code: "AI_PAUSED"; state: "paused" | "paid_cap" }
  /** A free reader past the hard cap (until 00:00 UTC) or the monthly ceiling (until the month turns). */
  | { allowed: false; code: "AI_PAUSED"; state: "hard" | "monthly"; resetsAt: Date }
  | { allowed: false; code: "AI_BUSY"; resetsAt: Date }
  | { allowed: false; code: "AI_DAILY_LIMIT"; resetsAt: Date; capUsd: number };

export type GlobalSpendView = {
  /** Where free accounts stand. */
  state: SpendState;
  /** Where paid accounts stand. */
  paidState: PaidSpendState;
  controls: AiSpendControls;
  /** Today's spend, split by plan. */
  today: SpendBreakdown;
  /** Free readers and unattributed calls today: what the soft and hard caps compare. */
  freeSpendUsd: number;
  /** The same over the UTC month so far, today included: what the monthly cap compares. */
  monthFreeSpendUsd: number;
  dayStart: Date;
  resetsAt: Date;
  monthStart: Date;
  monthResetsAt: Date;
};

export type BreakerLogger = {
  warn: (object: Record<string, unknown>, message: string) => void;
  error: (object: Record<string, unknown>, message: string) => void;
};

/** Until `server.ts` hands the breaker the app's logger. */
const consoleLogger: BreakerLogger = {
  warn: (object, message) => console.warn(message, object),
  error: (object, message) => console.error(message, object)
};

const DAY_MS = 24 * 60 * 60 * 1000;
const GLOBAL_TTL_MS = 60_000;
const USER_TTL_MS = 10_000;
const PLAN_TTL_MS = 60_000;
/** A memory bound and nothing else: a dropped entry is read again. */
const MAX_CACHED_USERS = 10_000;

export function utcDayStart(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

export function utcMonthStart(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function nextUtcMonthStart(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/** Free accounts' state: the pause, then the month, then the day's hard and soft caps. */
export function spendStateFor(controls: AiSpendControls, freeSpendUsd: number, monthFreeSpendUsd: number): SpendState {
  if (controls.paused) return "paused";
  if (monthFreeSpendUsd >= controls.freeMonthlyCapUsd) return "monthly";
  if (freeSpendUsd >= controls.hardDailyCapUsd) return "hard";
  if (freeSpendUsd >= controls.softDailyCapUsd) return "soft";
  return "normal";
}

/** Paid accounts' state: the pause, then the paid cap. */
export function paidSpendStateFor(controls: AiSpendControls, paidSpendUsd: number): PaidSpendState {
  if (controls.paused) return "paused";
  if (paidSpendUsd >= controls.paidHardDailyCapUsd) return "capped";
  return "normal";
}

/** Whether this state refuses a free account this kind of work before its own cap is asked. */
function freeStateRefuses(state: SpendState, kind: AiWorkKind): boolean {
  return state === "monthly" || state === "hard" || (state === "soft" && SOFT_RESTRICTED_KINDS.has(kind));
}

/**
 * The decision itself, with every input already read. `userSpendUsd` null means
 * the reader's own cap is not asked (the operator, or spend under both caps).
 */
export function decideAiAccess(input: {
  state: SpendState;
  paidState: PaidSpendState;
  kind: AiWorkKind;
  paidPlan: boolean;
  userSpendUsd: number | null;
  controls: Pick<AiSpendControls, "freeUserDailyCapUsd" | "paidUserDailyCapUsd">;
  resetsAt: Date;
  monthResetsAt: Date;
}): AiAccessDecision {
  if (input.state === "paused" || input.paidState === "paused") {
    return { allowed: false, code: "AI_PAUSED", state: "paused" };
  }
  if (input.paidPlan) {
    if (input.paidState === "capped") return { allowed: false, code: "AI_PAUSED", state: "paid_cap" };
  } else if (input.state === "monthly") {
    return { allowed: false, code: "AI_PAUSED", state: "monthly", resetsAt: input.monthResetsAt };
  } else if (input.state === "hard") {
    return { allowed: false, code: "AI_PAUSED", state: "hard", resetsAt: input.resetsAt };
  } else if (input.state === "soft" && SOFT_RESTRICTED_KINDS.has(input.kind)) {
    return { allowed: false, code: "AI_BUSY", resetsAt: input.resetsAt };
  }
  if (input.userSpendUsd !== null) {
    const capUsd = input.paidPlan ? input.controls.paidUserDailyCapUsd : input.controls.freeUserDailyCapUsd;
    if (input.userSpendUsd >= capUsd) {
      return { allowed: false, code: "AI_DAILY_LIMIT", resetsAt: input.resetsAt, capUsd };
    }
  }
  return { allowed: true };
}

type SpendBreakerClient = Pick<Prisma.TransactionClient, "aiSpendControlRevision" | "providerCallLog" | "userEntitlement">;

/** The month's free spend before `day`, as read on `day`. */
type EarlierThisMonth = { day: number; freeUsd: number };

type GlobalEntry = {
  day: number;
  month: number;
  controls: AiSpendControls;
  today: SpendBreakdown;
  earlier: EarlierThisMonth | null;
  loadedAt: number;
};
type UserEntry = { day: number; spendUsd: number; loadedAt: number };

export class SpendBreaker {
  private global: GlobalEntry | null = null;
  private globalInFlight: Promise<GlobalEntry> | null = null;
  private readonly users = new Map<string, UserEntry>();
  private readonly userInFlight = new Map<string, Promise<number>>();
  private readonly plans = new Map<string, { paid: boolean; loadedAt: number }>();
  /** `<window>:<state>` this process has already warned about. */
  private readonly announced = new Set<string>();
  private logger: BreakerLogger = consoleLogger;

  constructor(
    private readonly deps: {
      client: SpendBreakerClient;
      isOnPaidPlan: (userId: string) => Promise<boolean>;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The logger for reads no request is waiting on (the billing payload, the welcome hold). */
  useLogger(logger: BreakerLogger): void {
    this.logger = logger;
  }

  /** Today's controls, spend and states; read at most once a minute. */
  async globalView(log: BreakerLogger = this.logger): Promise<GlobalSpendView> {
    const now = this.now();
    const day = utcDayStart(now);
    let entry = this.global;
    if (!entry || entry.day !== day || now - entry.loadedAt >= GLOBAL_TTL_MS) {
      entry = await this.refreshGlobal(log);
    }
    return this.view(entry, log);
  }

  async check(userId: string, kind: AiWorkKind, log: BreakerLogger = this.logger): Promise<AiAccessDecision> {
    const view = await this.globalView(log);
    const decide = (paidPlan: boolean, userSpendUsd: number | null) =>
      decideAiAccess({
        state: view.state,
        paidState: view.paidState,
        kind,
        paidPlan,
        userSpendUsd,
        controls: view.controls,
        resetsAt: view.resetsAt,
        monthResetsAt: view.monthResetsAt
      });
    // A pause refuses everyone, and the operator is never a free account and
    // has no cap of its own: neither needs the reader's spend or plan.
    if (view.state === "paused" || userId === DEFAULT_LOCAL_ADMIN_USER_ID) return decide(true, null);
    // The plan is read only where the answer depends on it: a state that
    // refuses free accounts this work, a paid cap reached, or a reader past the
    // lower of the two per-reader caps. Anywhere else both plans agree.
    let paidPlan: boolean | null = null;
    if (freeStateRefuses(view.state, kind) || view.paidState === "capped") {
      paidPlan = await this.paidPlan(userId, log);
      const early = decide(paidPlan, null);
      if (!early.allowed) return early;
    }
    const userSpendUsd = await this.userSpend(userId, view.dayStart.getTime(), log);
    const { freeUserDailyCapUsd, paidUserDailyCapUsd } = view.controls;
    if (paidPlan === null && userSpendUsd >= Math.min(freeUserDailyCapUsd, paidUserDailyCapUsd)) {
      paidPlan = await this.paidPlan(userId, log);
    }
    return paidPlan === null ? decide(true, null) : decide(paidPlan, userSpendUsd);
  }

  /**
   * Whether a free account's pending welcome grant waits (installed into
   * `@book-maker/db/billing` with `setWelcomeGrantHold`): while free spend is
   * past the soft cap, the hard cap or the monthly ceiling, or AI is paused —
   * never because of what paying readers spend. Synchronous, so it answers from
   * what this process last read today; every door refreshes that before it can
   * reserve, and the billing payload refreshes it before it reads a balance. A
   * process that has read nothing yet holds nothing.
   */
  holdsWelcomeGrants(): boolean {
    const entry = this.global;
    if (!entry || entry.day !== utcDayStart(this.now())) return false;
    return this.states(entry).state !== "normal";
  }

  /**
   * A console save: re-read on the next ask. The values stay as the fallback a
   * failed read keeps, so a pause just saved still holds if that read fails.
   */
  forget(): void {
    if (this.global) this.global = { ...this.global, loadedAt: Number.NEGATIVE_INFINITY };
    this.users.clear();
    this.plans.clear();
  }

  /** Test seam: a fresh process. */
  reset(): void {
    this.global = null;
    this.globalInFlight = null;
    this.users.clear();
    this.userInFlight.clear();
    this.plans.clear();
    this.announced.clear();
  }

  private states(entry: GlobalEntry) {
    const freeSpendUsd = freeSideUsd(entry.today);
    const monthFreeSpendUsd = roundUsd((entry.earlier?.freeUsd ?? 0) + freeSpendUsd);
    return {
      freeSpendUsd,
      monthFreeSpendUsd,
      state: spendStateFor(entry.controls, freeSpendUsd, monthFreeSpendUsd),
      paidState: paidSpendStateFor(entry.controls, entry.today.paidUsd)
    };
  }

  private view(entry: GlobalEntry, log: BreakerLogger): GlobalSpendView {
    const { freeSpendUsd, monthFreeSpendUsd, state, paidState } = this.states(entry);
    const dayLabel = new Date(entry.day).toISOString().slice(0, 10);
    const facts = {
      day: dayLabel,
      freeSpendUsd,
      monthFreeSpendUsd,
      paidSpendUsd: entry.today.paidUsd,
      softDailyCapUsd: entry.controls.softDailyCapUsd,
      hardDailyCapUsd: entry.controls.hardDailyCapUsd,
      freeMonthlyCapUsd: entry.controls.freeMonthlyCapUsd,
      paidHardDailyCapUsd: entry.controls.paidHardDailyCapUsd
    };
    if (state === "soft") {
      this.announce(log, `${entry.day}:soft`, { event: "ai_spend.soft_cap_reached", ...facts },
        "Free AI spend passed the soft daily cap: free accounts are held to the cheap paths");
    }
    if (state === "hard") {
      this.announce(log, `${entry.day}:hard`, { event: "ai_spend.hard_cap_reached", ...facts },
        "Free AI spend passed the hard daily cap: free accounts start no new AI work today");
    }
    if (state === "monthly") {
      this.announce(log, `${entry.month}:monthly`, { event: "ai_spend.monthly_cap_reached", ...facts },
        "Free AI spend passed the monthly ceiling: free accounts start no new AI work this month");
    }
    if (paidState === "capped") {
      this.announce(log, `${entry.day}:paid`, { event: "ai_spend.paid_cap_reached", ...facts },
        "Paid AI spend passed the paid daily cap: paying readers start no new AI work today");
    }
    return {
      state,
      paidState,
      controls: entry.controls,
      today: entry.today,
      freeSpendUsd,
      monthFreeSpendUsd,
      dayStart: new Date(entry.day),
      resetsAt: new Date(entry.day + DAY_MS),
      monthStart: new Date(entry.month),
      monthResetsAt: new Date(nextUtcMonthStart(entry.day))
    };
  }

  /** Once per process per window. */
  private announce(log: BreakerLogger, key: string, object: Record<string, unknown>, message: string): void {
    if (this.announced.has(key)) return;
    this.announced.add(key);
    log.warn(object, message);
  }

  private refreshGlobal(log: BreakerLogger): Promise<GlobalEntry> {
    this.globalInFlight ??= this.loadGlobal(log).finally(() => {
      this.globalInFlight = null;
    });
    return this.globalInFlight;
  }

  private async loadGlobal(log: BreakerLogger): Promise<GlobalEntry> {
    const now = this.now();
    const day = utcDayStart(now);
    const month = utcMonthStart(now);
    const previous = this.global;
    // The month's earlier days no longer move, so they are read once a day; the
    // 1st has none.
    const earlierRead: Promise<EarlierThisMonth | null> =
      day === month
        ? Promise.resolve(null)
        : previous?.month === month && previous.earlier?.day === day
          ? Promise.resolve(previous.earlier)
          : readSpendBreakdown(this.deps.client, new Date(month), new Date(day)).then((spend) => ({
              day,
              freeUsd: freeSideUsd(spend)
            }));
    const [controls, today, earlier] = await Promise.allSettled([
      readAiSpendControls(this.deps.client),
      readSpendBreakdown(this.deps.client, new Date(day), new Date(day + DAY_MS)),
      earlierRead
    ]);
    if (controls.status === "rejected") {
      log.error(
        { event: "ai_spend.controls_read_failed", err: controls.reason, keptVersion: previous?.controls.version ?? 0 },
        "Could not read the AI spend controls; keeping the last ones this process read"
      );
    }
    if (today.status === "rejected") {
      log.error(
        { event: "ai_spend.global_spend_read_failed", err: today.reason },
        "Could not read today's AI spend; the caps fail open on the spend already seen today"
      );
    }
    if (earlier.status === "rejected") {
      log.error(
        { event: "ai_spend.month_spend_read_failed", err: earlier.reason },
        "Could not read this month's earlier AI spend; the monthly cap fails open on what was already seen"
      );
    }
    const entry: GlobalEntry = {
      day,
      month,
      controls: controls.status === "fulfilled" ? controls.value : (previous?.controls ?? DEFAULT_AI_SPEND_CONTROLS),
      today: today.status === "fulfilled" ? today.value : previous && previous.day === day ? previous.today : NO_SPEND,
      // A failed read keeps an earlier day's figure for this month — a floor,
      // since the month only grows — still stamped with its own day, so the
      // next refresh asks again.
      earlier: earlier.status === "fulfilled" ? earlier.value : previous?.month === month ? previous.earlier : null,
      // A failure is cached for the TTL too, so a sick database is not asked
      // again on every request.
      loadedAt: now
    };
    this.global = entry;
    return entry;
  }

  private async userSpend(userId: string, day: number, log: BreakerLogger): Promise<number> {
    const now = this.now();
    const cached = this.users.get(userId);
    if (cached && cached.day === day && now - cached.loadedAt < USER_TTL_MS) return cached.spendUsd;
    const inFlight = this.userInFlight.get(userId);
    if (inFlight) return inFlight;
    const read = providerSpendSince(this.deps.client, new Date(day), { userId })
      .catch((error: unknown) => {
        log.error(
          { event: "ai_spend.user_spend_read_failed", userId, err: error },
          "Could not read a reader's AI spend today; their cap fails open"
        );
        return 0;
      })
      .then((spendUsd) => {
        if (this.users.size >= MAX_CACHED_USERS) this.users.delete(this.users.keys().next().value as string);
        this.users.set(userId, { day, spendUsd, loadedAt: now });
        return spendUsd;
      })
      .finally(() => this.userInFlight.delete(userId));
    this.userInFlight.set(userId, read);
    return read;
  }

  private async paidPlan(userId: string, log: BreakerLogger): Promise<boolean> {
    const now = this.now();
    const cached = this.plans.get(userId);
    if (cached && now - cached.loadedAt < PLAN_TTL_MS) return cached.paid;
    let paid: boolean;
    try {
      paid = (await this.deps.isOnPaidPlan(userId)) === true;
    } catch (error) {
      log.error(
        { event: "ai_spend.plan_read_failed", userId, err: error },
        "Could not read a reader's plan; the breaker treats them as paid"
      );
      return true;
    }
    if (this.plans.size >= MAX_CACHED_USERS) this.plans.delete(this.plans.keys().next().value as string);
    this.plans.set(userId, { paid, loadedAt: now });
    return paid;
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** The process's breaker. `server.ts` installs its welcome hold into `@book-maker/db/billing`. */
export const spendBreaker = new SpendBreaker({
  client: prisma,
  isOnPaidPlan: (userId) => hasActiveSubscriptionEntitlement(userId)
});
