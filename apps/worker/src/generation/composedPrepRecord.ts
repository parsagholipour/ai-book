import { createHash } from "node:crypto";
import { isRecord, type CreateProjectInput } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { z } from "zod";

/**
 * The record the speculative composition prep leaves on a plan version
 * (`planningPackage.compositionPrep`), and the one fenced write every prep
 * field goes through. See `composedSpeculativePrep.ts` for the prep and
 * `composedPrepHandoff.ts` for how the book run adopts what it stored.
 */

/** The steps the prep runs, in the order the book run needs their answers. */
export const PREP_STEPS = ["stance", "inventory", "episodes", "forms"] as const;
export type PrepStep = (typeof PREP_STEPS)[number];
/** `skipped` is a decision the book run would make the same way (a planner stance, a novel's episodes); `failed` is one it makes again. */
export type PrepOutcome = "stored" | "skipped" | "failed";

/** The plan fields each step may write. A discard removes exactly these, and only the ones `written` lists. */
export const PREP_STEP_FIELDS: Readonly<Record<PrepStep, readonly string[]>> = Object.freeze({
  stance: ["authorStance"],
  inventory: ["requirementInventory"],
  episodes: ["episodes", "instructionalSetting"],
  forms: ["compositions", "exampleCast", "toolkit"]
});

const prepRecordSchema = z.object({
  version: z.literal(1),
  generationJobId: z.string(),
  fingerprint: z.string(),
  planned: z.array(z.enum(PREP_STEPS)),
  steps: z.record(z.string(), z.enum(["stored", "skipped", "failed"])),
  written: z.array(z.string()),
  adoptedBy: z.string().optional(),
  discardedBy: z.string().optional()
});
export type CompositionPrepRecord = z.infer<typeof prepRecordSchema>;

export function compositionPrepRecord(planningPackage: unknown): CompositionPrepRecord | undefined {
  if (!isRecord(planningPackage)) return undefined;
  const parsed = prepRecordSchema.safeParse(planningPackage.compositionPrep);
  return parsed.success ? parsed.data : undefined;
}

export function stepOutcome(record: CompositionPrepRecord | undefined, step: PrepStep): PrepOutcome | undefined {
  const outcome = record?.steps[step];
  return outcome === "stored" || outcome === "skipped" || outcome === "failed" ? outcome : undefined;
}

export function prepareCompositionDedupeKey(planId: string): string {
  return `prepare-composition:${planId}`;
}

/**
 * What the prep's answers were planned under: the book's input as the run will
 * rebuild it from the plan's snapshot (an approval that switches illustrations
 * off rewrites it), the gate settings, and whether the fake adapters answered.
 * A book run whose own fingerprint differs discards every field the prep wrote.
 */
export function preparationFingerprint(input: CreateProjectInput, qualitySettings: unknown, mockAi: boolean): string {
  return createHash("sha256").update(stableJson({ v: 1, input, qualitySettings: qualitySettings ?? null, mockAi })).digest("hex");
}

/** JSON with every object's keys sorted, so a value read back from JSONB digests like the one that was written. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, sortKeys(value[key])])
  );
}

/** The prep may no longer write: its row was canceled or stopped by the book run or a reader, or its plan was superseded. */
export class PrepFencedError extends Error {
  constructor(message = "The speculative composition prep was fenced off its plan.") {
    super(message);
    this.name = "PrepFencedError";
  }
}

export function isPrepFencedError(error: unknown): error is PrepFencedError {
  return error instanceof PrepFencedError;
}

/**
 * The one way the prep writes its plan: a compare-and-swap on the stored
 * document (`persistPlanField`'s shape), inside a transaction that first holds
 * the prep's own row `FOR SHARE` while it is ACTIVE. The book run's fence is an
 * UPDATE of that row to CANCELED, which waits behind any write in flight and
 * then refuses every later one — so once the fence commits, the plan is final
 * as far as the prep is concerned. A superseded plan version refuses too.
 * `patch` returns the next document, or null when there is nothing to write.
 */
export async function writePreparedPlan(options: {
  planId: string;
  generationJobId: string;
  patch: (planningPackage: Record<string, unknown>) => Record<string, unknown> | null;
}): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await prisma.planVersion.findUnique({ where: { id: options.planId }, select: { planningPackage: true, status: true } });
    if (!row || row.status === "SUPERSEDED" || !isRecord(row.planningPackage)) throw new PrepFencedError("The plan this prep was for is gone or superseded.");
    const next = options.patch(row.planningPackage);
    if (!next) return;
    const written = await prisma.$transaction(async (tx) => {
      const held = await tx.$queryRaw<Array<{ held: number }>>`SELECT 1 AS held FROM "GenerationJob" WHERE "id" = ${options.generationJobId} AND "status" = 'ACTIVE' FOR SHARE`;
      if (held.length !== 1) throw new PrepFencedError();
      const updated = await tx.planVersion.updateMany({
        where: { id: options.planId, status: { not: "SUPERSEDED" }, planningPackage: { equals: row.planningPackage as Prisma.InputJsonValue } },
        data: { planningPackage: next as Prisma.InputJsonValue }
      });
      return updated.count === 1;
    });
    if (written) return;
  }
  throw new Error("The plan changed repeatedly while the composition prep was writing it.");
}

/**
 * A compare-and-swap of the record alone, for the book run: adoption and a
 * discard. Not fenced on the prep's row — the book run is the fence.
 */
export async function patchPlanPackage(planId: string, patch: (planningPackage: Record<string, unknown>) => Record<string, unknown> | null): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await prisma.planVersion.findUnique({ where: { id: planId }, select: { planningPackage: true } });
    if (!row || !isRecord(row.planningPackage)) return undefined;
    const next = patch(row.planningPackage);
    if (!next) return row.planningPackage;
    const updated = await prisma.planVersion.updateMany({
      where: { id: planId, planningPackage: { equals: row.planningPackage as Prisma.InputJsonValue } },
      data: { planningPackage: next as Prisma.InputJsonValue }
    });
    if (updated.count === 1) return next;
  }
  throw new Error("The plan changed repeatedly while its composition prep was being settled.");
}

/** A plan document without the fields a prep record says the prep wrote, and without the record. */
export function withoutPreparedFields(planningPackage: Record<string, unknown>, fields?: readonly string[]): Record<string, unknown> {
  const record = compositionPrepRecord(planningPackage);
  if (!record) return planningPackage;
  const next = { ...planningPackage };
  for (const field of record.written) {
    if (!fields || fields.includes(field)) delete next[field];
  }
  if (!fields) {
    delete next.compositionPrep;
  } else {
    next.compositionPrep = { ...record, written: record.written.filter((field) => !fields.includes(field)) };
  }
  return next;
}
