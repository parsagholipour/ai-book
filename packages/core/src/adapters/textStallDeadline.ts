import { OPENAI_GPT_6_LUNA_MODEL } from "./openaiModels.js";
import { ProviderHttpError } from "./retry.js";

/**
 * When a streamed text request counts as stalled. Two rules, read off the stream
 * itself rather than off the call's purpose or its output budget:
 *
 * - **idle**: no stream event for `idleMs`, counted from dispatch. A reasoning
 *   request is not silent while it thinks: gpt-6-luna closes a reasoning item
 *   every few seconds (the longest gap between any two events in 41 replayed
 *   calls was 4.9 s, inside a high-effort manuscript read; between two text
 *   deltas, 1.1 s).
 * - **pace**: from the first visible output on, the visible tokens must keep up
 *   `minTokensPerSecond`, with `idleMs` as the cushion. Both measured slow calls
 *   were trickles, not pauses — a 264 s compose at 9.7 tokens a second, and a
 *   replayed edit at 15 tokens a second whose longest gap was 1.2 s — so an
 *   idle rule alone would never have ended either.
 *
 * See "A streamed text request that goes quiet or falls behind the slowest
 * healthy pace is ended as a 504" in `adapters/CLAUDE.md` for the measurements
 * and the counterfactual.
 */
export type TextStallDeadline = {
  /** The longest wait for the next stream event, and the pace rule's cushion. */
  idleMs: number;
  /** The slowest visible output a healthy stream keeps, in tokens a second. */
  minTokensPerSecond: number;
};

/**
 * The one table of stall deadlines, by model. A model with no entry has no
 * deadline: its numbers have to come from its own measured streams. gpt-6-luna's
 * slowest healthy non-reasoning call in the 14 days to 2026-10-17 averaged
 * 44 tokens a second end to end, and its replays streamed at 110–190; at 25 with
 * a 30 s cushion, every healthy call of those 14 days that did not reason would
 * have had to run at least 2.67 times slower to fire.
 */
export const TEXT_STALL_DEADLINES: Readonly<Record<string, TextStallDeadline>> = {
  [OPENAI_GPT_6_LUNA_MODEL]: { idleMs: 30_000, minTokensPerSecond: 25 }
};

export function textStallDeadlineFor(model: string): TextStallDeadline | undefined {
  return Object.hasOwn(TEXT_STALL_DEADLINES, model) ? TEXT_STALL_DEADLINES[model] : undefined;
}

export const PROVIDER_STALL_DEADLINE_CODE = "PROVIDER_STALL_DEADLINE";

/** What the stream looked like when its deadline fired; the run log's `text.routing.stall_deadline` carries it. */
export type TextStallReading = {
  model: string;
  rule: "idle" | "pace";
  deadline: TextStallDeadline;
  /** Dispatch to firing, less the time the caller held the stream. */
  elapsedMs: number;
  sinceLastEventMs: number;
  /** Dispatch to the first visible output, less holds, or null when none arrived. */
  firstOutputMs: number | null;
  /** Visible output tokens counted so far (see {@link TextStallWatchdog.output}). */
  outputTokens: number;
  events: number;
};

/**
 * A stall deadline firing: a 504, never a cancellation — the Jev and grounded
 * search deadlines' rule. `isTextPrimaryRetryError` gives it one fresh request
 * on the same model, `isTextProviderFallbackError` then the fallback, and
 * `withRecoverableNetworkRetry` retries it by status. Its message and name say
 * nothing a cancellation predicate reads, and it carries no `cause`: the SDK's
 * abort error under it would make `isCancellationError` call it a stop.
 */
export class ProviderStallDeadlineError extends ProviderHttpError {
  readonly stall: TextStallReading;

  constructor(stall: TextStallReading) {
    super(stallMessage(stall), { status: 504, code: PROVIDER_STALL_DEADLINE_CODE });
    this.name = "ProviderStallDeadlineError";
    this.stall = stall;
  }
}

function stallMessage(stall: TextStallReading): string {
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
  return stall.rule === "idle"
    ? `${stall.model} stalled: no stream event for ${seconds(stall.sinceLastEventMs)}; the stall deadline ended the request.`
    : `${stall.model} stalled: ${stall.outputTokens} output tokens ${seconds(stall.elapsedMs - (stall.firstOutputMs ?? 0))} after the first, ` +
      `under ${stall.deadline.minTokensPerSecond} tokens a second; the stall deadline ended the request.`;
}

/**
 * Watches one streamed request against its model's deadline and aborts it when
 * the deadline passes. The adapter starts it at dispatch, hands its signal to
 * the SDK beside the caller's, reports every stream event and every visible
 * delta, and holds it while the caller's own code runs between two events — a
 * chunk observer's database write is the caller's time, not the provider's.
 *
 * The caller's signal always wins: {@link failure} answers only for a deadline
 * that fired while the caller had not cancelled, so a stop keeps its identity.
 */
export class TextStallWatchdog {
  private readonly controller = new AbortController();
  private readonly origin = Date.now();
  /** Times below are on the provider's clock: since dispatch, less every hold. */
  private lastEventAt = 0;
  private firstOutputAt: number | undefined;
  private heldAt: number | undefined;
  private holds = 0;
  private heldMs = 0;
  private outputTokens = 0;
  private events = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired: TextStallReading | undefined;
  private disposed = false;

  private constructor(
    private readonly model: string,
    private readonly deadline: TextStallDeadline,
    private readonly pace: boolean
  ) {
    this.arm();
  }

  /**
   * A watchdog for `model`, or undefined when the model has no deadline.
   * `pace: false` keeps only the idle rule — the request after a stall
   * (`GenerateTextOptions.afterStall`), whose only way out past a slow stream
   * is another family's prose.
   */
  static start(model: string, rules: { pace?: boolean } = {}): TextStallWatchdog | undefined {
    const deadline = textStallDeadlineFor(model);
    return deadline ? new TextStallWatchdog(model, deadline, rules.pace ?? true) : undefined;
  }

  /** The signal the request goes out with: the caller's, and this deadline's. */
  signalFor(caller: AbortSignal | undefined): AbortSignal {
    return caller ? AbortSignal.any([caller, this.controller.signal]) : this.controller.signal;
  }

  /** Every stream event, visible or not: the stream is alive. */
  event(): void {
    this.events += 1;
    this.lastEventAt = this.clock();
  }

  /**
   * A visible output delta (text or tool arguments), reported beside its
   * {@link event}. It counts one token, or one per eight characters when it is
   * longer: the Responses API streams a token a delta in prose and long JSON
   * (0.999 of them in the replays) but folds short JSON runs together, and
   * undercounting is the side that fires.
   */
  output(delta: string): void {
    this.firstOutputAt ??= this.clock();
    this.outputTokens += Math.max(1, Math.ceil(delta.length / 8));
  }

  /** The caller's own code is running; its time is not the provider's silence. */
  hold(): void {
    if (this.holds++ === 0) {
      this.heldAt = Date.now();
      this.clearTimer();
    }
  }

  release(): void {
    if (this.holds === 0 || --this.holds > 0) return;
    this.heldMs += Date.now() - (this.heldAt ?? Date.now());
    this.heldAt = undefined;
    this.arm();
  }

  async aside<T>(work: () => T | Promise<T>): Promise<T> {
    this.hold();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** The 504 for a deadline that fired, unless the caller cancelled — then the cancellation is the answer. */
  failure(caller: AbortSignal | undefined): ProviderStallDeadlineError | undefined {
    if (!this.fired || caller?.aborted) return undefined;
    return new ProviderStallDeadlineError(this.fired);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private clock(): number {
    return Date.now() - this.origin - this.heldMs;
  }

  private due(): { at: number; rule: TextStallReading["rule"] } {
    const idleAt = this.lastEventAt + this.deadline.idleMs;
    const paceAt = this.firstOutputAt === undefined || !this.pace
      ? Number.POSITIVE_INFINITY
      : this.firstOutputAt + this.deadline.idleMs + (this.outputTokens / this.deadline.minTokensPerSecond) * 1_000;
    return paceAt < idleAt ? { at: paceAt, rule: "pace" } : { at: idleAt, rule: "idle" };
  }

  /** One timer at a time, set for the earlier rule; progress only moves the deadline, and the timer re-reads it. */
  private arm(): void {
    this.clearTimer();
    if (this.disposed || this.fired || this.holds > 0) return;
    this.timer = setTimeout(() => this.check(), Math.max(0, this.due().at - this.clock()));
    this.timer.unref?.();
  }

  private check(): void {
    this.timer = undefined;
    if (this.disposed || this.fired || this.holds > 0) return;
    const now = this.clock();
    const due = this.due();
    if (now < due.at) {
      this.arm();
      return;
    }
    this.fired = {
      model: this.model,
      rule: due.rule,
      deadline: { ...this.deadline },
      elapsedMs: now,
      sinceLastEventMs: now - this.lastEventAt,
      firstOutputMs: this.firstOutputAt ?? null,
      outputTokens: this.outputTokens,
      events: this.events
    };
    // The default reason, so the SDK reads this as any other abort: a pending
    // request rejects and a pending stream read ends. The adapter then asks
    // `failure()` what the abort was.
    this.controller.abort();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
