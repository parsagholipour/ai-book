import { isImageContentRefusalError } from "./imageRefusal.js";

export type RecoverableRetryContext = {
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
};

/**
 * An HTTP failure from a provider, carrying the status as a field rather than
 * only inside the message. A plain `Error` whose text happens to contain "429"
 * is invisible to {@link isRecoverableNetworkError}, so a throttled call would
 * be treated as a deterministic failure and never retried.
 *
 * `retryAfterMs` is the cooldown the provider itself asked for, when it named
 * one — see {@link recoverableRetryDelayMs}. `code` and `type` are the
 * provider's own error vocabulary where its body had one (OpenAI's
 * `insufficient_quota` / `credit_balance_exhausted`), kept as fields for the
 * same reason as the status: {@link isProviderQuotaExhaustedError} reads them
 * on the error and on its serialized copy in a fallback event.
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly code?: string;
  readonly type?: string;

  constructor(
    message: string,
    options: { status: number; retryAfterMs?: number | undefined; code?: string | undefined; type?: string | undefined }
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    if (options.code) this.code = options.code;
    if (options.type) this.type = options.type;
  }
}

/** The transport closed before a terminal response, so no answer was received. */
export class ProviderStreamInterruptedError extends Error {
  readonly code = "PROVIDER_STREAM_INTERRUPTED";
  constructor(message: string) {
    super(message);
    this.name = "ProviderStreamInterruptedError";
  }
}

export type RecoverableRetryOptions = {
  attempts?: number | undefined;
  delayMs?: number | undefined;
  maxDelayMs?: number | undefined;
  shouldRetry?: ((error: unknown) => boolean) | undefined;
  onRetry?: ((context: RecoverableRetryContext) => void | Promise<void>) | undefined;
};

const DEFAULT_RECOVERABLE_ATTEMPTS = 3;
const DEFAULT_RECOVERABLE_DELAY_MS = 2_000;
const DEFAULT_RECOVERABLE_MAX_DELAY_MS = 12_000;
/**
 * Longest cooldown worth sitting out. A per-minute quota asks for seconds; a
 * spent daily quota asks for hours, and that is not a blip to wait through.
 */
export const PROVIDER_RETRY_AFTER_CEILING_MS = 90_000;

const RECOVERABLE_NETWORK_CODES = new Set([
  "PROVIDER_STREAM_INTERRUPTED",
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

// 429 belongs here: a quota window is the most transient failure a provider has,
// and the wait it asks for is honoured below rather than guessed at.
const RECOVERABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

const RECOVERABLE_NETWORK_MESSAGE_PATTERNS = [
  /\bterminated\b/i,
  /\bfetch failed\b/i,
  /\bnetwork\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:closed|reset|terminated|timed out|timeout)\b/i,
  /\bother side closed\b/i,
  /\brequest timed out\b/i,
  /\btimeout\b/i,
  /\babort(?:ed)?\b/i
];

export async function withRecoverableNetworkRetry<T>(
  operation: () => Promise<T>,
  options: RecoverableRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_RECOVERABLE_ATTEMPTS));
  const shouldRetry = options.shouldRetry ?? isRecoverableNetworkError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = recoverableRetryDelayMs(attempt, options, error);
      await options.onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error("Recoverable operation exhausted retries.");
}

export function isRecoverableNetworkError(error: unknown): boolean {
  if (isStopOrAbortError(error)) return false;
  if (isImageContentRefusalError(error)) {
    // A provider that read the prompt and declined has answered, and it will
    // answer the same way on every attempt. The refusal's `detail` is the
    // model's own prose, so a message pattern below ("timeout", "network")
    // can appear in it by coincidence and buy three retries of a verdict.
    return false;
  }
  // A two-provider failure is two answers, and the pair is worth another pass
  // when either provider's answer is: an empty primary account beside a
  // fallback's 503 is recoverable, because the next pass hops at once.
  return failureBranches(error).some(isRecoverableBranch);
}

function isRecoverableBranch(error: unknown): boolean {
  const requested = providerRetryAfterMs(error);
  if (requested !== undefined && requested > PROVIDER_RETRY_AFTER_CEILING_MS) {
    // "Please retry in 5h44m" is an exhausted daily quota. Every attempt inside
    // that window fails identically, so calling it recoverable only burns the
    // retry budget — at every layer, including the job's — and delays the refund
    // and the honest error by however long the budget takes to spend.
    return false;
  }
  if (isQuotaExhaustedBranch(error)) {
    // The same, with no reset at all: the account has nothing left to spend
    // until someone pays (2026-10-16, see isProviderQuotaExhaustedError).
    return false;
  }
  return collectErrorDescriptors(error).some((descriptor) => {
    if (descriptor.code && RECOVERABLE_NETWORK_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    if (descriptor.status !== undefined && RECOVERABLE_HTTP_STATUSES.has(descriptor.status)) {
      return true;
    }
    return descriptor.messages.some((message) =>
      RECOVERABLE_NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    );
  });
}

/** The `errorClass` a cost row of a call refused for an empty account carries (`ProviderCallLog.metadata`). */
export const PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS = "provider_quota_exhausted";

/**
 * Machine codes and error types a provider gives an account with nothing left
 * to spend: OpenAI's `insufficient_quota` type with its `credit_balance_exhausted`,
 * `billing_hard_limit_reached` and `billing_not_active` codes; Google's
 * `BILLING_DISABLED`; DashScope's `Arrearage`. Codes are vocabulary, so they
 * count wherever they appear.
 */
const QUOTA_EXHAUSTED_CODE =
  /^(?:insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active|insufficient_balance|insufficient_credits|payment_required|billing_disabled|arrearage)$/i;
const QUOTA_EXHAUSTED_TOKEN =
  /\b(?:insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active|BILLING_DISABLED)\b/;

/**
 * The sentences, which count only on a branch that also carries an HTTP
 * refusal status: an error message can quote a model's output, and a story
 * about a bank should not read as the bank's account being empty.
 */
const QUOTA_EXHAUSTED_SENTENCES = [
  /\bno credits remaining\b/i, // OpenAI, 2026-10-16
  /\binsufficient (?:account )?(?:balance|credits?|funds|quota)\b/i, // DeepSeek 402, OpenRouter 402
  /\b(?:prepay(?:ment)?|prepaid) credits? (?:are|is|have been|has been) (?:depleted|exhausted)\b/i, // Gemini, 2026-09-02
  /\bcredit balance (?:is )?(?:exhausted|depleted|too low)\b/i,
  /\b(?:requires|need) more credits\b/i, // OpenRouter 402, a request the balance cannot cover
  /\bbilling hard limit\b/i,
  /\bbilling (?:account )?(?:is )?(?:disabled|not active|inactive)\b/i,
  /\baccount is not active\b.*\bbilling\b/i, // OpenAI billing_not_active
  /\baccount is (?:not )?in good standing\b/i, // DashScope Arrearage
  /\bpayment required\b/i
];
const QUOTA_REFUSAL_STATUSES = new Set([400, 402, 403, 429]);

/**
 * "You exceeded your current quota, please check your plan and billing
 * details" is OpenAI's whole `insufficient_quota` sentence — and also the
 * opening of every Gemini quota 429, its per-minute windows included. So it
 * names an empty account only where nothing says the window reopens: no
 * cooldown carried as a field, no "retry in", no per-minute metric.
 */
const EXCEEDED_QUOTA_SENTENCE = /\bexceeded your current quota\b/i;
const WAITABLE_QUOTA_MARKERS = /\bretry in\b|retryDelay|\bper[ _-]?minute\b|PerMinute|\bper min\b|\b[RT]PM\b/i;

/**
 * An account out of credit or out of quota, refused for a reason no wait
 * repairs. On 2026-10-16 the OpenAI account ran dry and every gpt-6-luna call
 * — the writer of every book on every tier — answered `429 insufficient_quota /
 * credit_balance_exhausted`. A 429 read as a per-minute window, so
 * `isTextProviderFallbackError` kept it on the primary for
 * `withRecoverableNetworkRetry`'s cooldown, that loop asked luna three times,
 * and the configured fallback writer never ran. On 2026-09-02 Gemini's prepaid
 * credit ran out the same way and 724 of 728 embedding calls spent three
 * attempts each on "prepayment credits are depleted".
 *
 * So this is the third answer beside a waitable 429 and a daily cap: never
 * retried on the same provider by any layer, never given the same-model retry,
 * and a reason to hop to the fallback at once. A DeepSeek, DeepInfra or
 * OpenRouter 402 is one too, though no 402 was ever a fallback reason before.
 * A two-provider failure is out of quota only when both providers are; the
 * worker marks each refused call's cost row with
 * {@link PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS}, and the API's alert sweep reads
 * those rows (`apps/api/src/monitoring/providerQuota.ts`).
 */
export function isProviderQuotaExhaustedError(error: unknown): boolean {
  if (isStopOrAbortError(error)) return false;
  return failureBranches(error).every(isQuotaExhaustedBranch);
}

function isQuotaExhaustedBranch(error: unknown): boolean {
  const descriptors = collectErrorDescriptors(error);
  const refusedByStatus = descriptors.some(
    (descriptor) => descriptor.status !== undefined && QUOTA_REFUSAL_STATUSES.has(descriptor.status)
  );
  if (descriptors.some((descriptor) => descriptor.status === 402)) return true;
  if (
    descriptors.some(
      (descriptor) =>
        (descriptor.code !== undefined && QUOTA_EXHAUSTED_CODE.test(descriptor.code.trim())) ||
        descriptor.messages.some((message) => QUOTA_EXHAUSTED_TOKEN.test(message))
    )
  ) {
    return true;
  }
  if (!refusedByStatus) return false;
  const messages = descriptors.flatMap((descriptor) => descriptor.messages);
  if (messages.some((message) => QUOTA_EXHAUSTED_SENTENCES.some((pattern) => pattern.test(message)))) return true;
  if (!messages.some((message) => EXCEEDED_QUOTA_SENTENCE.test(message))) return false;
  const waitable =
    descriptors.some((descriptor) => descriptor.retryAfterMs !== undefined && descriptor.retryAfterMs > 0) ||
    messages.some((message) => WAITABLE_QUOTA_MARKERS.test(message));
  return !waitable;
}

/**
 * The attempts a failure is made of: the primary's and the fallback's error
 * for a two-provider failure (`TextGenerationFallbackError`,
 * `ImageGenerationFallbackError`, or either serialized), else the error itself.
 */
function failureBranches(error: unknown): unknown[] {
  const primary = attemptError(error, "primary");
  const fallback = attemptError(error, "fallback");
  if (primary === undefined || fallback === undefined) return [error];
  return [...failureBranches(primary), ...failureBranches(fallback)];
}

function attemptError(error: unknown, role: "primary" | "fallback"): unknown {
  if (!error || typeof error !== "object") return undefined;
  const attempt = (error as Record<string, unknown>)[role];
  if (!attempt || typeof attempt !== "object") return undefined;
  const nested = (attempt as Record<string, unknown>).error;
  return nested && typeof nested === "object" ? nested : undefined;
}

/** Errors that can justify restarting an audiobook with its backup provider. */
export function isSpeechProviderFallbackError(error: unknown): boolean {
  if (isStopOrAbortError(error)) {
    return false;
  }
  if (isProviderQuotaExhaustedError(error)) {
    return true;
  }
  return collectErrorDescriptors(error).some((descriptor) => {
    if (descriptor.status !== undefined) {
      return descriptor.status === 408 || descriptor.status === 429 || descriptor.status >= 500;
    }
    if (descriptor.code && RECOVERABLE_NETWORK_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    return descriptor.messages.some((message) =>
      /(?:fetch failed|network|connection (?:closed|reset|terminated|timed out)|socket hang up|timeout|timed out)/i.test(
        message
      )
    );
  });
}

/** Availability failures that may be retried once through an operator-selected text fallback. */
/**
 * A provider's input filter refusing the text it was sent. Alibaba answers
 * `400 data_inspection_failed: "Input text data may contain inappropriate
 * content."` to a history chapter about genocide, and a 400 used to be final:
 * a paid fast-tier book failed at 62% with a fallback writer configured that
 * runs a different filter. For text the other provider is the answer.
 */
export function isProviderContentFilterError(error: unknown): boolean {
  return collectErrorDescriptors(error).some(
    (descriptor) =>
      (descriptor.code !== undefined && /data_inspection_failed|content_filter/i.test(descriptor.code)) ||
      descriptor.messages.some((message) =>
        /data_inspection_failed|inappropriate content|content management policy|content_filter/i.test(message)
      )
  );
}

/**
 * The transport failures {@link isTextPrimaryRetryError} gives the primary a
 * second request for: the connection broke, or never reached the provider.
 * Every one of them fails or recovers in seconds. The client's own timeouts
 * (`ETIMEDOUT`, `UND_ERR_*_TIMEOUT`, `ECONNABORTED`) are left out on purpose:
 * that wait has already been spent once, and a second identical wait before
 * the fallback gets its turn is the delay the fallback exists to avoid.
 */
const TEXT_PRIMARY_RETRY_CODES = new Set([
  "PROVIDER_STREAM_INTERRUPTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET"
]);

/**
 * A gateway saying it cannot serve the request right now — a deadline's 504
 * included, the text stall deadline's among them (`textStallDeadline.ts`).
 */
const TEXT_PRIMARY_RETRY_STATUSES = new Set([502, 503, 504]);

const TEXT_PRIMARY_RETRY_MESSAGE_PATTERNS = [
  /\bterminated\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:closed|reset|terminated)\b/i,
  /\bother side closed\b/i
];

/**
 * A transport failure with no complete answer, which earns the *primary* one
 * fresh request before `FallbackTextModelAdapter` hops to another provider
 * family: a stream cut before its terminal event, a reset or refused
 * connection, a 502/503/504. Never a cancellation (by identity or by prose —
 * the prose reading only ever suppresses a retry here), never a provider's
 * content or input filter (another family's filter *is* the answer), never an
 * empty account whatever its status ({@link isProviderQuotaExhaustedError}: the
 * fresh request is refused the same way), and never a 429 (a waitable one is
 * `withRecoverableNetworkRetry`'s cooldown, a daily cap or an empty account
 * hops at once). See "A transport failure gets one fresh attempt on the same
 * model" in `adapters/CLAUDE.md`.
 */
export function isTextPrimaryRetryError(error: unknown): boolean {
  if (
    isCancellationError(error) ||
    isStopOrAbortError(error) ||
    isProviderContentFilterError(error) ||
    isProviderQuotaExhaustedError(error)
  ) {
    return false;
  }
  const descriptors = collectErrorDescriptors(error);
  if (descriptors.some((descriptor) => descriptor.status === 429)) {
    return false;
  }
  return descriptors.some((descriptor) => {
    if (descriptor.status !== undefined) {
      return TEXT_PRIMARY_RETRY_STATUSES.has(descriptor.status);
    }
    if (descriptor.code && TEXT_PRIMARY_RETRY_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    return descriptor.messages.some((message) =>
      TEXT_PRIMARY_RETRY_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
    );
  });
}

export function isTextProviderFallbackError(error: unknown): boolean {
  if (isStopOrAbortError(error)) {
    return false;
  }
  if (isProviderContentFilterError(error)) {
    return true;
  }
  // An empty account answers every request the same way until someone pays,
  // whatever status it chose (a 429 on OpenAI and Gemini, a 402 on DeepSeek,
  // DeepInfra and OpenRouter, a 400 on DashScope), so the other provider is
  // the only answer — at once, with no cooldown in front of it.
  if (isProviderQuotaExhaustedError(error)) {
    return true;
  }
  // A waitable TPM 429 belongs to withRecoverableNetworkRetry on the primary —
  // hopping would skip the cooldown. A spent daily quota is already not
  // recoverable, so it still falls through to the other provider.
  if (
    isRecoverableNetworkError(error) &&
    collectErrorDescriptors(error).some((descriptor) => descriptor.status === 429)
  ) {
    return false;
  }
  return collectErrorDescriptors(error).some((descriptor) => {
    if (descriptor.status !== undefined) {
      return descriptor.status === 408 || descriptor.status === 409 || descriptor.status === 429 || descriptor.status >= 500;
    }
    if (descriptor.code && RECOVERABLE_NETWORK_CODES.has(descriptor.code.toUpperCase())) {
      return true;
    }
    return descriptor.messages.some((message) =>
      /(?:rate.?limit|quota|capacity|overload|temporar(?:y|ily)|unavailable|fetch failed|network|connection (?:closed|reset|terminated|timed out)|socket hang up|timeout|timed out)/i.test(
        message
      )
    );
  });
}

/**
 * A cancellation rather than a failure: the run was stopped, or the call was
 * aborted, so nothing downstream may retry it, fall back from it, or fold it
 * into a value the caller keeps working with.
 *
 * The class itself — the worker's `StopRequestedError`, which
 * `LoggingEmbeddingAdapter.embed` and its siblings raise off `assertJobNotStopped`
 * — is not reachable from here: `packages/core` is the leaf of
 * `apps/* -> packages/db -> packages/core`. So this matches the shape instead,
 * over `name`, `message` and every nested `cause`, which is what lets a policy
 * inside core hold the line the worker's own `isStopRequestedError` holds on
 * its side of the boundary.
 */
export function isStopOrAbortError(error: unknown): boolean {
  return collectErrorDescriptors(error).some((descriptor) =>
    descriptor.messages.some((message) =>
      /(?:AbortError|StopRequestedError|stop requested|stopped by user|request aborted)/i.test(message)
    )
  );
}

const CANCELLATION_ERROR_NAMES = new Set(["ABORTERROR", "STOPREQUESTEDERROR"]);

/**
 * The same question read off the error's *identity* rather than its prose: the
 * `name` an `AbortController`'s `DOMException` carries, the `name` the worker's
 * `StopRequestedError` sets on itself, or the `ABORT_ERR` code beside them —
 * over the error and every nested `cause`, as above.
 *
 * {@link isStopOrAbortError} reads message text too, and that width is right
 * where a false positive only ever *suppresses* something: a retry not taken, a
 * fallback provider not tried, an error that still surfaces as the failure it
 * is. It is wrong where a false positive turns a recoverable failure into a
 * fatal one — `runToolLoop`'s escape hatch, where a provider whose message
 * merely says "request aborted" would end a chat turn the model could otherwise
 * have worked around. That call site reads this predicate instead.
 *
 * Narrowing costs the worker nothing: `LoggingEmbeddingAdapter.embed` runs
 * `assertJobNotStopped` on its way out, so a cancellation reaching a tool is
 * already a `StopRequestedError` by the time it is thrown, and every consumer
 * of the escape gates on `instanceof StopRequestedError` — narrower still.
 */
export function isCancellationError(error: unknown): boolean {
  return collectErrorDescriptors(error).some(
    (descriptor) =>
      descriptor.code?.toUpperCase() === "ABORT_ERR" ||
      descriptor.names.some((name) => CANCELLATION_ERROR_NAMES.has(name.toUpperCase()))
  );
}

/**
 * Exponential backoff, unless the provider named its own cooldown — then wait at
 * least that long. Retrying inside a quota window the provider already told us
 * about just spends another attempt on the same refusal.
 */
function recoverableRetryDelayMs(attempt: number, options: RecoverableRetryOptions, error: unknown): number {
  const baseDelay = Math.max(0, options.delayMs ?? DEFAULT_RECOVERABLE_DELAY_MS);
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_RECOVERABLE_MAX_DELAY_MS);
  const backoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));

  const requested = retryCooldownMs(error);
  if (requested === undefined) {
    return backoff;
  }
  // A little jitter, because parallel callers are throttled together and would
  // otherwise all come back at the same instant and throttle each other again.
  // Anything past the ceiling never reaches here — `isRecoverableNetworkError`
  // has already refused it, and a pair waits only on an attempt worth retrying.
  const jitter = Math.round(Math.random() * 1_000);
  return Math.max(backoff, requested + jitter);
}

/**
 * The cooldown the next pass waits out. A two-provider failure is retried for
 * whichever attempt is still recoverable, so it waits on that attempt's
 * cooldown, never on the other's: a primary's five-hour daily cap beside a
 * fallback's 503 is a pair worth another pass (the next pass hops at once),
 * and waiting five hours for it is not.
 */
function retryCooldownMs(error: unknown): number | undefined {
  const branches = failureBranches(error);
  if (branches.length === 1) return providerRetryAfterMs(error);
  for (const branch of branches) {
    const requested = isRecoverableBranch(branch) ? providerRetryAfterMs(branch) : undefined;
    if (requested !== undefined) return requested;
  }
  return undefined;
}

/** The cooldown a provider asked for, in milliseconds, if any layer of the error carries one. */
export function providerRetryAfterMs(error: unknown): number | undefined {
  for (const descriptor of collectErrorDescriptors(error)) {
    if (descriptor.retryAfterMs !== undefined && descriptor.retryAfterMs > 0) {
      return descriptor.retryAfterMs;
    }
  }
  return undefined;
}

function collectErrorDescriptors(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): Array<{
  code?: string | undefined;
  status?: number | undefined;
  retryAfterMs?: number | undefined;
  /** `name` alone — the identity half of {@link messages}, for predicates that must not read prose. */
  names: string[];
  messages: string[];
}> {
  if (value === null || value === undefined || depth > 6) {
    return [];
  }

  if (typeof value !== "object") {
    return [{ names: [], messages: [String(value)] }];
  }

  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const names = trimmedStrings([record.name]);
  const messages = [...names, ...trimmedStrings([record.message, record.type])];

  const descriptor = {
    code: typeof record.code === "string" ? record.code : undefined,
    status: numericField(record.status ?? record.statusCode),
    retryAfterMs: numericField(record.retryAfterMs),
    names,
    messages
  };

  const nested = [
    ...collectErrorDescriptors(record.cause, seen, depth + 1),
    ...collectErrorDescriptors(record.error, seen, depth + 1),
    ...collectErrorDescriptors(record.response, seen, depth + 1),
    ...collectErrorDescriptors(record.primary, seen, depth + 1),
    ...collectErrorDescriptors(record.fallback, seen, depth + 1),
    ...collectErrorArray(record.errors, seen, depth + 1)
  ];

  return [descriptor, ...nested];
}

function collectErrorArray(value: unknown, seen: WeakSet<object>, depth: number) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => collectErrorDescriptors(item, seen, depth));
}

function trimmedStrings(values: unknown[]): string[] {
  return values
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function numericField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
