import { prisma } from "../packages/db/src/index.ts";
import {
  type OperatorCompTier,
  getCreditBalance,
  grantOperatorPlanComp,
  resolvePlanTier,
  revokeOperatorPlanComp
} from "../packages/db/src/billing.ts";

/**
 * Give a reader a paid plan for free, or take it back.
 *
 * The comp is a plan entitlement with no store order behind it
 * (`packages/db/src/operatorPlanComps.ts`): the app reads the reader as on the
 * plan, and each month's allowance is granted on their first request of that
 * month, counted from the day it was given. Nothing needs re-running monthly.
 * A reader who already pays for a plan in Google Play is refused.
 *
 * Dry run by default, like every other ops script here.
 *
 *   pnpm exec tsx scripts/comp-plan.ts --email <address> [--tier creator|pro|max] [--note <text>] [--apply]
 *   pnpm exec tsx scripts/comp-plan.ts --email <address> --revoke [--apply]
 */

const TIERS: readonly OperatorCompTier[] = ["creator", "pro", "max"];

type Args = {
  email: string;
  tier: OperatorCompTier;
  note?: string | undefined;
  revoke: boolean;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  let email: string | undefined;
  let tier: OperatorCompTier = "creator";
  let note: string | undefined;
  let revoke = false;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--email") email = value().trim().toLowerCase();
    else if (arg === "--tier") {
      const named = value() as OperatorCompTier;
      if (!TIERS.includes(named)) throw new Error(`--tier must be one of ${TIERS.join(", ")}`);
      tier = named;
    } else if (arg === "--note") note = value();
    else if (arg === "--revoke") revoke = true;
    else if (arg === "--apply") apply = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!email) throw new Error("--email is required");
  return { email, tier, note, revoke, apply };
}

/** Prints the account's plan and credits, and returns its live plan entitlements. */
async function describeAccount(userId: string, label: string): Promise<Array<{ type: string; source: string }>> {
  const now = new Date();
  const [tier, plans, account] = await Promise.all([
    resolvePlanTier(userId, now),
    prisma.userEntitlement.findMany({
      where: { userId, status: "ACTIVE", type: { in: ["CREATOR_PLAN", "PRO_PLAN", "MAX_PLAN"] } },
      select: { id: true, type: true, source: true, startsAt: true, expiresAt: true }
    }),
    prisma.userCreditAccount.findUnique({
      where: { userId },
      select: { availableCredits: true, planCredits: true, reservedCredits: true, planPeriodKey: true, planPeriodEnd: true }
    })
  ]);
  console.log(`${label}:`);
  console.log(`  plan tier: ${tier}`);
  for (const plan of plans) {
    console.log(`  entitlement ${plan.id}: ${plan.type} from ${plan.source}, since ${plan.startsAt.toISOString()}, ` +
      `expires ${plan.expiresAt?.toISOString() ?? "never"}`);
  }
  console.log(account
    ? `  credits: ${account.planCredits} plan + ${account.availableCredits} purchased, ${account.reservedCredits} held; ` +
      `period ${account.planPeriodKey ?? "none"} until ${account.planPeriodEnd?.toISOString() ?? "-"}`
    : "  credits: no account row yet");
  return plans.filter((plan) => !plan.expiresAt || plan.expiresAt > now);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true, status: true, displayName: true }
  });
  if (!user) throw new Error(`No user with email ${args.email}`);
  console.log(`User ${user.id} <${user.email}>${user.displayName ? ` (${user.displayName})` : ""}, status ${user.status}`);
  if (user.status !== "ACTIVE") throw new Error(`Refusing: the account is ${user.status}`);

  const plans = await describeAccount(user.id, "Now");
  const store = plans.find((plan) => plan.source !== "operator_comp");
  if (!args.revoke && store) {
    throw new Error(`Refusing: the account already holds ${store.type} from ${store.source}`);
  }
  const action = args.revoke ? "revoke the operator comp" : `comp the ${args.tier} plan`;
  if (!args.apply) {
    console.log(`\nDry run: would ${action}. Re-run with --apply to do it.`);
    return;
  }

  if (args.revoke) {
    const result = await revokeOperatorPlanComp({ userId: user.id });
    console.log(`\nRevoked ${result.revoked} comp(s).`);
  } else {
    const result = await grantOperatorPlanComp({ userId: user.id, tier: args.tier, note: args.note });
    console.log(`\n${result.created ? "Comped" : "Already comped"}: entitlement ${result.entitlementId}.`);
  }
  // A balance read is what the app does next, and it settles the account the same way.
  await getCreditBalance(user.id);
  await describeAccount(user.id, "After");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
