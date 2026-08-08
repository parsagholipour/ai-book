import { prisma } from "../packages/db/src/index.ts";
import { refundCreditLedgerEntry } from "../packages/db/src/billing.ts";

type AuditArgs = {
  apply: boolean;
  projectId?: string | undefined;
};

type DuplicateChargeCandidate = {
  generationJobId: string;
  projectId: string | null;
  userId: string;
  operation: string;
  canonicalLedgerEntryId: string;
  duplicateLedgerEntryIds: string[];
  amountCreditsEach: number;
};

const args = parseArgs(process.argv.slice(2));

try {
  const candidates = await findProvableDuplicateCharges(args.projectId);
  const ambiguousEditCandidates = await findAmbiguousEditCandidates(args.projectId);
  const refundedLedgerEntryIds: string[] = [];

  if (args.apply) {
    for (const candidate of candidates) {
      for (const ledgerEntryId of candidate.duplicateLedgerEntryIds) {
        const refunded = await refundCreditLedgerEntry(
          ledgerEntryId,
          `Audit refund: duplicate priced generation charge for job ${candidate.generationJobId}`
        );
        if (refunded) refundedLedgerEntryIds.push(ledgerEntryId);
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? "applied" : "dry-run",
        candidateCount: candidates.length,
        candidates,
        refundedLedgerEntryIds,
        // These resemble duplicate edit commands but do not share one durable
        // job, so the script deliberately reports rather than refunds them.
        ambiguousEditCandidates
      },
      null,
      2
    )
  );
} finally {
  await prisma.$disconnect();
}

async function findProvableDuplicateCharges(projectId: string | undefined): Promise<DuplicateChargeCandidate[]> {
  const grouped = await prisma.creditLedgerEntry.groupBy({
    by: ["generationJobId", "userId", "projectId", "operation"],
    where: {
      generationJobId: { not: null },
      amountCredits: { lt: 0 },
      entryType: { in: ["RESERVE", "SPEND"] },
      ...(projectId ? { projectId } : {})
    },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } }
  });
  const candidates: DuplicateChargeCandidate[] = [];

  for (const group of grouped) {
    if (!group.generationJobId) continue;
    const entries = await prisma.creditLedgerEntry.findMany({
      where: {
        generationJobId: group.generationJobId,
        userId: group.userId,
        projectId: group.projectId,
        operation: group.operation,
        amountCredits: { lt: 0 }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        amountCredits: true,
        status: true,
        reversedByEntry: { select: { id: true } },
        generationAttempt: { select: { id: true } }
      }
    });
    // Only historical, equal-value debits tied to one durable job are safe to
    // repair automatically. Mixed prices or attempt-aware rows need review.
    if (
      entries.length < 2 ||
      entries.some((entry) => entry.generationAttempt !== null) ||
      new Set(entries.map((entry) => entry.amountCredits)).size !== 1
    ) {
      continue;
    }
    const activeCharges = entries.filter(
      (entry) => ["RESERVED", "SETTLED"].includes(entry.status) && entry.reversedByEntry === null
    );
    if (activeCharges.length < 2) continue;
    const canonical = activeCharges[0]!;
    const duplicates = activeCharges.slice(1);
    candidates.push({
      generationJobId: group.generationJobId,
      projectId: group.projectId,
      userId: group.userId,
      operation: group.operation,
      canonicalLedgerEntryId: canonical.id,
      duplicateLedgerEntryIds: duplicates.map((entry) => entry.id),
      amountCreditsEach: Math.abs(canonical.amountCredits)
    });
  }
  return candidates;
}

async function findAmbiguousEditCandidates(projectId: string | undefined) {
  const operations = await prisma.bookEditOperation.findMany({
    where: {
      ledgerEntryId: { not: null },
      request: { not: "" },
      ...(projectId ? { projectId } : {})
    },
    orderBy: { createdAt: "asc" },
    take: 5000,
    select: {
      id: true,
      projectId: true,
      kind: true,
      request: true,
      requestId: true,
      generationJobId: true,
      ledgerEntryId: true,
      createdAt: true
    }
  });
  const bySemanticInput = new Map<string, typeof operations>();
  for (const operation of operations) {
    const key = `${operation.projectId}\u0000${operation.kind}\u0000${operation.request.trim()}`;
    bySemanticInput.set(key, [...(bySemanticInput.get(key) ?? []), operation]);
  }
  return [...bySemanticInput.values()]
    .filter((rows) => {
      if (rows.length < 2) return false;
      const first = rows[0];
      const last = rows.at(-1);
      return Boolean(first && last && last.createdAt.getTime() - first.createdAt.getTime() <= 5 * 60_000);
    })
    .map((rows) => ({
      projectId: rows[0]?.projectId ?? null,
      kind: rows[0]?.kind ?? null,
      operationIds: rows.map((row) => row.id),
      requestIds: rows.map((row) => row.requestId),
      generationJobIds: rows.map((row) => row.generationJobId),
      ledgerEntryIds: rows.map((row) => row.ledgerEntryId),
      reason: "Similar paid edit commands occurred within five minutes; review manually."
    }));
}

function parseArgs(argv: string[]): AuditArgs {
  let apply = false;
  let projectId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--project") {
      projectId = argv[index + 1];
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: pnpm billing:audit-duplicates [--project PROJECT_ID] [--apply]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { apply, projectId };
}
