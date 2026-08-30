import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  CONTINUATION_PUBLICATION_PROTOCOL_FIELD,
  jobNames,
  type GenerationJobType,
  type WorkerJobName
} from "@book-maker/core";
import type { Job } from "bullmq";
import { z } from "zod";

/**
 * The worker's one trust boundary for BullMQ data.
 *
 * Durable payloads are JSON assembled by the API, worker fan-out, recovery
 * code, and occasionally older deployments. The schemas deliberately keep
 * unknown keys so a rolling deploy does not erase a legitimate legacy flag,
 * while every identifier a handler needs is validated before lifecycle or
 * provider side effects begin.
 */

const requiredId = (field: string) =>
  z.string({ error: `${field} must be a string` }).trim().min(1, `${field} is required`);

const optionalId = (field: string) => requiredId(field).optional();

const importQuotaSchema = z.object({
  userId: requiredId("importQuota.userId"),
  periodKey: requiredId("importQuota.periodKey")
});

const dispatchedFields = {
  generationJobId: requiredId("generationJobId"),
  attemptId: optionalId("attemptId"),
  billingLedgerEntryId: optionalId("billingLedgerEntryId"),
  /** Optional across the union, required by the name-specific schemas below. */
  projectId: z.undefined().optional(),
  planId: optionalId("planId"),
  pageId: optionalId("pageId"),
  operationId: optionalId("operationId"),
  editOperationId: optionalId("editOperationId"),
  replanOperationId: optionalId("replanOperationId"),
  audiobookId: optionalId("audiobookId"),
  libraryCharacterId: optionalId("libraryCharacterId"),
  contentRevision: z.number().int().nonnegative().optional(),
  importQuota: importQuotaSchema.optional()
} as const;

const projectDispatchedFields = {
  ...dispatchedFields,
  projectId: requiredId("projectId")
} as const;

const exactReplacementSchema = z.object({
  from: z.string(),
  to: z.string(),
  preserveCase: z.boolean().optional()
}).transform(({ from, to, preserveCase }) => ({
  from,
  to,
  ...(preserveCase === undefined ? {} : { preserveCase })
}));

const structuralPageEditSchema = z.object({
  action: z.enum(["insert", "delete", "move"]),
  anchorPageIndex: z.number().int().nullable(),
  pageIndexes: z.array(z.number().int()),
  pageCount: z.number().int().nonnegative()
});

const imageInsertionSchema = z.object({
  subject: z.string().trim().min(1, "imageInsertion.subject is required"),
  placement: z.enum(["end_of_book", "page"]),
  targetPageIndex: z.number().int(),
  replaceMarker: optionalId("imageInsertion.replaceMarker"),
  replaceAssetId: optionalId("imageInsertion.replaceAssetId")
}).transform(({ subject, placement, targetPageIndex, replaceMarker, replaceAssetId }) => ({
  subject,
  placement,
  targetPageIndex,
  ...(replaceMarker === undefined ? {} : { replaceMarker }),
  ...(replaceAssetId === undefined ? {} : { replaceAssetId })
}));

const layoutSourceSchema = z.object({
  pageIndex: z.number().int(),
  replaceMarker: optionalId("imageLayout source replaceMarker"),
  replaceAssetId: optionalId("imageLayout source replaceAssetId")
}).transform(({ pageIndex, replaceMarker, replaceAssetId }) => ({
  pageIndex,
  ...(replaceMarker === undefined ? {} : { replaceMarker }),
  ...(replaceAssetId === undefined ? {} : { replaceAssetId })
}));

const layoutDestSchema = z.object({
  placement: z.enum(["end_of_book", "page"]),
  pageIndex: z.number().int(),
  position: z.enum(["top", "bottom"]).optional()
}).transform(({ placement, pageIndex, position }) => ({
  placement,
  pageIndex,
  ...(position === undefined ? {} : { position })
}));

const imageLayoutSchema = z.object({
  action: z.enum(["move", "remove"]),
  sources: z.array(layoutSourceSchema).optional(),
  /** Pre-bulk legacy shape. */
  source: layoutSourceSchema.optional(),
  dest: layoutDestSchema.optional()
}).transform(({ action, sources, source, dest }) => ({
  action,
  ...(sources === undefined ? {} : { sources }),
  ...(source === undefined ? {} : { source }),
  ...(dest === undefined ? {} : { dest })
}));

const planBookSchema = z.object({
  ...projectDispatchedFields,
  inputSnapshot: z.unknown().optional()
}).passthrough();

const revisePlanSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId"),
  message: z.string().trim().min(1, "message is required"),
  editOperationId: optionalId("editOperationId"),
  editInstruction: z.string().trim().min(1).optional(),
  characterContext: z.string().trim().min(1).optional(),
  respondedQuestionPrompts: z.array(z.string()).optional()
}).passthrough();

const generateBookSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId"),
  replanOperationId: optionalId("replanOperationId"),
  /** Durable source manuscript for a replan copy; absent on legacy jobs. */
  sourceProjectId: optionalId("sourceProjectId"),
  /** Approved standalone replan instruction; recovery fallback when the operation row is legacy-null. */
  editInstruction: z.string().trim().min(1).optional(),
  /** Raw pre-instruction request, retained only for legacy successor recovery. */
  request: z.string().trim().min(1).optional(),
  characterContext: z.string().trim().min(1).optional()
}).passthrough();

const generatePageSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId"),
  pageId: requiredId("pageId")
}).passthrough();

const coverImageSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId"),
  assetType: z.literal("COVER")
}).passthrough();

const pageImageSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId"),
  pageId: requiredId("pageId"),
  prompt: z.string().trim().min(1, "prompt is required"),
  keeperToken: optionalId("keeperToken"),
  assetType: z.undefined().optional()
}).passthrough();

const generateImageSchema = z.discriminatedUnion("assetType", [coverImageSchema, pageImageSchema]);

const compileExportSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId"),
  /** Absent on legacy compile rows; current dispatch always supplies it. */
  contentRevision: z.number().int().nonnegative().optional(),
  operationId: optionalId("operationId"),
  editOperationId: optionalId("editOperationId"),
  replanOperationId: optionalId("replanOperationId")
}).passthrough();

const applyBookEditSchema = z.object({
  ...projectDispatchedFields,
  operationId: requiredId("operationId"),
  request: z.string().trim().min(1, "request is required"),
  editInstruction: z.string().trim().min(1).optional(),
  characterContext: z.string().trim().min(1).optional(),
  affectedPageIndexes: z.array(z.number().int()),
  planId: optionalId("planId"),
  exactReplacement: exactReplacementSchema.optional(),
  mode: z.literal("exact").optional(),
  perPageInstructions: z.array(z.object({
    pageIndex: z.number().int(),
    instruction: z.string().trim().min(1, "per-page instruction is required")
  })).optional(),
  structuralEdit: structuralPageEditSchema.optional(),
  imageInsertion: imageInsertionSchema.optional(),
  imageLayout: imageLayoutSchema.optional(),
  intentKind: z.string().optional()
}).passthrough();

const replanBookSchema = z.object({
  ...projectDispatchedFields,
  operationId: requiredId("operationId"),
  request: z.string().trim().min(1, "request is required"),
  editInstruction: z.string().trim().min(1).optional(),
  characterContext: z.string().trim().min(1).optional(),
  planId: optionalId("planId"),
  sourceProjectId: optionalId("sourceProjectId"),
  sourcePlanId: optionalId("sourcePlanId").nullable(),
  targetLanguage: z.string().nullable().optional(),
  targetPages: z.number().int().positive().nullable().optional()
}).passthrough();

const prepareCharacterCandidatesSchema = z.object({
  ...projectDispatchedFields,
  planId: requiredId("planId")
}).passthrough();

const buildCharacterPersonaSchema = z.object({
  ...projectDispatchedFields,
  voiceCharacterId: requiredId("voiceCharacterId")
}).passthrough();

const importBookSchema = z.object({
  ...projectDispatchedFields,
  importId: requiredId("importId"),
  language: z.string().nullable().optional(),
  importQuota: importQuotaSchema.optional()
}).passthrough();

const continueBookSchema = z.object({
  ...projectDispatchedFields,
  operationId: requiredId("operationId"),
  [CONTINUATION_PUBLICATION_PROTOCOL_FIELD]: z.literal(ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL).optional(),
  request: z.string().trim().min(1, "request is required"),
  editInstruction: z.string().trim().min(1).optional(),
  characterContext: z.string().trim().min(1).optional(),
  planId: optionalId("planId"),
  chapterCount: z.coerce.number().int().positive().optional(),
  newPageCount: z.coerce.number().int().positive().optional()
}).passthrough();

const generateAudiobookSchema = z.object({
  ...projectDispatchedFields,
  audiobookId: requiredId("audiobookId")
}).passthrough();

const generateCharacterPortraitSchema = z.object({
  ...dispatchedFields,
  libraryCharacterId: requiredId("libraryCharacterId"),
  userId: requiredId("userId")
}).passthrough();

/** Exhaustive by construction: a new core job name is a compile error here. */
export const jobPayloadSchemas = {
  [jobNames.PLAN_BOOK]: planBookSchema,
  [jobNames.REVISE_PLAN]: revisePlanSchema,
  [jobNames.GENERATE_BOOK]: generateBookSchema,
  [jobNames.GENERATE_PAGE]: generatePageSchema,
  [jobNames.GENERATE_IMAGE]: generateImageSchema,
  [jobNames.COMPILE_EXPORT]: compileExportSchema,
  [jobNames.APPLY_BOOK_EDIT]: applyBookEditSchema,
  [jobNames.REPLAN_BOOK]: replanBookSchema,
  [jobNames.PREPARE_CHARACTER_CANDIDATES]: prepareCharacterCandidatesSchema,
  [jobNames.BUILD_CHARACTER_PERSONA]: buildCharacterPersonaSchema,
  [jobNames.IMPORT_BOOK]: importBookSchema,
  [jobNames.CONTINUE_BOOK]: continueBookSchema,
  [jobNames.GENERATE_AUDIOBOOK]: generateAudiobookSchema,
  [jobNames.GENERATE_CHARACTER_PORTRAIT]: generateCharacterPortraitSchema
} as const satisfies Record<WorkerJobName, z.ZodType>;

export type WorkerJobPayloadByName = {
  [Name in WorkerJobName]: z.output<(typeof jobPayloadSchemas)[Name]>;
};

export type WorkerJobPayload<Name extends WorkerJobName> = WorkerJobPayloadByName[Name];

/** Name-specific data with a BullMQ-compatible name slot (handy for test doubles). */
export type WorkerJob<Name extends WorkerJobName> = Job<WorkerJobPayload<Name>, void, string>;
export type WorkerRuntimeJob = WorkerJob<WorkerJobName>;

type NamedWorkerJob<Name extends WorkerJobName> = Job<WorkerJobPayload<Name>, void, Name>;

export type AnyWorkerJob = {
  [Name in WorkerJobName]: NamedWorkerJob<Name>;
}[WorkerJobName];

export type PlanBookJob = WorkerJob<typeof jobNames.PLAN_BOOK>;
export type RevisePlanJob = WorkerJob<typeof jobNames.REVISE_PLAN>;
export type GenerateBookJob = WorkerJob<typeof jobNames.GENERATE_BOOK>;
export type GeneratePageJob = WorkerJob<typeof jobNames.GENERATE_PAGE>;
export type GenerateImageJob = WorkerJob<typeof jobNames.GENERATE_IMAGE>;
export type CompileExportJob = WorkerJob<typeof jobNames.COMPILE_EXPORT>;
export type ApplyBookEditJob = WorkerJob<typeof jobNames.APPLY_BOOK_EDIT>;
export type ReplanBookJob = WorkerJob<typeof jobNames.REPLAN_BOOK>;
export type PrepareCharacterCandidatesJob = WorkerJob<typeof jobNames.PREPARE_CHARACTER_CANDIDATES>;
export type BuildCharacterPersonaJob = WorkerJob<typeof jobNames.BUILD_CHARACTER_PERSONA>;
export type ImportBookJob = WorkerJob<typeof jobNames.IMPORT_BOOK>;
export type ContinueBookJob = WorkerJob<typeof jobNames.CONTINUE_BOOK>;
export type GenerateAudiobookJob = WorkerJob<typeof jobNames.GENERATE_AUDIOBOOK>;
export type GenerateCharacterPortraitJob = WorkerJob<typeof jobNames.GENERATE_CHARACTER_PORTRAIT>;

export type RawWorkerJob = Job<unknown, void, string>;

export function workerJobField(job: RawWorkerJob, field: string): unknown {
  return typeof job.data === "object" && job.data !== null ? Reflect.get(job.data, field) : undefined;
}

export function workerJobStringField(job: RawWorkerJob, field: string): string | undefined {
  const value = workerJobField(job, field);
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isWorkerJobName(name: string): name is WorkerJobName {
  return Object.hasOwn(jobPayloadSchemas, name);
}

export function parseWorkerJobData<Name extends WorkerJobName>(
  name: Name,
  data: unknown
): WorkerJobPayload<Name> {
  try {
    return jobPayloadSchemas[name].parse(data) as WorkerJobPayload<Name>;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid payload for worker job "${name}":\n${z.prettifyError(error)}`, { cause: error });
    }
    throw error;
  }
}

/** Parse once, replace data with the normalized value, and retain the BullMQ instance. */
export function parseWorkerJob(job: RawWorkerJob): AnyWorkerJob {
  if (!isWorkerJobName(job.name)) {
    throw new Error(`Unknown worker job: ${job.name}`);
  }
  job.data = parseWorkerJobData(job.name, job.data);
  return job as AnyWorkerJob;
}

type DispatchedPayloadKeys = "projectId" | "generationJobId" | "attemptId";
type KnownPayloadFields<Payload> = {
  [Key in keyof Payload as string extends Key ? never : number extends Key ? never : Key]: Payload[Key];
};
type OmitDispatchedFields<Payload> = Payload extends unknown
  ? Omit<KnownPayloadFields<Payload>, DispatchedPayloadKeys> & Record<string, unknown>
  : never;

/** Payload persisted before dispatch adds its durable/common identifiers. */
export type EnqueuePayloadForType<Type extends GenerationJobType> = OmitDispatchedFields<
  WorkerJobPayload<(typeof jobNames)[Type]>
>;
