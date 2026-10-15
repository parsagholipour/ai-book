import { isAuthorManuscript, QUICK_AUTHOR_ASSIST_KINDS, AUTHOR_ASSIST_LIMITS } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { objectKey, objectStore } from "@book-maker/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeCreationMessageIds } from "./creationChatTree.js";
import { mobileCreationDraftPayloadSchema, type MobileCreationMessage } from "./mobileCreationSchemas.js";
import { characterFileContentType, readLibraryCharacterFile } from "./mobile/characterStorage.js";
import { hitAuthenticatedLimit, requireMobileAuth, sendMobileError, sendProjectNotFound } from "./mobile/httpErrors.js";
import { mobileAuthError, toOpenApiRequestBody } from "./mobile/schemas.js";
import {
  cleanText,
  jsonInput,
  moderationReportBodySchema,
  moderationReportSelect,
  serializeModerationReport,
  stringFromRecord,
  toReportReason,
  type ModerationReportRecord
} from "./moderationReports.js";
import type { InMemoryRateLimiter } from "./rateLimit.js";
import { requireOperatorActor } from "./requestAuth.js";

/**
 * Reports on AI output that is not a book, a book picture, a voice call or a
 * book-chat reply — those live in `mobileSafety.ts`. Google Play's AI-generated
 * content policy wants every surface that shows AI output reportable in the
 * app, and four were not: a reply in the creation chat (there is no book yet,
 * so the book's own report could not reach it), the plan card, a drawn picture
 * of a saved character, and a Writing Studio suggestion.
 *
 * Each route follows the book-chat reply route: the signed-in owner only (a
 * row someone else owns is a 404, never a 403), the shared report limiter, one
 * `ModerationReport` row, and a snapshot of exactly what the reader was shown,
 * because a chat branches, a plan is revised, a picture is deleted and a
 * suggestion is discarded long before anyone reviews the report. A target the
 * reader made themselves — an uploaded picture — is refused: reporting exists
 * for what a model produced.
 */

const REPLY_MAX = 4000;
const ASKED_MAX = 2000;
const SUGGESTION_MAX = 12_000;
const PLAN_CHAPTER_LIMIT = 80;
const PLAN_SUMMARY_MAX = 600;
const NOTES_LIMIT = 60;

/** The rows a Studio card can show; the two internal publish passes are never shown, so never reported. */
const REPORTABLE_ASSIST_KINDS = ["ILLUSTRATE", "DRAFT_CHAPTER", "CHAPTER_FEEDBACK", "CONSISTENCY", "OUTLINE"];

const creationMessageParamsSchema = z.object({ id: z.string().min(1), messageId: z.string().min(1) });
const planParamsSchema = z.object({ id: z.string().min(1), planId: z.string().min(1) });
const characterImageParamsSchema = z.object({ id: z.string().min(1), imageId: z.string().min(1) });
const assistParamsSchema = z.object({ id: z.string().min(1), aid: z.string().min(1) });
const reportParamsSchema = z.object({ id: z.string().min(1) });

/**
 * A quick assist's result is never stored — the sheet shows it and the author
 * keeps or drops it — so the app sends what it showed. The snapshot says so
 * (`origin: "app"`), and the report is only ever about the reporter's own book.
 */
export const studioQuickSuggestionReportBodySchema = moderationReportBodySchema
  .extend({
    assistKind: z.enum(QUICK_AUTHOR_ASSIST_KINDS),
    chapterId: z.string().trim().min(1).max(64).optional(),
    selection: z.string().max(AUTHOR_ASSIST_LIMITS.selectionChars).optional(),
    instruction: z.string().max(AUTHOR_ASSIST_LIMITS.instructionChars).optional(),
    suggestion: z.string().trim().min(1).max(SUGGESTION_MAX)
  })
  .strict();

const reportOpenApiBody = toOpenApiRequestBody(moderationReportBodySchema);
const quickSuggestionOpenApiBody = toOpenApiRequestBody(studioQuickSuggestionReportBodySchema);
/** `{ report }` passes through unserialized (`201: {}`), as the other create routes declare it. */
const reportResponses = { 201: {}, 400: mobileAuthError, 401: mobileAuthError, 404: mobileAuthError, 429: mobileAuthError } as const;

export function registerAiOutputReportRoutes(fastify: FastifyInstance, options: { reportLimiter: InMemoryRateLimiter }): void {
  const { reportLimiter } = options;

  fastify.post(
    "/api/mobile/creation-sessions/:id/messages/:messageId/reports",
    { attachValidation: true, schema: { tags: ["mobile"], body: reportOpenApiBody, response: reportResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(reportLimiter, reply, auth.user.id, "report-creation-message")) return;
      const params = creationMessageParamsSchema.safeParse(request.params);
      const parsed = moderationReportBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a report reason.");
      }
      const draft = await prisma.mobileCreationDraft.findFirst({
        where: { id: params.data.id, userId: auth.user.id },
        select: { id: true, payload: true, createdProjectId: true }
      });
      const payload = draft ? mobileCreationDraftPayloadSchema.safeParse(draft.payload) : null;
      const messages = payload?.success ? normalizeCreationMessageIds(payload.data.messages ?? []) : [];
      const message = messages.find((candidate) => candidate.id === params.data.messageId && candidate.role === "assistant");
      if (!draft || !payload?.success || !message) {
        return sendMobileError(reply, 404, "CHAT_MESSAGE_NOT_FOUND", "That reply could not be found.");
      }
      const asked = message.parentId ? messages.find((candidate) => candidate.id === message.parentId) : undefined;
      const question = message.turnUi?.question ?? null;
      const report = await createReport({
        reporterUserId: auth.user.id,
        targetType: "CREATION_CHAT_MESSAGE",
        body: parsed.data,
        targetSnapshot: {
          draftId: draft.id,
          chatTitle: creationChatTitle(payload.data, messages),
          createdProjectId: draft.createdProjectId,
          chatMessageId: message.id,
          reply: message.content.slice(0, REPLY_MAX),
          asked: asked?.content.slice(0, ASKED_MAX) ?? null,
          question: question ? { prompt: question.prompt, options: question.options } : null,
          quickReplies: message.turnUi?.quickReplies ?? [],
          researchSources: (message.research?.sources ?? []).map((source) => ({
            title: source.title,
            url: source.url ?? null
          }))
        }
      });
      return reply.code(201).send({ report: serializeModerationReport(report) });
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/plans/:planId/reports",
    {
      attachValidation: true,
      schema: { tags: ["mobile"], body: reportOpenApiBody, response: { ...reportResponses, 422: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(reportLimiter, reply, auth.user.id, "report-plan")) return;
      const params = planParamsSchema.safeParse(request.params);
      const parsed = moderationReportBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a report reason.");
      }
      const plan = await prisma.planVersion.findFirst({
        where: { id: params.data.planId, projectId: params.data.id, project: { userId: auth.user.id } },
        select: {
          id: true,
          projectId: true,
          version: true,
          status: true,
          planningPackage: true,
          project: { select: { title: true, mediaSettings: true } }
        }
      });
      if (!plan) {
        return sendMobileError(reply, 404, "PLAN_NOT_FOUND", "That plan could not be found.");
      }
      // An author's book has a plan only because publishing derived one from
      // their own chapters: there is nothing a model wrote in it.
      if (isAuthorManuscript(plan.project.mediaSettings)) {
        return sendMobileError(reply, 422, "NOT_AI_GENERATED", "This plan comes from your own writing, so there is nothing AI-made to report.");
      }
      const report = await createReport({
        reporterUserId: auth.user.id,
        projectId: plan.projectId,
        targetType: "BOOK_PLAN",
        body: parsed.data,
        targetSnapshot: {
          projectId: plan.projectId,
          projectTitle: plan.project.title,
          planId: plan.id,
          version: plan.version,
          status: plan.status.toLowerCase(),
          ...planSnapshot(plan.planningPackage)
        }
      });
      return reply.code(201).send({ report: serializeModerationReport(report) });
    }
  );

  fastify.post(
    "/api/mobile/characters/:id/images/:imageId/reports",
    {
      attachValidation: true,
      schema: { tags: ["mobile"], body: reportOpenApiBody, response: { ...reportResponses, 422: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(reportLimiter, reply, auth.user.id, "report-character-image")) return;
      const params = characterImageParamsSchema.safeParse(request.params);
      const parsed = moderationReportBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a report reason.");
      }
      const image = await prisma.libraryCharacterImage.findFirst({
        where: {
          id: params.data.imageId,
          characterId: params.data.id,
          userId: auth.user.id,
          character: { userId: auth.user.id }
        },
        select: {
          id: true,
          source: true,
          fileName: true,
          metadata: true,
          createdAt: true,
          character: { select: { id: true, name: true, description: true, appearance: true } }
        }
      });
      if (!image) {
        return sendMobileError(reply, 404, "CHARACTER_IMAGE_NOT_FOUND", "That picture is no longer there.");
      }
      // An upload — a photo, or the reader's own drawing adopted as it stands —
      // is theirs, not something a model drew.
      if (image.source !== "GENERATED") {
        return sendMobileError(reply, 422, "NOT_AI_GENERATED", "This is a picture you added, so there is nothing AI-made to report.");
      }
      const rewrite = jsonRecord(jsonRecord(image.metadata).copyrightRewrite);
      const report = await createReport({
        reporterUserId: auth.user.id,
        targetType: "CHARACTER_IMAGE",
        body: parsed.data,
        targetSnapshot: {
          characterId: image.character.id,
          characterName: image.character.name,
          description: image.character.description.slice(0, ASKED_MAX),
          appearance: image.character.appearance?.slice(0, ASKED_MAX) ?? null,
          imageId: image.id,
          // The picture's bytes live under the owner's own prefix; the operator
          // picture route reads them from here, never from a client value.
          ownerUserId: auth.user.id,
          fileName: image.fileName,
          contentType: characterFileContentType(image.fileName),
          source: "generated",
          drawnAt: image.createdAt.toISOString(),
          rewrittenPrompt: typeof rewrite.prompt === "string" ? rewrite.prompt.slice(0, ASKED_MAX) : null
        }
      });
      return reply.code(201).send({ report: serializeModerationReport(report) });
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/assists/:aid/reports",
    {
      attachValidation: true,
      schema: { tags: ["mobile"], body: reportOpenApiBody, response: { ...reportResponses, 409: mobileAuthError } }
    },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(reportLimiter, reply, auth.user.id, "report-studio-suggestion")) return;
      const params = assistParamsSchema.safeParse(request.params);
      const parsed = moderationReportBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        return sendMobileError(reply, 400, "VALIDATION_ERROR", "Choose a report reason.");
      }
      const assist = await prisma.manuscriptAssist.findFirst({
        where: {
          id: params.data.aid,
          projectId: params.data.id,
          kind: { in: REPORTABLE_ASSIST_KINDS },
          project: { userId: auth.user.id }
        },
        select: {
          id: true,
          projectId: true,
          kind: true,
          status: true,
          chapterId: true,
          input: true,
          result: true,
          createdAt: true,
          project: { select: { title: true } }
        }
      });
      if (!assist) {
        return sendMobileError(reply, 404, "ASSIST_NOT_FOUND", "That suggestion is no longer there.");
      }
      const suggestion = storedSuggestionSnapshot(assist.result);
      if (!suggestion) {
        return sendMobileError(reply, 409, "ASSIST_NOT_READY", "That suggestion has nothing to show yet.");
      }
      const input = jsonRecord(assist.input);
      const report = await createReport({
        reporterUserId: auth.user.id,
        projectId: assist.projectId,
        targetType: "STUDIO_SUGGESTION",
        body: parsed.data,
        targetSnapshot: {
          origin: "stored",
          projectId: assist.projectId,
          projectTitle: assist.project.title,
          assistId: assist.id,
          assistKind: assist.kind.toLowerCase(),
          status: assist.status.toLowerCase(),
          chapterId: assist.chapterId,
          request: compactRecord({
            prompt: clip(input.prompt, ASKED_MAX),
            notes: clip(input.notes, ASKED_MAX),
            passage: clip(input.passage, ASKED_MAX)
          }),
          suggestion,
          // A picture report names its file at the top level too: the Studio
          // picture sweep keeps any file a report names, as evidence.
          ...(suggestion.type === "image" ? { filename: suggestion.filename } : {})
        }
      });
      return reply.code(201).send({ report: serializeModerationReport(report) });
    }
  );

  fastify.post(
    "/api/mobile/projects/:id/manuscript/assist/reports",
    { attachValidation: true, schema: { tags: ["mobile"], body: quickSuggestionOpenApiBody, response: reportResponses } },
    async (request, reply) => {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) return;
      if (!hitAuthenticatedLimit(reportLimiter, reply, auth.user.id, "report-studio-suggestion")) return;
      const params = reportParamsSchema.safeParse(request.params);
      const parsed = studioQuickSuggestionReportBodySchema.safeParse(request.body);
      if (!params.success || !parsed.success) {
        const reasonOnly = moderationReportBodySchema.shape.reason.safeParse((request.body as { reason?: unknown } | null)?.reason);
        return sendMobileError(
          reply,
          400,
          "VALIDATION_ERROR",
          reasonOnly.success ? "That report could not be read." : "Choose a report reason."
        );
      }
      const project = await prisma.project.findFirst({
        where: { id: params.data.id, userId: auth.user.id },
        select: { id: true, title: true }
      });
      if (!project) {
        return sendProjectNotFound(reply);
      }
      const body = parsed.data;
      const report = await createReport({
        reporterUserId: auth.user.id,
        projectId: project.id,
        targetType: "STUDIO_SUGGESTION",
        body: { reason: body.reason, ...(body.comment !== undefined ? { comment: body.comment } : {}) },
        targetSnapshot: {
          origin: "app",
          projectId: project.id,
          projectTitle: project.title,
          assistId: null,
          assistKind: body.assistKind,
          status: null,
          chapterId: body.chapterId ?? null,
          request: compactRecord({
            instruction: clip(body.instruction, ASKED_MAX),
            selection: clip(body.selection, ASKED_MAX)
          }),
          suggestion: { type: "text", text: body.suggestion }
        }
      });
      return reply.code(201).send({ report: serializeModerationReport(report) });
    }
  );

  /**
   * The picture a report is about, for the operator queue. A saved character's
   * pictures sit under their owner's private prefix and a Studio picture under
   * its book's, and neither has an operator route of its own; this reads the
   * key the report's own snapshot names, so it can serve nothing a report does
   * not point at.
   */
  fastify.get("/api/admin/moderation/reports/:id/picture", async (request, reply) => {
    const operator = await requireOperatorActor(request, reply);
    if (!operator) return;
    const { id } = reportParamsSchema.parse(request.params);
    const report = await prisma.moderationReport.findUnique({
      where: { id },
      select: { targetType: true, projectId: true, targetSnapshot: true }
    });
    const picture = report ? await reportedPicture(report) : null;
    if (!picture) {
      return sendMobileError(reply, 404, "PICTURE_NOT_FOUND", "That picture is no longer stored.");
    }
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Type", picture.contentType);
    return reply.send(picture.bytes);
  });
}

async function createReport(options: {
  reporterUserId: string;
  projectId?: string;
  targetType: "CREATION_CHAT_MESSAGE" | "BOOK_PLAN" | "CHARACTER_IMAGE" | "STUDIO_SUGGESTION";
  body: z.infer<typeof moderationReportBodySchema>;
  targetSnapshot: Record<string, unknown>;
}): Promise<ModerationReportRecord> {
  return (await prisma.moderationReport.create({
    data: {
      reporterUserId: options.reporterUserId,
      projectId: options.projectId ?? null,
      targetType: options.targetType,
      reason: toReportReason(options.body.reason),
      comment: cleanText(options.body.comment) ?? null,
      targetSnapshot: jsonInput(options.targetSnapshot)
    },
    select: moderationReportSelect
  })) as ModerationReportRecord;
}

async function reportedPicture(report: {
  targetType: string;
  projectId: string | null;
  targetSnapshot: unknown;
}): Promise<{ bytes: Buffer; contentType: string } | null> {
  const ownerUserId = stringFromRecord(report.targetSnapshot, "ownerUserId");
  const fileName = stringFromRecord(report.targetSnapshot, "fileName");
  if (report.targetType === "CHARACTER_IMAGE" && ownerUserId && fileName) {
    const bytes = await readLibraryCharacterFile("", ownerUserId, fileName);
    return bytes ? { bytes, contentType: characterFileContentType(fileName) } : null;
  }
  const filename = stringFromRecord(report.targetSnapshot, "filename");
  if (report.targetType === "STUDIO_SUGGESTION" && report.projectId && filename && isPlainFilename(filename)) {
    const bytes = await objectStore().get(objectKey("images", report.projectId, filename));
    return bytes ? { bytes, contentType: characterFileContentType(filename) } : null;
  }
  return null;
}

/** The chat's label as the drawer shows it: a stated title, else the reader's first words. */
function creationChatTitle(
  payload: z.infer<typeof mobileCreationDraftPayloadSchema>,
  messages: MobileCreationMessage[]
): string {
  const stated = payload.optionalDetails?.title?.trim() || payload.brief?.topic?.trim();
  if (stated) return stated.slice(0, 160);
  const firstUser = messages.find((message) => message.role === "user")?.content.trim();
  return firstUser ? firstUser.slice(0, 160) : "New book";
}

/** The plan as its card showed it, read field by field so nothing internal rides along. */
function planSnapshot(planningPackage: unknown): Record<string, unknown> {
  const plan = jsonRecord(planningPackage);
  const chapters = Array.isArray(plan.chapters) ? plan.chapters : [];
  const questions = Array.isArray(plan.questions) ? plan.questions : [];
  return {
    title: clip(plan.title, 300) ?? null,
    subtitle: clip(plan.subtitle, 300) ?? null,
    premise: clip(plan.premise, ASKED_MAX) ?? null,
    audience: clip(plan.audience, 600) ?? null,
    chapters: chapters.slice(0, PLAN_CHAPTER_LIMIT).map((entry) => {
      const chapter = jsonRecord(entry);
      return {
        index: typeof chapter.index === "number" ? chapter.index : null,
        title: clip(chapter.title, 300) ?? "",
        summary: clip(chapter.summary, PLAN_SUMMARY_MAX) ?? ""
      };
    }),
    questions: questions.slice(0, 12).map((entry) => {
      const question = jsonRecord(entry);
      return {
        prompt: clip(question.prompt, 300) ?? "",
        options: Array.isArray(question.options)
          ? question.options.filter((option): option is string => typeof option === "string").slice(0, 8)
          : []
      };
    })
  };
}

/**
 * A stored assist's result, field by field: an illustration's row also keeps
 * a provenance record naming providers, and none of that belongs in a report.
 */
function storedSuggestionSnapshot(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  const result = jsonRecord(raw);
  switch (result.type) {
    case "image": {
      const url = typeof result.url === "string" ? result.url : "";
      const filename = decodeURIComponent(url.split("/").pop() ?? "");
      return url && isPlainFilename(filename)
        ? { type: "image", url, filename, alt: clip(result.alt, ASKED_MAX) ?? "" }
        : null;
    }
    case "draft":
      return { type: "text", text: clip(result.markdown, SUGGESTION_MAX) ?? "" };
    case "notes": {
      const notes = Array.isArray(result.notes) ? result.notes : [];
      return {
        type: "notes",
        notes: notes.slice(0, NOTES_LIMIT).map((entry) => {
          const note = jsonRecord(entry);
          return { quote: clip(note.quote, 600) ?? null, note: clip(note.note, ASKED_MAX) ?? "" };
        })
      };
    }
    case "outline": {
      const chapters = Array.isArray(result.chapters) ? result.chapters : [];
      return {
        type: "outline",
        chapters: chapters.slice(0, PLAN_CHAPTER_LIMIT).map((entry) => {
          const chapter = jsonRecord(entry);
          return { title: clip(chapter.title, 300) ?? "", notes: clip(chapter.notes, PLAN_SUMMARY_MAX) ?? "" };
        })
      };
    }
    default:
      return null;
  }
}

function isPlainFilename(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,200}$/.test(value) && !value.startsWith(".");
}

function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function compactRecord(record: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
