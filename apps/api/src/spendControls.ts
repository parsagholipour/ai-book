import type { Prisma } from "@book-maker/db";
import { z } from "zod";

/**
 * The operator's AI spend controls: a manual pause and six caps in US dollars
 * of provider spend (`SUM("costHint")`, a floor on real spend — see
 * `apps/api/src/admin/CLAUDE.md`), over the UTC calendar day or month.
 *
 * `AiSpendControlRevision` is append-only like `SafetySettingsRevision`: the
 * console writes a new version on every save and the highest version is in
 * force. No revision at all means {@link AI_SPEND_CONTROL_DEFAULTS} — never
 * "no limits" — and a revision saved before a cap existed (migration 000107)
 * reads that cap's default. What each state blocks is decided in
 * `spendBreaker.ts`; how spend is split between free and paid is
 * `spendBreakdown.ts`.
 */

/**
 * The defaults, and the arithmetic behind them.
 *
 * The launch budget is ~$200 a month for everything: ~$45–50 of hosting and at
 * most $50 of ads, which leaves ~$100–150 for AI providers. Only the spend
 * nobody pays for has to fit in that: a paying reader's spend is backed by
 * their subscription (a credit sells for $0.0021–0.0025 after Play's cut and
 * costs $0.0009–0.0018 of provider spend), so the global caps that protect the
 * budget count **free spend** — readers with no active plan, plus calls that
 * name no reader, which is a floor anyway — and leave paying readers to their
 * own caps.
 *
 * - **Soft, $5/day of free spend** — the monthly ceiling's pace: thirty days at
 *   $5 is the $150 below. Past it, free accounts are held to the cheap paths
 *   (no Ultra, welcome credits deferred; voice calls and audiobooks are plan
 *   perks a free account never reaches anyway).
 * - **Hard, $12/day of free spend** — a bit over two days' pace in one. That
 *   is a viral day, an account farm or a runaway client, so free accounts start
 *   no new AI work until the day turns over or the operator looks. Paying
 *   readers are untouched, so a farm of free accounts cannot take the product
 *   down for the people paying for it. One such day costs 8% of the month.
 * - **Monthly ceiling, $150 of free spend per UTC month** — the top of the AI
 *   share of the budget, reached only if ads spend nothing; lower it to ~$100
 *   in a month the full ad budget runs. Past it, free accounts are treated as
 *   past the hard cap until the month ends or the operator raises it. It is
 *   what stops a run of hard-cap days: twelve of them would be $144.
 * - **Paid, $60/day of paid spend** — a catastrophe stop, not a budget: paid
 *   spend is backed by revenue, and $60 is two paying readers at their own
 *   $30 cap in one day, far above anything launch traffic does. Reaching it
 *   means stolen accounts, a stuck client or a pricing bug that under-charges,
 *   so paying readers start no new AI work until the day turns over or the
 *   operator raises it. Free accounts follow their own caps.
 * - **Free reader, $1.50/day** — a welcome grant is ~1,000 credits, and at
 *   $0.0009–0.0018 of provider cost per credit that is $0.90–1.80 of work in
 *   total; a day's cap a little under the top of that lets a free reader use
 *   the gift in one sitting and stops an account farm at one grant's worth.
 * - **Paid reader, $30/day** — deliberately high. A Max subscriber pays $199.99
 *   a month for 80,000 credits, which is $72–144 of provider spend if all of it
 *   is used, and they may legitimately use a week of it in one afternoon. $30
 *   stops a stolen account or a stuck client from spending more than the
 *   subscription is worth in a few days, and nothing short of that.
 *
 * "Paid" is an active plan (`hasActiveSubscriptionEntitlement`); a reader who
 * bought a credit pack without a plan is held to the free caps.
 */
export const AI_SPEND_CONTROL_DEFAULTS = {
  paused: false,
  softDailyCapUsd: 5,
  hardDailyCapUsd: 12,
  freeMonthlyCapUsd: 150,
  paidHardDailyCapUsd: 60,
  freeUserDailyCapUsd: 1.5,
  paidUserDailyCapUsd: 30
} as const;

/** A cap no operator types on purpose; also keeps a typo from reading as "off". */
const MAX_CAP_USD = 100_000;

const capUsd = z.number().finite().min(0).max(MAX_CAP_USD);

/** The body the console saves. A pause can be flipped alone; every cap is required, so a save is the whole state. */
export const aiSpendControlsInputSchema = z
  .object({
    paused: z.boolean(),
    softDailyCapUsd: capUsd,
    hardDailyCapUsd: capUsd,
    freeMonthlyCapUsd: capUsd,
    paidHardDailyCapUsd: capUsd,
    freeUserDailyCapUsd: capUsd,
    paidUserDailyCapUsd: capUsd,
    note: z.string().trim().max(500).optional()
  })
  .strict()
  .refine((value) => value.softDailyCapUsd <= value.hardDailyCapUsd, {
    message: "The soft cap has to be at or below the hard cap.",
    path: ["softDailyCapUsd"]
  });

export type AiSpendControlsInput = z.infer<typeof aiSpendControlsInputSchema>;

/** The OpenAPI copy of {@link aiSpendControlsInputSchema}; change both together. */
export const aiSpendControlsInputOpenApi = {
  type: "object",
  additionalProperties: false,
  required: [
    "paused",
    "softDailyCapUsd",
    "hardDailyCapUsd",
    "freeMonthlyCapUsd",
    "paidHardDailyCapUsd",
    "freeUserDailyCapUsd",
    "paidUserDailyCapUsd"
  ],
  properties: {
    paused: { type: "boolean" },
    softDailyCapUsd: { type: "number", minimum: 0, maximum: MAX_CAP_USD },
    hardDailyCapUsd: { type: "number", minimum: 0, maximum: MAX_CAP_USD },
    freeMonthlyCapUsd: { type: "number", minimum: 0, maximum: MAX_CAP_USD },
    paidHardDailyCapUsd: { type: "number", minimum: 0, maximum: MAX_CAP_USD },
    freeUserDailyCapUsd: { type: "number", minimum: 0, maximum: MAX_CAP_USD },
    paidUserDailyCapUsd: { type: "number", minimum: 0, maximum: MAX_CAP_USD },
    note: { type: "string", maxLength: 500 }
  }
} as const;

export type AiSpendControls = {
  /** 0 when no revision has been saved and the defaults are in force. */
  version: number;
  paused: boolean;
  /** Free spend today (free readers plus unattributed calls). */
  softDailyCapUsd: number;
  /** Free spend today. */
  hardDailyCapUsd: number;
  /** Free spend this UTC month, today included. */
  freeMonthlyCapUsd: number;
  /** Paid readers' spend today. */
  paidHardDailyCapUsd: number;
  freeUserDailyCapUsd: number;
  paidUserDailyCapUsd: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
};

type SpendControlsReader = Pick<Prisma.TransactionClient, "aiSpendControlRevision">;

export const DEFAULT_AI_SPEND_CONTROLS: AiSpendControls = {
  version: 0,
  ...AI_SPEND_CONTROL_DEFAULTS,
  note: null,
  updatedBy: null,
  updatedAt: null
};

/** The controls in force. A failed read throws; the breaker decides what that means. */
export async function readAiSpendControls(client: SpendControlsReader): Promise<AiSpendControls> {
  const head = await client.aiSpendControlRevision.findFirst({ orderBy: { version: "desc" } });
  if (!head) return DEFAULT_AI_SPEND_CONTROLS;
  return {
    version: head.version,
    paused: head.paused,
    softDailyCapUsd: head.softDailyCapUsd,
    hardDailyCapUsd: head.hardDailyCapUsd,
    // Null on a revision saved before migration 000107 added the column.
    freeMonthlyCapUsd: head.freeMonthlyCapUsd ?? AI_SPEND_CONTROL_DEFAULTS.freeMonthlyCapUsd,
    paidHardDailyCapUsd: head.paidHardDailyCapUsd ?? AI_SPEND_CONTROL_DEFAULTS.paidHardDailyCapUsd,
    freeUserDailyCapUsd: head.freeUserDailyCapUsd,
    paidUserDailyCapUsd: head.paidUserDailyCapUsd,
    note: head.note,
    updatedBy: head.updatedBy,
    updatedAt: head.createdAt
  };
}
