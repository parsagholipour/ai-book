import { inputFromProject, inputFromSnapshot, type ProjectInputSource } from "../generation/projectInput.js";
import { jsonRecord } from "@book-maker/core";
import { prisma, Prisma } from "@book-maker/db";

let afterId = "";
/** One-time upgrade of legacy snapshots. New snapshots already carry frozen refs. */
export async function backfillLegacyPlanSources() {
  const plans = await prisma.$queryRaw<Array<{ id: string; projectId: string; inputSnapshot: Prisma.JsonValue; mediaSettings: Prisma.JsonValue; userId: string; project: ProjectInputSource }>>`
    SELECT v."id", v."projectId", v."inputSnapshot", p."mediaSettings", p."userId", to_jsonb(p) AS project
    FROM "PlanVersion" v JOIN "Project" p ON p."id" = v."projectId"
    WHERE v."id" > ${afterId}
      AND COALESCE(v."inputSnapshot"->'mediaSettings', p."mediaSettings")->'mobile'->'sourceRefs' IS NULL
      AND jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(v."inputSnapshot"->'mediaSettings', p."mediaSettings")->'mobile'->'attachments') = 'array'
        THEN COALESCE(v."inputSnapshot"->'mediaSettings', p."mediaSettings")->'mobile'->'attachments' ELSE '[]'::jsonb END) > 0
      AND EXISTS (SELECT 1 FROM "SourceDocument" s WHERE s."userId" = p."userId")
    ORDER BY v."id" LIMIT 10`;
  // An unrecoverable early plan must not starve later eligible plans. Wrap
  // around on the next sweep so pending sources are reconsidered as they finish.
  afterId = plans.at(-1)?.id ?? "";
  for (const plan of plans) {
    const snapshot = inputFromSnapshot(plan.inputSnapshot) ?? inputFromProject(plan.project);
    const mediaSettings = jsonRecord(snapshot.mediaSettings ?? plan.mediaSettings);
    const mobile = jsonRecord(mediaSettings.mobile);
    const attachments = Array.isArray(mobile.attachments) ? mobile.attachments.map(jsonRecord) : [];
    const messages = Array.isArray(mobile.messages) ? mobile.messages.map(jsonRecord) : [];
    const submitted = new Set(messages.flatMap((message) => Array.isArray(message.attachments) ? message.attachments.map((ref) => jsonRecord(ref).id) : []));
    const ids = attachments.filter((attachment) => !messages.length || submitted.has(attachment.id)).map((attachment) => attachment.id).filter((id): id is string => typeof id === "string");
    const sources = await prisma.sourceDocument.findMany({ where: { userId: plan.userId, id: { in: ids } }, include: { extractions: { where: { version: 1, status: { in: ["ready", "partial", "limited"] } }, select: { version: true } } } });
    // Do not stamp an incomplete set while original processing is pending.
    if (sources.length !== ids.length || sources.some((source) => !source.extractions.length)) continue;
    const refs = sources.map((source) => ({ sourceId: source.id, version: 1 }));
    await prisma.$transaction(async (tx) => {
      if (refs.length) await tx.projectSource.createMany({ data: refs.map((ref) => ({ projectId: plan.projectId, ...ref })), skipDuplicates: true });
      // The CAS refuses any concurrent plan edit instead of overwriting it.
      await tx.planVersion.updateMany({ where: { id: plan.id, inputSnapshot: { equals: plan.inputSnapshot ?? Prisma.AnyNull } }, data: {
        inputSnapshot: { ...snapshot, mediaSettings: { ...mediaSettings, mobile: { ...mobile, sourceRefs: refs } } } as Prisma.InputJsonValue
      } });
    });
  }
}
