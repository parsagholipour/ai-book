import { jsonPayloadToRecord } from "@book-maker/core";
import { prisma } from "@book-maker/db";

type StagedReplanProofRow = {
  jobId: string;
  jobProjectId: string | null;
  jobType: string;
  jobStatus: string;
  targetProjectId: string;
  targetCurrentPlanId: string | null;
  targetStatus: string;
  operationId: string;
  operationProjectId: string;
  operationSourceProjectId: string | null;
  operationGenerationJobId: string | null;
  operationKind: string;
  operationStatus: string;
  operationClassifier: unknown;
  stagedPlanId: string;
  stagedPlanProjectId: string;
  stagedPlanStatus: string;
  sourceProjectId: string | null;
  sourceCurrentPlanId: string | null;
  sourcePlanId: string | null;
  sourcePlanProjectId: string | null;
  sourcePlanStatus: string | null;
};

/**
 * What the durable rows say about a `generate-book` delivery naming a replan.
 *
 * `exact` is the one staged successor admitted through the plan mismatch.
 * `mismatch` is a staged replan whose durable state has moved on, and it is
 * cancelled and refunded. `unstaged` is not a verdict at all: an operation that
 * carries no staging stamp was queued before staging existed, so this proof has
 * nothing to read and the ordinary plan and revision checks answer instead.
 */
export type StagedReplanProof = "exact" | "unstaged" | "mismatch";

/**
 * Proves the one GENERATE_BOOK target that is intentionally not current yet.
 *
 * The staged successor is assembled across Project, GenerationJob,
 * BookEditOperation and PlanVersion. Reading those rows with separate Prisma
 * calls would let a relink or source-plan change produce a mixed proof, so the
 * pre-claim guard asks one statement for one PostgreSQL snapshot. It takes no
 * locks; the successor's later operation lease and publication transaction
 * remain the authoritative write fences.
 */
export async function stagedReplanSuccessorProof(options: {
  targetProjectId: string;
  generationJobId: string;
  operationId: string;
  stagedPlanId: string;
}): Promise<StagedReplanProof> {
  const rows = await prisma.$queryRawUnsafe<StagedReplanProofRow[]>(
    `SELECT job."id" AS "jobId",
            job."projectId" AS "jobProjectId",
            job."type"::text AS "jobType",
            job."status"::text AS "jobStatus",
            target."id" AS "targetProjectId",
            target."currentPlanId" AS "targetCurrentPlanId",
            target."status"::text AS "targetStatus",
            operation."id" AS "operationId",
            operation."projectId" AS "operationProjectId",
            operation."sourceProjectId" AS "operationSourceProjectId",
            operation."generationJobId" AS "operationGenerationJobId",
            operation."kind"::text AS "operationKind",
            operation."status"::text AS "operationStatus",
            operation."classifier" AS "operationClassifier",
            staged_plan."id" AS "stagedPlanId",
            staged_plan."projectId" AS "stagedPlanProjectId",
            staged_plan."status"::text AS "stagedPlanStatus",
            source."id" AS "sourceProjectId",
            source."currentPlanId" AS "sourceCurrentPlanId",
            source_plan."id" AS "sourcePlanId",
            source_plan."projectId" AS "sourcePlanProjectId",
            source_plan."status"::text AS "sourcePlanStatus"
       FROM "GenerationJob" AS job
       JOIN "Project" AS target
         ON target."id" = job."projectId"
       JOIN "BookEditOperation" AS operation
         ON operation."id" = $3
       JOIN "PlanVersion" AS staged_plan
         ON staged_plan."id" = $4
       LEFT JOIN "Project" AS source
         ON source."id" = operation."sourceProjectId"
       LEFT JOIN "PlanVersion" AS source_plan
         ON source_plan."id" = source."currentPlanId"
      WHERE job."id" = $2
        AND job."projectId" = $1`,
    options.targetProjectId,
    options.generationJobId,
    options.operationId,
    options.stagedPlanId
  );
  const [row] = rows;
  if (rows.length !== 1 || !row) return "mismatch";
  return stagedReplanProofFromRow(row, options);
}

function stagedReplanProofFromRow(
  row: StagedReplanProofRow,
  options: {
    targetProjectId: string;
    generationJobId: string;
    operationId: string;
    stagedPlanId: string;
  }
): StagedReplanProof {
  const classifier = jsonPayloadToRecord(row.operationClassifier);
  const classifierPlanId = nonEmptyId(classifier.replanStagedPlanId);
  // Staging stamps this key before it creates the successor row, so a replan
  // without it is one that published its plan the old way and queued the
  // regeneration against it. Every stamp below is missing for the same reason,
  // and reading their absence as supersession would cancel and refund a paid
  // whole-book replan the moment a deploy landed under one in flight.
  if (!classifierPlanId) {
    return row.operationKind === "BOOK_REPLAN" ? "unstaged" : "mismatch";
  }
  const classifierJobId = nonEmptyId(classifier.replanSuccessorJobId);
  const sourcePlanId = nonEmptyId(classifier.replanSourcePlanId);
  const sourceProjectId = nonEmptyId(row.operationSourceProjectId);
  if (!classifierJobId || !sourcePlanId || !sourceProjectId) return "mismatch";

  if (
    row.jobId !== options.generationJobId ||
    row.jobProjectId !== options.targetProjectId ||
    row.jobType !== "GENERATE_BOOK" ||
    (row.jobStatus !== "QUEUED" && row.jobStatus !== "ACTIVE") ||
    row.targetProjectId !== options.targetProjectId ||
    row.targetStatus !== "EDITING" ||
    row.operationId !== options.operationId ||
    row.operationProjectId !== sourceProjectId ||
    row.operationGenerationJobId !== options.generationJobId ||
    row.operationKind !== "BOOK_REPLAN" ||
    row.operationStatus !== "ACTIVE" ||
    classifierPlanId !== options.stagedPlanId ||
    classifierJobId !== options.generationJobId ||
    row.stagedPlanId !== options.stagedPlanId ||
    row.stagedPlanProjectId !== options.targetProjectId ||
    row.stagedPlanStatus !== "DRAFT" ||
    row.sourceProjectId !== sourceProjectId ||
    row.sourceCurrentPlanId !== sourcePlanId ||
    row.sourcePlanId !== sourcePlanId ||
    row.sourcePlanProjectId !== sourceProjectId ||
    row.sourcePlanStatus !== "APPROVED"
  ) {
    return "mismatch";
  }

  const publishedElsewhere =
    sourceProjectId === options.targetProjectId
      ? row.targetCurrentPlanId !== sourcePlanId
      : row.targetCurrentPlanId !== null;
  return publishedElsewhere ? "mismatch" : "exact";
}

function nonEmptyId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
