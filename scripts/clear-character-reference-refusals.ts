import { Prisma, prisma } from "../packages/db/src/index.ts";

/**
 * Take back a recorded character reference refusal.
 *
 * `PlanVersion.characterReferenceRefusals` is written when an image provider
 * reads a character's prompt and declines to draw it, and it is deliberately
 * permanent: `characterReferenceSetIsSettled` counts a refusal as an answer, so
 * nothing re-renders that cast for the life of the plan version. That is the
 * cost control — without it every illustrated page's image job and the cover
 * job would take the advisory lock and redraw the whole cast, the refusal paid
 * for once per page.
 *
 * What it has no answer for is a refusal that was wrong. The classifier
 * (`isImageContentRefusalError`) is a reading of a provider's words, several of
 * its false positives have been found and fixed, and the docblock's claim that
 * "a later pass that draws everyone clears the column" cannot fire on its own —
 * a refusal is exactly what stops a later pass from running. So the only
 * recovery was a replan: a new plan version, a new NULL column, and a whole
 * book's worth of work to get one character's likeness back.
 *
 * This is that recovery without the replan. It is deliberately the smallest
 * thing that works, and it is only half a fix by itself: clearing the column
 * makes the set unsettled, and the *next* image or cover job for that plan is
 * what re-renders the cast. For a book still generating that is the next page.
 * For a finished book the operator (or the reader) has to ask for a picture
 * afterwards — regenerating one page's illustration is enough, since every
 * `generate-image` job calls `ensureCharacterReferenceAssets` first.
 *
 * Dry run by default, like every other ops script here.
 *
 *   pnpm exec tsx scripts/clear-character-reference-refusals.ts \
 *     [--project <id>] [--plan <id>] [--character <name>]... [--apply]
 */

type Args = {
  apply: boolean;
  projectId?: string | undefined;
  planId?: string | undefined;
  characters: string[];
};

type Refusal = { name: string; reason: string };

type Candidate = {
  projectId: string;
  projectTitle: string;
  planId: string;
  planVersion: number;
  isCurrentPlan: boolean;
  /** A live render lease means a pass is drawing this cast right now. */
  renderInProgress: boolean;
  refused: Refusal[];
  /** What the column would hold afterwards — empty means it is cleared. */
  keeping: Refusal[];
};

const args = parseArgs(process.argv.slice(2));

try {
  const result = await clearCharacterReferenceRefusals(args);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await prisma.$disconnect();
}

async function clearCharacterReferenceRefusals(options: Args) {
  const candidates = await findCandidates(options);
  const result = {
    mode: options.apply ? "applied" : "dry-run",
    // Said in the output rather than only in the docblock above: an operator
    // who runs this on a finished book and sees nothing change has not hit a
    // bug.
    note: "Clearing the column only unsettles the set. The next generate-image or generate-cover job for that plan is what redraws the cast.",
    candidateCount: candidates.length,
    candidates,
    clearedPlanIds: [] as string[],
    skippedPlanIds: [] as string[]
  };

  if (!options.apply || candidates.length === 0) {
    return result;
  }

  for (const candidate of candidates) {
    // A pass holding a live lease is about to write its own answer for this
    // whole cast, so clearing under it changes nothing and reads like it did.
    if (candidate.renderInProgress) {
      result.skippedPlanIds.push(candidate.planId);
      continue;
    }
    const updated = await prisma.planVersion.updateMany({
      where: { id: candidate.planId },
      data: {
        characterReferenceRefusals:
          candidate.keeping.length > 0 ? candidate.keeping.map((refusal) => ({ ...refusal })) : Prisma.DbNull
      }
    });
    if (updated.count > 0) {
      result.clearedPlanIds.push(candidate.planId);
    } else {
      result.skippedPlanIds.push(candidate.planId);
    }
  }

  return result;
}

async function findCandidates(options: Args): Promise<Candidate[]> {
  const planVersions = await prisma.planVersion.findMany({
    where: {
      characterReferenceRefusals: { not: Prisma.DbNull },
      ...(options.planId ? { id: options.planId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {})
    },
    select: {
      id: true,
      version: true,
      projectId: true,
      characterReferenceRefusals: true,
      characterReferenceLeaseExpiresAt: true,
      project: { select: { title: true, currentPlanId: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  const wanted = new Set(options.characters.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const now = Date.now();
  const candidates: Candidate[] = [];
  for (const planVersion of planVersions) {
    const refused = parseRefusals(planVersion.characterReferenceRefusals);
    if (refused.length === 0) {
      continue;
    }
    // Named characters clear one likeness; with none named the whole column
    // goes, which is what a provider-side or classifier-side fix wants.
    const keeping = wanted.size > 0 ? refused.filter((refusal) => !wanted.has(refusal.name.trim().toLowerCase())) : [];
    if (keeping.length === refused.length) {
      continue;
    }
    candidates.push({
      projectId: planVersion.projectId,
      projectTitle: planVersion.project.title,
      planId: planVersion.id,
      planVersion: planVersion.version,
      isCurrentPlan: planVersion.project.currentPlanId === planVersion.id,
      renderInProgress: (planVersion.characterReferenceLeaseExpiresAt?.getTime() ?? 0) > now,
      refused,
      keeping
    });
  }
  return candidates;
}

/**
 * The same reading `parseCharacterReferenceRefusals` makes in the worker,
 * restated because that module reaches the worker's config and providers. It
 * only has to be as forgiving as the writer, which stores `{ name, reason }`.
 */
function parseRefusals(value: unknown): Refusal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      return [];
    }
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : "refused";
    return [{ name, reason }];
  });
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  let projectId: string | undefined;
  let planId: string | undefined;
  const characters: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--project") {
      projectId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--plan") {
      planId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--character") {
      const name = argv[index + 1];
      if (name) {
        characters.push(name);
      }
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { apply, projectId, planId, characters };
}

function printUsageAndExit(code: number): never {
  console.log(
    "Usage: pnpm exec tsx scripts/clear-character-reference-refusals.ts " +
      "[--project <project-id>] [--plan <plan-version-id>] [--character <name>]... [--apply]"
  );
  process.exit(code);
}
