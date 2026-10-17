import {
  PROVIDER_CREDENTIALS,
  PROVIDER_LABELS,
  PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS,
  type ProviderAccount
} from "@book-maker/core";
import type { AlertObservation, AlertState } from "./alertState.js";

/**
 * One alert per provider account that has run out of credit or quota.
 *
 * On 2026-10-16 the OpenAI account ran dry, every gpt-6-luna call answered
 * `429 insufficient_quota`, and the owner heard about it from an eval agent:
 * nothing watched for it, and a provider outage with a working fallback does
 * not fail jobs fast enough for `failed_jobs` to see it. The worker now marks
 * the cost row of every call an empty account refused with `errorClass:
 * "provider_quota_exhausted"` (`isProviderQuotaExhaustedError` in core,
 * `providerErrorClassMetadata` in the worker), on text, decision, search,
 * image and embedding calls alike, and this reads those rows.
 *
 * **The account is what runs dry, so the condition is per account, and it
 * holds until that account answers again.** It fails while the account's
 * latest refusal is newer than its latest answered call: one success after the
 * top-up clears it, and silence never does — with no call to the account in
 * the window, a firing condition is left unmeasured rather than recovered,
 * because a quiet night is not a paid bill. A call counts as answered when its
 * row settled (`liveStatus` settled, or none on an image or audio row) and is
 * not itself a refusal; that includes an answer the caller then rejected,
 * since the account served it.
 *
 * It is never a readiness check. `/api/ready` is binary — one failing check is
 * a 503 the uptime monitor reports as the deployment down — and an empty
 * primary account with a fallback configured still writes every book.
 */

export type QuotaAccount = Exclude<ProviderAccount, "openai-compatible">;
export type ProviderQuotaConditionKey = `provider_quota_${QuotaAccount}`;

/** Every billed account; the local OpenAI-compatible server has no balance to run out. */
export const PROVIDER_QUOTA_ACCOUNTS: readonly QuotaAccount[] = (Object.keys(PROVIDER_CREDENTIALS) as ProviderAccount[]).filter(
  (account): account is QuotaAccount => account !== "openai-compatible"
);

export function providerQuotaConditionKey(account: QuotaAccount): ProviderQuotaConditionKey {
  return `provider_quota_${account}`;
}

export function providerQuotaLabel(account: QuotaAccount): string {
  return `${PROVIDER_LABELS[account]} account out of credit or quota`;
}

/** How far back the sweep reads. A firing condition outlives it (see above); it only bounds the scan. */
export const PROVIDER_QUOTA_WINDOW_MS = 60 * 60_000;

/** One `ProviderCallLog.provider` spelling's last refusal and last answer in the window. */
export type ProviderCallOutcome = {
  provider: string;
  exhaustedAt: Date | null;
  refusals: number;
  answeredAt: Date | null;
};

/**
 * The account a row's `provider` column bills. Text, image, search, decision
 * and embedding rows spell the account itself; speech and voice rows name
 * their product (`gemini_tts`, `openai_realtime`), whose account is the part
 * before the underscore — the mapping `providerRequirements.ts` makes.
 */
export function quotaAccountOf(provider: string): QuotaAccount | undefined {
  const accounts = PROVIDER_QUOTA_ACCOUNTS as readonly string[];
  if (accounts.includes(provider)) return provider as QuotaAccount;
  const prefix = provider.split("_")[0] ?? "";
  return accounts.includes(prefix) ? (prefix as QuotaAccount) : undefined;
}

export function providerQuotaObservations(
  outcomes: readonly ProviderCallOutcome[],
  previous: ReadonlyMap<string, AlertState>
): Array<[ProviderQuotaConditionKey, AlertObservation]> {
  const byAccount = new Map<QuotaAccount, { exhaustedAt: Date | null; refusals: number; answeredAt: Date | null }>();
  for (const outcome of outcomes) {
    const account = quotaAccountOf(outcome.provider);
    if (!account) continue;
    const merged = byAccount.get(account) ?? { exhaustedAt: null, refusals: 0, answeredAt: null };
    byAccount.set(account, {
      exhaustedAt: later(merged.exhaustedAt, outcome.exhaustedAt),
      refusals: merged.refusals + outcome.refusals,
      answeredAt: later(merged.answeredAt, outcome.answeredAt)
    });
  }
  return PROVIDER_QUOTA_ACCOUNTS.map((account) => {
    const key = providerQuotaConditionKey(account);
    const seen = byAccount.get(account);
    if (seen?.exhaustedAt && (!seen.answeredAt || seen.answeredAt < seen.exhaustedAt)) {
      const calls = seen.refusals === 1 ? "1 call" : `${seen.refusals} calls`;
      return [
        key,
        {
          failing: true,
          detail: `${calls} to ${PROVIDER_LABELS[account]} refused in the last hour for an account out of credit or quota (latest ${utcMinute(seen.exhaustedAt)} UTC), and none answered since; where routing names a fallback, that provider is doing this one's work`
        }
      ];
    }
    if (seen?.answeredAt) return [key, { failing: false }];
    // Nothing answered and nothing refused in the window: a firing account has
    // not been shown to work again, so its state stands.
    return [key, previous.get(key)?.firing ? null : { failing: false }];
  });
}

function later(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return right > left ? right : left;
}

function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

type ProviderQuotaDatabase = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

/**
 * One grouped read over the window's rows, on the `createdAt` index
 * (migration 000100). An in-flight row is neither: it has not answered yet.
 */
export function providerCallOutcomesSource(db: ProviderQuotaDatabase): (since: Date) => Promise<ProviderCallOutcome[]> {
  return async (since) => {
    const rows = await db.$queryRaw<Array<{ provider: string; exhaustedAt: Date | null; refusals: number | bigint | null; answeredAt: Date | null }>>`
      SELECT "provider",
        MAX("createdAt") FILTER (WHERE "metadata" ->> 'errorClass' = ${PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS}) AS "exhaustedAt",
        COUNT(*) FILTER (WHERE "metadata" ->> 'errorClass' = ${PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS}) AS "refusals",
        MAX("createdAt") FILTER (
          WHERE "metadata" ->> 'errorClass' IS DISTINCT FROM ${PROVIDER_QUOTA_EXHAUSTED_ERROR_CLASS}
            AND COALESCE("metadata" ->> 'liveStatus', 'settled') = 'settled'
        ) AS "answeredAt"
      FROM "ProviderCallLog"
      WHERE "createdAt" >= ${since}
      GROUP BY "provider"`;
    return rows.map((row) => ({
      provider: row.provider,
      exhaustedAt: row.exhaustedAt,
      refusals: Number(row.refusals ?? 0),
      answeredAt: row.answeredAt
    }));
  };
}
