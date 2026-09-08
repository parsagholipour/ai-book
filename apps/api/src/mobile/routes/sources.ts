import { z } from "zod";
import { createSourceService, prisma } from "@book-maker/db";
import { mobileCreationDraftPayloadSchema } from "../../mobileCreation.js";
import { hydrateSourceAttachments, retrySourceUpload, SourceUploadError } from "../sourceAttachments.js";
import { serializeCreationAttachment } from "../creationSessions.js";
import { requireMobileAuth, sendMobileError } from "../httpErrors.js";
import type { FastifyInstance } from "fastify";

const sourceParams = z.object({ id: z.string().min(1).max(64), attachmentId: z.string().min(1).max(64) });
const actionBody = z.object({ requestId: z.string().min(1).max(100), version: z.number().int().positive() });
const passageParams = z.object({ sourceId: z.string().min(1).max(64), version: z.coerce.number().int().positive(), ordinal: z.coerce.number().int().min(0) });
export async function registerSourceRoutes(fastify: FastifyInstance) {
  fastify.get("/api/mobile/creation-sessions/:id/attachments", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const draft = await prisma.mobileCreationDraft.findFirst({ where: { id, userId: auth.user.id } });
    if (!draft) return sendMobileError(reply, 404, "SESSION_NOT_FOUND", "This chat was not found.");
    const payload = mobileCreationDraftPayloadSchema.parse(draft.payload);
    const attachments = await hydrateSourceAttachments(auth.user.id, payload.attachments ?? []);
    reply.header("Cache-Control", "no-store");
    return { attachments: attachments.map((attachment) => serializeCreationAttachment(attachment, id)) };
  });
  for (const action of ["retry", "use-readable"] as const) {
    fastify.post(`/api/mobile/creation-sessions/:id/attachments/:attachmentId/${action}`, { schema: { tags: ["mobile"], params: z.toJSONSchema(sourceParams, { target: "draft-7" }), body: z.toJSONSchema(actionBody, { target: "draft-7" }) } }, async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      const { id, attachmentId } = sourceParams.parse(request.params);
      const body = actionBody.parse(request.body);
      const source = await prisma.sourceDocument.findFirst({ where: { id: attachmentId, draftId: id, userId: auth.user.id }, include: { draft: true } });
      if (!source?.draft) return sendMobileError(reply, 404, "SOURCE_NOT_FOUND", "That file was not found.");
      const payload = mobileCreationDraftPayloadSchema.parse(source.draft.payload);
      if (!payload.attachments?.some((attachment) => attachment.id === attachmentId)) return sendMobileError(reply, 404, "SOURCE_NOT_FOUND", "That file was removed.");
      if (action === "retry") {
        try { await retrySourceUpload(auth.user.id, id, attachmentId, body.requestId, body.version); }
        catch (error) { if (error instanceof SourceUploadError) return sendMobileError(reply, error.code === "ATTACHMENT_FILE_EXPIRED" ? 422 : 409, error.code, error.message); throw error; }
      } else {
        if (source.currentVersion !== body.version) return sendMobileError(reply, 409, "SOURCE_CHANGED", "Reading has changed. Reload the file status first.");
        await prisma.sourceExtraction.updateMany({ where: { sourceId: attachmentId, version: body.version, status: { in: ["partial", "limited"] } }, data: { acceptedPartial: true } });
      }
      return { ok: true };
    });
  }
  fastify.get("/api/mobile/sources/:sourceId/versions/:version/passages/:ordinal", async (request, reply) => {
    const auth = await requireMobileAuth(request, reply);
    if (!auth) return;
    const parsed = passageParams.safeParse(request.params);
    if (!parsed.success) return sendMobileError(reply, 400, "VALIDATION_ERROR", "Provide a source ID, extraction version, and passage number.");
    const params = parsed.data;
    const service = createSourceService(auth.user.id, [{ sourceId: params.sourceId, version: params.version }]);
    const passage = await service.read(params.sourceId, params.version, params.ordinal);
    if (!passage) return sendMobileError(reply, 404, "PASSAGE_NOT_FOUND", "This source passage was not found.");
    reply.header("Cache-Control", "private, max-age=300");
    return { passage };
  });
}
